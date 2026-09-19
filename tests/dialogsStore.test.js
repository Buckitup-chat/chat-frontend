import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { recordAccepted, _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setOwnObservedTailsStorageForTests, _setRawOwnObservedTailsStorageForTests, getOwnObservedTails } from '@/lib/data/ownObservedTails';
import { clearLocalStorageKey } from '@/lib/data/localCrypto';
import { enqueue, recordFailure, quarantinedEntries, discardEntry, _setStorageForTests, startLeaderElection, stopLeaderElection } from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';

// A shape-backed collection: preload() resolves, get() reads the map that the
// ingest mock feeds. Real collections are Electric-driven; the point here is
// that a write only becomes readable once the barrier has let it through.
const makeCollection = (rows = {}) => ({
	rows: new Map(Object.entries(rows)),
	preloadCalls: 0,
	async preload() {
		this.preloadCalls++;
	},
	get(key) {
		return this.rows.get(key);
	},
	get toArray() {
		return [...this.rows.values()];
	},
});

const makeIdentity = (seed) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactSk = new Uint8Array(32).fill(seed || 1);
	const contactPk = secp.getPublicKey(contactSk, true);
	const userHash = 'u_' + bytesToHex(sha3_512(sign.publicKey));
	const card = {
		user_hash: userHash,
		sign_pkey: toBase64(sign.publicKey),
		crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk),
		contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name: `user-${seed}`,
		deleted_flag: false,
		owner_timestamp: 1_700_000_000,
	};
	card.sign_b64 = signFields(card, sign.secretKey);
	return { sign, userHash, card };
};

const myIdentity = makeIdentity(1);
const peerIdentity = makeIdentity(2);

const MY_HASH = myIdentity.userHash;
const PEER_HASH = peerIdentity.userHash;
const DIALOG_HASH = 'di_' + '3'.repeat(128);
const OTHER_ACCOUNT_HASH = 'u_' + 'b'.repeat(128);
const MSG_ID = 'dmsg_' + '4'.repeat(128);

const signedMessageRow = (author, fields) => {
	const sign_b64 = signFields(fields, author.sign.secretKey);
	return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
};

const GENESIS_ROW = signedMessageRow(myIdentity, {
	message_id: MSG_ID, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
	content_b64: 'enc(original)', deleted_flag: false, refs_map_b64: null,
	parent_sign_hash: null, owner_timestamp: 1000,
});
const SIGN_HASH = GENESIS_ROW.sign_hash;

let collections;
let sent;
let sendImpl;

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: MY_HASH }),
}));

vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

const { MockDurabilityError, MockIngestError } = vi.hoisted(() => {
	class MockDurabilityError extends Error {}
	class MockIngestError extends Error {
		constructor(message, opts = {}) {
			super(message);
			this.name = 'IngestError';
			this.permanent = opts.permanent ?? false;
		}
	}
	return { MockDurabilityError, MockIngestError };
});

vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async (mutations, _skey, opts = {}) => {
		// the real transport reports durable enqueue before the network wait
		await opts.onDurable?.('test-outbox-id');
		const result = await sendImpl(mutations);
		return { outboxId: 'test-outbox-id', phase: 'accepted', result, acceptance: Promise.resolve({ kind: 'accepted' }) };
	},
	DurabilityError: MockDurabilityError,
	IngestError: MockIngestError,
	OWNER_FIELD: {
		dialog_keys: 'sender_hash',
		dialog_messages: 'sender_hash',
		dialog_message_reactions: 'reactor_hash',
		dialog_message_receipts: 'peer_hash',
	},
}));

let enqueueIntentCounter = 0;
let intentStore = new Map();
const enqueueIntentSpy = vi.fn(async (intent, userHash, relation) => {
	const id = `test-intent-id-${++enqueueIntentCounter}`;
	intentStore.set(id, { id, userHash, relation, intent });
	return id;
});
const updateIntentSpy = vi.fn(async (id, intent) => {
	const existing = intentStore.get(id);
	if (!existing) return false;
	intentStore.set(id, { ...existing, intent });
	return true;
});
const getIntentSpy = vi.fn(async (id) => intentStore.get(id) ?? null);
vi.mock('@/lib/data/intents', () => ({
	enqueueIntent: (...args) => enqueueIntentSpy(...args),
	updateIntent: (...args) => updateIntentSpy(...args),
	resolveIntent: async () => {},
	getIntent: (...args) => getIntentSpy(...args),
}));

const createGenericMutationSpy = vi.fn((relation, row, _skey, type) => ({
	type,
	relation,
	row,
	changes: relation === 'dialog_messages' ? { ...row, sign_hash: `fake_sign_hash(${JSON.stringify(row)})` } : undefined,
	syncMetadata: { relation },
}));

vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (...args) => createGenericMutationSpy(...args),
	},
}));

vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s) => (s ? new Uint8Array([1, 2, 3]) : null),
}));

const exportVaultKeysSpy = vi.fn(async () => ({
	sign_skey: 'AAAA',
	crypt_skey: btoa(String.fromCharCode(...new Uint8Array(32).fill(ambientUserHash === OTHER_ACCOUNT_HASH ? 2 : 1))),
	evm_skey: 'cc',
}));
let ambientUserHash = null; // set to MY_HASH in the outer beforeEach below
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() { return ambientUserHash; },
			exportVaultKeys: (...args) => exportVaultKeysSpy(...args),
		}),
	},
}));

vi.mock('@/libs/DialogCrypto', () => ({
	DialogCrypto: {
		computeDialogHash: () => DIALOG_HASH,
		deriveSenderMsgKey: () => new Uint8Array(32),
		wrapSenderMsgKey: async () => ({
			peerKemWrapKeyB64: 'wrap',
			peerWrappedMsgKeyB64: 'wrapped',
		}),
		// Deterministic per (message, reactor, emoji) — no revision in it,
		// which is why a reaction "moves" between revisions.
		computeReactionHash: (_k, messageId, reactor, emoji) =>
			`dmr_${messageId}:${reactor}:${emoji}`,
		// Real derivation — its own behaviour is covered in dialogCrypto.test.js;
		// keeping it real here checks the store passes the right operands.
		computeReceiptHash: (messageId, signHash, peerHash, type) =>
			'dmrc_' + bytesToHex(sha3_512(new TextEncoder().encode(
				`${messageId}${signHash}${peerHash}${type}`
			))),
		encryptContent: async (_k, text) => `enc(${text})`,
		decryptContent: async (_k, ciphertext) =>
			typeof ciphertext === 'string' && ciphertext.startsWith('enc(') && ciphertext.endsWith(')')
				? ciphertext.slice(4, -1)
				: null,
	},
}));

const { useDialogsStore } = await import('@/store/dialogs.store');

// sendMutationsAndAwaitShape only resolves once the row is readable through
// the shape, so the fake transport applies it to the collection. Without this
// the mock would model a server that accepts writes and never returns them —
// and every "re-read after the barrier" would be tested against a lie.
const PRIMARY_KEY = {
	dialog_keys: (r) => `${r.dialog_hash}|${r.sender_hash}`,
	dialog_messages: (r) => r.message_id,
	dialog_message_reactions: (r) => r.reaction_hash,
	dialog_message_receipts: (r) => r.receipt_hash,
};

const COLLECTION_FOR = {
	dialog_keys: () => collections.dialog.keys,
	dialog_messages: () => collections.dialog.messages,
	dialog_message_reactions: () => collections.dialog.reactions,
	dialog_message_receipts: () => collections.dialog.receipts,
};

const applyMutation = (m) => {
	const pk = PRIMARY_KEY[m.relation];
	const coll = COLLECTION_FOR[m.relation]?.();
	if (!pk || !coll) return;
	const key = pk(m.row);
	// The server rejects an insert onto an existing primary key. Modelling
	// that is what makes a missing dedup guard show its real consequence —
	// the second write fails and its message never lands.
	if (m.type === 'insert' && coll.rows.has(key)) {
		const err = new Error(`duplicate key on ${m.relation}`);
		err.permanent = true;
		throw err;
	}
	coll.rows.set(key, { ...coll.rows.get(key), ...m.row });
};

// sendMessage awaits a dynamic import() for uuid before it does anything, so
// a fixed number of ticks is not a reliable wait — the first, cold resolve is
// slower than every later one. Poll for the expected state instead.
const flush = async () => {
	for (let i = 0; i < 5; i++) {
		for (let j = 0; j < 20; j++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	}
};

const waitFor = async (predicate, label) => {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await flush();
	}
	throw new Error(`timed out waiting for: ${label}`);
};

beforeEach(() => {
	enqueueIntentSpy.mockClear();
	enqueueIntentCounter = 0;
	intentStore = new Map();
	updateIntentSpy.mockClear();
	getIntentSpy.mockClear();
	exportVaultKeysSpy.mockClear();
	createGenericMutationSpy.mockClear();
	stopLeaderElection(); // no test starts with a leftover "active session" from a previous one
	startLeaderElection(MY_HASH, () => {});
	setActivePinia(createPinia());
	_setAcceptedSnapshotStorageForTests({
		_map: new Map(),
		async get(k) { return this._map.get(k) ?? null; },
		async set(k, v) { this._map.set(k, v); },
		async delete(k) { this._map.delete(k); },
		async keys() { return [...this._map.keys()]; },
		async clear() { this._map.clear(); },
	});
	_setOwnObservedTailsStorageForTests({
		_map: new Map(),
		async get(k) { return this._map.get(k) ?? null; },
		async set(k, v) { this._map.set(k, v); },
		async delete(k) { this._map.delete(k); },
		async keys() { return [...this._map.keys()]; },
		async clear() { this._map.clear(); },
	});
	_setStorageForTests({
		_map: new Map(),
		async get(k) { return this._map.get(k) ?? null; },
		async set(k, v) { this._map.set(k, v); },
		async delete(k) { this._map.delete(k); },
		async keys() { return [...this._map.keys()]; },
		async clear() { this._map.clear(); },
	});
	collections = {
		cards: makeCollection({
			[MY_HASH]: myIdentity.card,
			[PEER_HASH]: peerIdentity.card,
		}),
		dialog: {
			keys: makeCollection(),
			messages: makeCollection(),
			reactions: makeCollection(),
			receipts: makeCollection(),
			versions: makeCollection(),
		},
	};
	sent = [];
	sendImpl = async (mutations) => {
		sent.push(...mutations);
		mutations.forEach(applyMutation);
		return { txids: [] };
	};
});

describe('initDialogKeys deduplication', () => {
	// Two messages typed in quick succession into a fresh dialog both need the
	// key row. Without the guard each call read an empty collection, decided
	// the row was missing, and wrote it — the second insert hits the primary
	// key and the whole send fails.
	it('writes one dialog_keys row when two sends race on a fresh dialog', async () => {
		const store = useDialogsStore();

		await Promise.all([
			store.initDialogKeys(PEER_HASH),
			store.initDialogKeys(PEER_HASH),
		]);

		const keyWrites = sent.filter((m) => m.relation === 'dialog_keys');
		expect(keyWrites).toHaveLength(1);
		expect(keyWrites[0].row.sender_hash).toBe(MY_HASH);
		expect(keyWrites[0].row.dialog_hash).toBe(DIALOG_HASH);
	});

	it('both callers get the dialog hash back, not just the winner', async () => {
		const store = useDialogsStore();

		const [a, b] = await Promise.all([
			store.initDialogKeys(PEER_HASH),
			store.initDialogKeys(PEER_HASH),
		]);

		expect(a).toBe(DIALOG_HASH);
		expect(b).toBe(DIALOG_HASH);
	});

	// The guard must not turn one failure into a permanently poisoned dialog.
	it('releases the guard after a failure so the next attempt retries', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.preload = async () => {
			throw new Error('shape unavailable');
		};

		await expect(store.initDialogKeys(PEER_HASH)).rejects.toThrow('shape unavailable');

		collections.dialog.keys.preload = async () => {};
		await expect(store.initDialogKeys(PEER_HASH)).resolves.toBe(DIALOG_HASH);
		expect(sent.filter((m) => m.relation === 'dialog_keys')).toHaveLength(1);
	});

	// A key row already on the server must never be re-inserted.
	it('does not write when the key row already exists', async () => {
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH,
			sender_hash: MY_HASH,
			peer_hash: PEER_HASH,
			deleted_flag: false,
		});
		const store = useDialogsStore();

		await store.initDialogKeys(PEER_HASH);

		expect(sent.filter((m) => m.relation === 'dialog_keys')).toHaveLength(0);
	});
});

describe('two first messages in a fresh dialog', () => {
	// The scenario the guard exists for, driven through the public send path
	// rather than the guard itself: type two messages before the first has
	// round-tripped. Both sends need the key row, both used to find the
	// collection empty, and the second insert collided on the primary key —
	// so the second message was simply lost.
	it('creates the key row once and sends both messages', async () => {
		const store = useDialogsStore();
		const statuses = [];

		store.sendMessage(PEER_HASH, 'first', (s) => statuses.push(['first', s]));
		store.sendMessage(PEER_HASH, 'second', (s) => statuses.push(['second', s]));
		await waitFor(
			() => statuses.filter(([, s]) => s === 'synced' || s === 'error').length === 2,
			'both sends to settle'
		);

		expect(sent.filter((m) => m.relation === 'dialog_keys')).toHaveLength(1);

		const messages = sent.filter((m) => m.relation === 'dialog_messages');
		expect(messages).toHaveLength(2);
		expect(statuses.filter(([, s]) => s === 'error')).toHaveLength(0);
		expect(statuses.filter(([, s]) => s === 'synced')).toHaveLength(2);
	});

	it('reports an error on both sends when the key row cannot be read', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.preload = async () => {
			throw new Error('shape unavailable');
		};
		const statuses = [];

		store.sendMessage(PEER_HASH, 'first', (s) => statuses.push(s));
		store.sendMessage(PEER_HASH, 'second', (s) => statuses.push(s));
		await waitFor(() => statuses.filter((s) => s === 'error').length === 2, 'both sends to fail');

		expect(sent.filter((m) => m.relation === 'dialog_messages')).toHaveLength(0);
		expect(statuses.filter((s) => s === 'error')).toHaveLength(2);
	});
});

describe('causal scope: signing moment separated from intent creation (§4.4)', () => {
	const decodeRefsMap = (refsMapB64) => JSON.parse(refsMapB64.replace(/^enc\(/, '').replace(/\)$/, ''));

	it('a message sent after an earlier one is signed observes it as a tail', async () => {
		const store = useDialogsStore();
		const statuses = [];

		const firstId = await store.sendMessage(PEER_HASH, 'first', (s) => statuses.push(['first', s]));
		await waitFor(() => statuses.some(([m, s]) => m === 'first' && (s === 'synced' || s === 'error')), 'first to settle');
		expect(statuses).toContainEqual(['first', 'synced']);

		const firstRow = collections.dialog.messages.rows.get(firstId);
		const admittedFirstRow = signedMessageRow(myIdentity, {
			message_id: firstId, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
			content_b64: firstRow.content_b64, deleted_flag: false, refs_map_b64: firstRow.refs_map_b64 ?? null,
			parent_sign_hash: null, owner_timestamp: firstRow.owner_timestamp,
		});
		collections.dialog.messages.rows.set(firstId, admittedFirstRow);
		await store.admitMessageRow(admittedFirstRow);

		const secondId = await store.sendMessage(PEER_HASH, 'second', (s) => statuses.push(['second', s]));
		await waitFor(() => statuses.some(([m, s]) => m === 'second' && (s === 'synced' || s === 'error')), 'second to settle');

		const secondMutation = sent
			.filter((m) => m.relation === 'dialog_messages')
			.find((m) => m.row.message_id === secondId);
		expect(decodeRefsMap(secondMutation.row.refs_map_b64)).toEqual({ [firstId]: admittedFirstRow.sign_hash });
	});

	it('an independent second message does not wait for the first to sign — both observe the same empty tail set, a legitimate fork', async () => {
		const store = useDialogsStore();
		const statuses = [];

		store.sendMessage(PEER_HASH, 'first', (s) => statuses.push(['first', s]));
		store.sendMessage(PEER_HASH, 'second', (s) => statuses.push(['second', s]));
		await waitFor(
			() => statuses.filter(([, s]) => s === 'synced' || s === 'error').length === 2,
			'both sends to settle'
		);

		expect(statuses.filter(([, s]) => s === 'synced')).toHaveLength(2);
		const messages = sent.filter((m) => m.relation === 'dialog_messages');
		expect(messages).toHaveLength(2);
		for (const m of messages) {
			expect(decodeRefsMap(m.row.refs_map_b64)).toEqual({});
		}
	});

	it('observes an own accepted-but-not-yet-replicated message as a tail (§R2)', async () => {
		const snapshotMap = new Map();
		_setAcceptedSnapshotStorageForTests({
			async get(k) { return snapshotMap.get(k) ?? null; },
			async set(k, v) { snapshotMap.set(k, v); },
			async delete(k) { snapshotMap.delete(k); },
			async keys() { return [...snapshotMap.keys()]; },
			async clear() { snapshotMap.clear(); },
		});

		const store = useDialogsStore();
		const statuses = [];

		const base = sendImpl;
		sendImpl = async (mutations) => {
			sent.push(...mutations);
			return { txids: [] };
		};

		const firstId = await store.sendMessage(PEER_HASH, 'first', (s) => statuses.push(['first', s]));
		await waitFor(() => statuses.some(([m, s]) => m === 'first' && (s === 'synced' || s === 'error')), 'first to settle');
		expect(statuses).toContainEqual(['first', 'synced']);

		expect(collections.dialog.messages.rows.has(firstId)).toBe(false);
		sendImpl = base;
		await recordAccepted('dialog_messages', firstId, {
			message_id: firstId, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
			deleted_flag: false, sign_hash: SIGN_HASH, owner_timestamp: 1000,
		});

		const secondId = await store.sendMessage(PEER_HASH, 'second', (s) => statuses.push(['second', s]));
		await waitFor(() => statuses.some(([m, s]) => m === 'second' && (s === 'synced' || s === 'error')), 'second to settle');

		const secondMutation = sent
			.filter((m) => m.relation === 'dialog_messages')
			.find((m) => m.row.message_id === secondId);
		expect(decodeRefsMap(secondMutation.row.refs_map_b64)).toEqual({ [firstId]: SIGN_HASH });
	});
});

describe('multi-reload transitive reduction stays correct across a reload boundary (§5)', () => {
	const decodeRefsMap = (refsMapB64) => JSON.parse(refsMapB64.replace(/^enc\(/, '').replace(/\)$/, ''));

	const reload = () => {
		setActivePinia(createPinia());
		return useDialogsStore();
	};

	it('B observes A; after ANOTHER reload, C transitively reduces to B alone — never a redundant direct A, never a forged row', async () => {
		const base = sendImpl;
		sendImpl = async (mutations) => { sent.push(...mutations); return { txids: [] }; };

		let store = useDialogsStore();
		const statuses = [];

		const aId = await store.sendMessage(PEER_HASH, 'message A', (s) => statuses.push(['A', s]));
		await waitFor(() => statuses.some(([m, s]) => m === 'A' && (s === 'synced' || s === 'error')), 'A to settle');
		expect(statuses).toContainEqual(['A', 'synced']);
		expect(collections.dialog.messages.rows.has(aId)).toBe(false); // shape genuinely has not caught up

		const aMutation = sent.filter((m) => m.relation === 'dialog_messages').find((m) => m.row.message_id === aId);
		const aSignHash = aMutation.changes.sign_hash;
		await recordAccepted('dialog_messages', aId, {
			message_id: aId, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
			deleted_flag: false, sign_hash: aSignHash, owner_timestamp: aMutation.row.owner_timestamp,
			refs_map_b64: 'placeholder',
		});

		store = reload();

		const bId = await store.sendMessage(PEER_HASH, 'message B', (s) => statuses.push(['B', s]));
		await waitFor(() => statuses.some(([m, s]) => m === 'B' && (s === 'synced' || s === 'error')), 'B to settle');
		expect(statuses).toContainEqual(['B', 'synced']);

		const bMutation = sent.filter((m) => m.relation === 'dialog_messages').find((m) => m.row.message_id === bId);
		expect(decodeRefsMap(bMutation.row.refs_map_b64)).toEqual({ [aId]: aSignHash });

		const bSignHash = bMutation.changes.sign_hash;
		await recordAccepted('dialog_messages', bId, {
			message_id: bId, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
			deleted_flag: false, sign_hash: bSignHash, owner_timestamp: bMutation.row.owner_timestamp,
			refs_map_b64: 'placeholder',
		});

		const forgedId = 'dmsg_forged_' + '9'.repeat(20);
		collections.dialog.messages.rows.set(forgedId, {
			message_id: forgedId, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
			content_b64: 'enc(forged)', deleted_flag: false, refs_map_b64: null,
			parent_sign_hash: null, owner_timestamp: 999999, sign_hash: 'forged_hash_not_real',
			sign_b64: 'not-a-real-signature',
		});
		store = reload();

		const cId = await store.sendMessage(PEER_HASH, 'message C', (s) => statuses.push(['C', s]));
		await waitFor(() => statuses.some(([m, s]) => m === 'C' && (s === 'synced' || s === 'error')), 'C to settle');
		expect(statuses).toContainEqual(['C', 'synced']);

		const cMutation = sent.filter((m) => m.relation === 'dialog_messages').find((m) => m.row.message_id === cId);
		expect(decodeRefsMap(cMutation.row.refs_map_b64)).toEqual({ [bId]: bSignHash });

		sendImpl = base;
	});
});

describe('captureMessageIntent: durable before any construction (§A)', () => {
	it('a durability failure prevents key init, encryption and any network write — nothing was ever shown to the user', async () => {
		const store = useDialogsStore();
		enqueueIntentSpy.mockImplementationOnce(async () => null);

		await expect(store.captureMessageIntent(PEER_HASH, 'hello')).rejects.toThrow(/could not be stored/);

		expect(sent).toHaveLength(0);
		expect(createGenericMutationSpy).not.toHaveBeenCalled();
	});

	it('the captured message id and owner timestamp are fixed once and reused exactly by dispatch', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});

		const { intentId, payload, token } = await store.captureMessageIntent(PEER_HASH, 'hello', 'dmsg_fixed_id', 555555);
		expect(payload.messageId).toBe('dmsg_fixed_id');
		expect(payload.ownerTimestamp).toBe(555555);

		const statuses = [];
		await store.dispatchMessageIntent(intentId, payload, token, (s) => statuses.push(s));

		const msg = sent.find((m) => m.relation === 'dialog_messages');
		expect(msg.row.message_id).toBe('dmsg_fixed_id');
		expect(msg.row.owner_timestamp).toBe(555555);
		expect(statuses).toContain('synced');
		expect(createGenericMutationSpy.mock.calls.filter((c) => c[0] === 'dialog_messages')).toHaveLength(1);
	});

	it('captures scope from already gate-admitted messages without exporting vault keys, decrypting anything fresh, or touching the network (§3, §5)', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		const M2_ID = 'dmsg_' + '6'.repeat(128);
		const M2_SIGN_HASH = 'dms_' + '7'.repeat(128);
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);
		collections.dialog.messages.rows.set(M2_ID, {
			...GENESIS_ROW,
			message_id: M2_ID,
			sign_hash: M2_SIGN_HASH,
			refs_map_b64: `enc(${JSON.stringify({ [MSG_ID]: SIGN_HASH })})`,
		});
		await store.admitMessageRow(GENESIS_ROW);
		exportVaultKeysSpy.mockClear();

		const { payload } = await store.captureMessageIntent(PEER_HASH, 'third');

		expect(exportVaultKeysSpy).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
		expect(createGenericMutationSpy).not.toHaveBeenCalled();
		expect(payload.observedTails).toEqual({ [MSG_ID]: SIGN_HASH });
	});

	it('a durability failure with already-loaded messages present still makes zero vault/key/encryption/sign/network calls and zero optimistic projection', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);
		enqueueIntentSpy.mockImplementationOnce(async () => null);

		await expect(store.captureMessageIntent(PEER_HASH, 'third')).rejects.toThrow(/could not be stored/);

		expect(exportVaultKeysSpy).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
		expect(createGenericMutationSpy).not.toHaveBeenCalled();
		expect(store.optimisticItems.size).toBe(0);
	});
});
describe('captureMessageIntent: an account switch during the causal-bookkeeping write is refused, not silently mis-encrypted (§1)', () => {
	let rawTailsMap;

	beforeEach(() => {
		rawTailsMap = new Map();
		_setRawOwnObservedTailsStorageForTests({
			async get(k) { return rawTailsMap.get(k) ?? null; },
			async set(k, v) { rawTailsMap.set(k, v); },
			async delete(k) { rawTailsMap.delete(k); },
			async keys() { return [...rawTailsMap.keys()]; },
			async clear() { rawTailsMap.clear(); },
		});
		clearLocalStorageKey();
		ambientUserHash = MY_HASH;
	});

	afterEach(() => {
		_setOwnObservedTailsStorageForTests({
			_map: new Map(),
			async get(k) { return this._map.get(k) ?? null; },
			async set(k, v) { this._map.set(k, v); },
			async delete(k) { this._map.delete(k); },
			async keys() { return [...this._map.keys()]; },
			async clear() { this._map.clear(); },
		});
	});

	it('a switch away from the pinned owner, in flight during the write\'s own key derivation, refuses it — captureMessageIntent throws, no intent is ever enqueued, nothing is left readable under either account', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		exportVaultKeysSpy.mockImplementationOnce(() => new Promise((resolve) => {
			ambientUserHash = OTHER_ACCOUNT_HASH;
			resolve({ sign_skey: 'AAAA', crypt_skey: btoa(String.fromCharCode(...new Uint8Array(32).fill(2))), evm_skey: 'cc' });
		}));

		await expect(store.captureMessageIntent(PEER_HASH, 'hello')).rejects.toThrow();

		expect(enqueueIntentSpy).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
		expect(createGenericMutationSpy).not.toHaveBeenCalled();
		expect(store.optimisticItems.size).toBe(0);
		expect(rawTailsMap.size).toBe(0); // nothing durable under either account
	});

	it('with no switch, the same write succeeds and reads back correctly under the SAME account', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});

		const { payload } = await store.captureMessageIntent(PEER_HASH, 'hello', 'dmsg_pinned_ok');

		expect(rawTailsMap.size).toBe(1);
		expect(await getOwnObservedTails('dmsg_pinned_ok')).toEqual(payload.observedTails);
	});
});

describe('captured causal scope is frozen at capture time, never recomputed at dispatch (§B)', () => {
	const decodeRefsMap = (refsMapB64) => JSON.parse(refsMapB64.replace(/^enc\(/, '').replace(/\)$/, ''));

	it('a message that lands after capture but before dispatch is excluded from the already-captured scope', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);
		await store.admitMessageRow(GENESIS_ROW);

		const { intentId, payload, token } = await store.captureMessageIntent(PEER_HASH, 'second');
		expect(payload.observedTails).toEqual({ [MSG_ID]: SIGN_HASH });

		const LATE_ID = 'dmsg_' + '5'.repeat(128);
		collections.dialog.messages.rows.set(LATE_ID, { ...GENESIS_ROW, message_id: LATE_ID, sign_hash: 'dms_' + 'a'.repeat(128) });

		await store.dispatchMessageIntent(intentId, payload, token, () => {});

		const msg = sent.find((m) => m.relation === 'dialog_messages' && m.row.message_id === payload.messageId);
		expect(decodeRefsMap(msg.row.refs_map_b64)).toEqual({ [MSG_ID]: SIGN_HASH });
	});
});

describe('locked vault at dispatch time reports a distinct status, never a generic error (§4)', () => {
	it('a vault export failure during materialization reports awaiting_unlock — the intent stays durable, nothing was sent', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});

		const { intentId, payload, token } = await store.captureMessageIntent(PEER_HASH, 'hello');

		exportVaultKeysSpy.mockRejectedValueOnce(new Error('vault is locked'));

		const statuses = [];
		await store.dispatchMessageIntent(intentId, payload, token, (s) => statuses.push(s));

		expect(statuses).toEqual(['syncing', 'awaiting_unlock']);
		expect(sent).toHaveLength(0);
		expect(createGenericMutationSpy).not.toHaveBeenCalled();
	});
});

describe('account/session fencing: an in-flight message/checkpoint intent belongs to the account that captured it (§1)', () => {
	const OTHER_ACCOUNT_HASH = 'u_' + 'b'.repeat(128);

	it('capture under account A, then switch to B before dispatch: no signing, no dispatch, an honest error status', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});

		startLeaderElection(MY_HASH, () => {});
		const { intentId, payload, token } = await store.captureMessageIntent(PEER_HASH, 'hello');

		stopLeaderElection();
		startLeaderElection(OTHER_ACCOUNT_HASH, () => {});

		const statuses = [];
		await store.dispatchMessageIntent(intentId, payload, token, (s) => statuses.push(s));

		expect(sent).toHaveLength(0);
		expect(createGenericMutationSpy).not.toHaveBeenCalled();
		expect(statuses).toEqual(['error']);
	});

	it('a session mismatch during materialization does not leak into a dialog_keys write signed by the wrong account either', async () => {
		const store = useDialogsStore();
		startLeaderElection(MY_HASH, () => {});
		const { intentId, payload, token } = await store.captureMessageIntent(PEER_HASH, 'hello');

		stopLeaderElection();
		startLeaderElection(OTHER_ACCOUNT_HASH, () => {});

		await store.dispatchMessageIntent(intentId, payload, token, () => {});

		expect(sent.filter((m) => m.relation === 'dialog_keys')).toHaveLength(0);
		expect(sent.filter((m) => m.relation === 'dialog_messages')).toHaveLength(0);
	});

	it('a late completion from the old session honestly fails its OWN bubble — it never hangs at "sending" forever, and touches nothing else', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});

		startLeaderElection(MY_HASH, () => {});
		const { intentId, payload, token } = await store.captureMessageIntent(PEER_HASH, 'hello');
		const optimisticId = store.addOptimisticMessageWithId(DIALOG_HASH, payload.messageId, 'hello', payload.ownerTimestamp);
		const before = store.optimisticItems.size;

		stopLeaderElection();
		startLeaderElection(OTHER_ACCOUNT_HASH, () => {});

		await store.dispatchMessageIntent(intentId, payload, token, (s) => store.updateOptimisticStatus(optimisticId, s));

		expect(store.optimisticItems.get(optimisticId)?.status).toBe('error');
		expect(store.optimisticItems.size).toBe(before); // no NEW entry created
	});

	it('still dispatches normally when the active session matches the intent owner (no false positive)', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});

		startLeaderElection(MY_HASH, () => {});
		const { intentId, payload, token } = await store.captureMessageIntent(PEER_HASH, 'hello');

		const statuses = [];
		await store.dispatchMessageIntent(intentId, payload, token, (s) => statuses.push(s));

		expect(statuses).toContain('synced');
		expect(sent.filter((m) => m.relation === 'dialog_messages')).toHaveLength(1);
	});

	it('logout then relogin to the SAME account bumps the generation and still fences the old flow', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});

		startLeaderElection(MY_HASH, () => {});
		const { intentId, payload, token } = await store.captureMessageIntent(PEER_HASH, 'hello');

		stopLeaderElection();
		startLeaderElection(MY_HASH, () => {});

		const statuses = [];
		await store.dispatchMessageIntent(intentId, payload, token, (s) => statuses.push(s));

		expect(sent).toHaveLength(0);
		expect(createGenericMutationSpy).not.toHaveBeenCalled();
		expect(statuses).toEqual(['error']);
	});

	it('a checkpoint intent is fenced the same way a plain message is', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});

		startLeaderElection(MY_HASH, () => {});
		const { intentId, payload, token } = await store.captureMessageIntent(
			PEER_HASH, [{ kind: 'checkpoint', version: 1 }], null, null, 'checkpoint'
		);
		expect(payload.kind).toBe('checkpoint');

		stopLeaderElection();
		startLeaderElection(OTHER_ACCOUNT_HASH, () => {});

		const statuses = [];
		await store.dispatchMessageIntent(intentId, payload, token, (s) => statuses.push(s));

		expect(sent).toHaveLength(0);
		expect(statuses).toEqual(['error']);
	});

	it('a session switch landing exactly between the durable "accepted" handoff and the immediate onStatus callback never fires that callback for the old session', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});

		startLeaderElection(MY_HASH, () => {});
		const { intentId, payload, token } = await store.captureMessageIntent(PEER_HASH, 'hello');

		let releaseSend;
		sendImpl = async (mutations) => {
			sent.push(...mutations);
			await new Promise((resolve) => { releaseSend = resolve; });
			return { txids: [1] };
		};

		const statuses = [];
		const dispatched = store.dispatchMessageIntent(intentId, payload, token, (s) => statuses.push(s));

		await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
		stopLeaderElection();
		startLeaderElection(OTHER_ACCOUNT_HASH, () => {});
		releaseSend();

		await dispatched;

		expect(statuses).toEqual(['syncing']);
	});
});

describe('reaction toggle coalescing', () => {
	const toggle = (store) =>
		store.toggleReaction(PEER_HASH, {
			messageId: MSG_ID,
			messageSignHash: SIGN_HASH,
			emoji: '👍',
		});

	// Two clicks land back on "no reaction". Reading only the server state made
	// both clicks compute desiredActive=true, so the pair wrote the reaction on
	// and left it on.
	it('a fast double click ends with the reaction removed', async () => {
		const store = useDialogsStore();

		await Promise.all([toggle(store), toggle(store)]);
		await flush();

		const writes = sent.filter((m) => m.relation === 'dialog_message_reactions');
		expect(writes.length).toBeGreaterThan(0);
		expect(writes.at(-1).row.deleted_flag).toBe(true);
		// A retraction still needs an encrypted, non-empty type_b64 — the
		// backend rejects a literal '' as blank and the reaction can never be
		// removed (confirmed live by the backend's own ingest test).
		expect(writes.at(-1).row.type_b64).toBe('enc()');
	});

	it('an odd number of clicks ends with the reaction present', async () => {
		const store = useDialogsStore();

		await Promise.all([toggle(store), toggle(store), toggle(store)]);
		await flush();

		const writes = sent.filter((m) => m.relation === 'dialog_message_reactions');
		expect(writes.at(-1).row.deleted_flag).toBe(false);
		expect(writes.at(-1).row.type_b64).toBe('enc(👍)');
	});

	it('a rapid on/off/on leaves exactly one optimistic entry for the reaction, not three', async () => {
		const store = useDialogsStore();

		await Promise.all([toggle(store), toggle(store), toggle(store)]);
		await flush();

		const reactionItems = [...store.optimisticItems.values()].filter((item) => item.type === 'reaction');
		expect(reactionItems).toHaveLength(1);
	});

	// Serialization is the property that keeps owner_timestamp monotonic: two
	// concurrent writes would read the same base row and derive the same value.
	//
	// Coalescing alone does not prove this — two clicks collapse into a single
	// write, and "at most one at a time" then holds trivially. So the transport
	// is gated: the second click arrives while the first write is in flight,
	// past the point where its intent was consumed, which is exactly the window
	// that produces two genuine writes.
	it('never runs two writes for one reaction concurrently', async () => {
		const store = useDialogsStore();
		let inFlight = 0;
		let maxInFlight = 0;
		const gates = [];
		const base = sendImpl;
		sendImpl = async (mutations) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((release) => gates.push(release));
			inFlight--;
			return base(mutations);
		};
		const releaseAll = async () => {
			while (gates.length) gates.shift()();
			await flush();
		};

		// Let dialog-key creation through so only reaction writes are gated.
		const first = toggle(store);
		await flush();
		await releaseAll();

		// The first reaction write is now blocked mid-flight, past the point
		// where it took ownership of the intent. This is the window that used
		// to lose the click.
		const second = toggle(store);
		await flush();
		await releaseAll();
		await releaseAll();
		await Promise.all([first, second]);

		const writes = sent.filter((m) => m.relation === 'dialog_message_reactions');
		expect(writes).toHaveLength(2);
		expect(writes[0].row.deleted_flag).toBe(false);
		expect(writes[1].row.deleted_flag).toBe(true);
		expect(maxInFlight).toBe(1);
	});

	// The reaction row carries the revision it belongs to; a message that has
	// not round-tripped has no sign_hash to bind to.
	it('refuses to react to a message that is not synced yet', async () => {
		const store = useDialogsStore();

		await expect(
			store.toggleReaction(PEER_HASH, { messageId: MSG_ID, messageSignHash: null, emoji: '👍' })
		).rejects.toThrow(/not synced/);
	});
});

describe('permanent reaction failure quarantines durably and does not auto-discard (L17-07)', () => {
	const toggle = (store) =>
		store.toggleReaction(PEER_HASH, { messageId: MSG_ID, messageSignHash: SIGN_HASH, emoji: '👍' });

	const permanentlyRejectReactionWrites = () => {
		const baseSend = sendImpl;
		sendImpl = async (mutations) => {
			if (mutations[0]?.relation !== 'dialog_message_reactions') return baseSend(mutations);
			const compliant = mutations.map((m) => ({ ...m, modified: m.row }));
			const outboxId = await enqueue(compliant, MY_HASH);
			const error = new MockIngestError('rejected: reaction not allowed', { permanent: true });
			await recordFailure(outboxId, error);
			throw error;
		};
	};

	it('creates a quarantined entry that is still there after the reaction promise settles', async () => {
		const store = useDialogsStore();
		permanentlyRejectReactionWrites();

		const optimisticId = await toggle(store);
		await flush();

		const quarantined = await quarantinedEntries(MY_HASH);
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0].relation).toBe('dialog_message_reactions');

		expect(store.optimisticItems.has(optimisticId)).toBe(false);
	});

	it('the quarantine survives a fresh storage handle over the same data (reload simulation)', async () => {
		const store = useDialogsStore();
		const backingMap = new Map();
		const freshHandle = () => ({
			async get(k) { return backingMap.get(k) ?? null; },
			async set(k, v) { backingMap.set(k, v); },
			async delete(k) { backingMap.delete(k); },
			async keys() { return [...backingMap.keys()]; },
			async clear() { backingMap.clear(); },
		});
		_setStorageForTests(freshHandle());
		permanentlyRejectReactionWrites();

		await toggle(store);
		await flush();
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);

		_setStorageForTests(freshHandle());
		const afterReload = await quarantinedEntries(MY_HASH);
		expect(afterReload).toHaveLength(1);
		expect(afterReload[0].relation).toBe('dialog_message_reactions');
	});

	it('an explicit discard (the banner\'s real action) removes exactly this entry', async () => {
		const store = useDialogsStore();
		permanentlyRejectReactionWrites();

		await toggle(store);
		await flush();
		const [entry] = await quarantinedEntries(MY_HASH);
		expect(entry).toBeTruthy();

		await discardEntry(entry.id);

		expect(await quarantinedEntries(MY_HASH)).toHaveLength(0);
	});

	it('does not touch an unrelated quarantined entry for a different revision/entity', async () => {
		const store = useDialogsStore();
		const otherMessageId = 'dmsg_' + '9'.repeat(128);
		const otherId = await enqueue(
			[{ type: 'insert', modified: { message_id: otherMessageId, dialog_hash: DIALOG_HASH }, syncMetadata: { relation: 'dialog_messages' } }],
			MY_HASH
		);
		await recordFailure(otherId, new MockIngestError('unrelated rejection', { permanent: true }));
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);

		permanentlyRejectReactionWrites();
		await toggle(store);
		await flush();

		const quarantined = await quarantinedEntries(MY_HASH);
		expect(quarantined).toHaveLength(2);
		expect(quarantined.some((e) => e.id === otherId)).toBe(true);
	});
});

describe('discardFailedItem clears the matching quarantined outbox entry, not just the optimistic bubble', () => {
	const seedQuarantinedEntry = async (relation, row) => {
		const id = await enqueue([{ type: 'insert', modified: row, syncMetadata: { relation } }], MY_HASH);
		await recordFailure(id, new IngestError('rejected', { permanent: true }));
		return id;
	};

	it('discards a quarantined dialog_messages entry matching the optimistic message id', async () => {
		const store = useDialogsStore();
		const optimisticId = store.addOptimisticMessageWithId(DIALOG_HASH, MSG_ID, 'hi');
		await seedQuarantinedEntry('dialog_messages', { message_id: MSG_ID, dialog_hash: DIALOG_HASH });
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);

		store.discardFailedItem(optimisticId);
		await flush();

		expect(store.optimisticItems.has(optimisticId)).toBe(false);
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(0);
	});

	it('discards a quarantined dialog_message_reactions entry matching the optimistic reaction', async () => {
		const store = useDialogsStore();
		const reactionHash = 'drh_' + '5'.repeat(128);
		const optimisticId = store.addOptimisticReaction(DIALOG_HASH, MSG_ID, '👍', reactionHash, true);
		await seedQuarantinedEntry('dialog_message_reactions', { reaction_hash: reactionHash, dialog_hash: DIALOG_HASH });
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);

		store.discardFailedItem(optimisticId);
		await flush();

		expect(store.optimisticItems.has(optimisticId)).toBe(false);
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(0);
	});

	it('never touches an unrelated quarantined entry for a different message', async () => {
		const store = useDialogsStore();
		const otherMsgId = 'dmsg_' + '9'.repeat(128);
		const optimisticId = store.addOptimisticMessageWithId(DIALOG_HASH, MSG_ID, 'hi');
		await seedQuarantinedEntry('dialog_messages', { message_id: otherMsgId, dialog_hash: DIALOG_HASH });

		store.discardFailedItem(optimisticId);
		await flush();

		expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);
	});
});

describe('read receipts', () => {
	it('publishes one append-only row bound to the displayed revision', async () => {
		const store = useDialogsStore();

		await store.sendReadReceipt(PEER_HASH, {
			messageId: MSG_ID,
			messageSignHash: SIGN_HASH,
		});

		const writes = sent.filter((m) => m.relation === 'dialog_message_receipts');
		expect(writes).toHaveLength(1);
		expect(writes[0].type).toBe('insert');
		expect(writes[0].row).toMatchObject({
			message_id: MSG_ID,
			message_sign_hash: SIGN_HASH,
			peer_hash: MY_HASH,
			type: 'read',
		});
		expect(writes[0].row.receipt_hash).toMatch(/^dmrc_[a-f0-9]{128}$/);
		// No deleted_flag: the server has no column for it, and the whole
		// point is that the acknowledgement cannot be taken back.
		expect(writes[0].row.deleted_flag).toBeUndefined();
	});

	it('does not write again once the receipt is on the server', async () => {
		const store = useDialogsStore();

		// The first call's barrier makes the row readable, which is exactly
		// what the second call checks before writing.
		await store.sendReadReceipt(PEER_HASH, {
			messageId: MSG_ID,
			messageSignHash: SIGN_HASH,
		});

		await store.sendReadReceipt(PEER_HASH, {
			messageId: MSG_ID,
			messageSignHash: SIGN_HASH,
		});

		expect(sent.filter((m) => m.relation === 'dialog_message_receipts')).toHaveLength(1);
	});

	it('refuses to acknowledge a message that is not synced yet', async () => {
		const store = useDialogsStore();

		await expect(
			store.sendReadReceipt(PEER_HASH, { messageId: MSG_ID, messageSignHash: null })
		).rejects.toThrow(/not synced/);
	});
});

describe('deleteMessage (§3.2)', () => {
	// Deletion is a signed revision, never a server-side removal: empty
	// content + deleted_flag, chained to the tip like any edit.
	it('writes an update tombstone chained to the current tip', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);

		await store.deleteMessage(PEER_HASH, MSG_ID);

		const row = collections.dialog.messages.rows.get(MSG_ID);
		expect(row.deleted_flag).toBe(true);
		expect(row.content_b64).toBe(null);
		expect(row.parent_sign_hash).toBe(SIGN_HASH);
		expect(row.owner_timestamp).toBeGreaterThan(1000);
	});

	it('refuses to delete a peer message', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, signedMessageRow(peerIdentity, {
			message_id: MSG_ID, dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH,
			content_b64: 'x', deleted_flag: false, refs_map_b64: null,
			parent_sign_hash: null, owner_timestamp: 100,
		}));
		await expect(store.deleteMessage(PEER_HASH, MSG_ID)).rejects.toThrow(/not owner/);
	});
});

describe('own accepted snapshot as a local base (§4.5)', () => {
	const ACCEPTED_SIGN_HASH = 'dms_' + '9'.repeat(128);

	const makeSnapshotStorage = () => {
		const map = new Map();
		return {
			async get(k) { return map.get(k) ?? null; },
			async set(k, v) { map.set(k, v); },
			async delete(k) { map.delete(k); },
			async keys() { return [...map.keys()]; },
			async clear() { map.clear(); },
		};
	};

	beforeEach(() => {
		_setAcceptedSnapshotStorageForTests(makeSnapshotStorage());
	});

	it('editMessage finds the message via its own accepted-snapshot when the shape has not caught up yet', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		await recordAccepted('dialog_messages', MSG_ID, {
			message_id: MSG_ID, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
			content_b64: 'x', deleted_flag: false, sign_hash: ACCEPTED_SIGN_HASH, owner_timestamp: 100,
		});

		await store.editMessage(PEER_HASH, MSG_ID, 'edited');

		const sent = enqueueIntentSpy.mock.calls.at(-1)?.[0]?.row;
		expect(sent?.parent_sign_hash).toBe(ACCEPTED_SIGN_HASH);
	});

	it('prefers the accepted-snapshot over a stale shape row by owner_timestamp', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, {
			message_id: MSG_ID, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
			content_b64: 'old', deleted_flag: false, sign_hash: SIGN_HASH, owner_timestamp: 100,
		});
		await recordAccepted('dialog_messages', MSG_ID, {
			message_id: MSG_ID, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
			content_b64: 'newer', deleted_flag: false, sign_hash: ACCEPTED_SIGN_HASH, owner_timestamp: 200,
		});

		await store.deleteMessage(PEER_HASH, MSG_ID);

		const sent = enqueueIntentSpy.mock.calls.at(-1)?.[0]?.row;
		expect(sent?.parent_sign_hash).toBe(ACCEPTED_SIGN_HASH);
	});
});

describe('editMessage coalescing is durable, not just in-memory (§3.1 Target lifecycle: LOCAL INTENT durable before VAULT ACCESS)', () => {
	it('the first edit of a burst enqueues a durable intent; a coalesced sibling updates it, never a second enqueue', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);

		await Promise.all([
			store.editMessage(PEER_HASH, MSG_ID, 'edit A'),
			store.editMessage(PEER_HASH, MSG_ID, 'edit B'),
		]);

		expect(enqueueIntentSpy).toHaveBeenCalledTimes(1);
		expect(updateIntentSpy).toHaveBeenCalledTimes(3);
		expect(updateIntentSpy.mock.calls[0][1].row.content_b64).toContain('edit B');
	});

	it('a non-overlapping later edit enqueues its own fresh durable intent, not an update of the finished one', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);

		await store.editMessage(PEER_HASH, MSG_ID, 'edit A');
		await store.editMessage(PEER_HASH, MSG_ID, 'edit B');

		expect(enqueueIntentSpy).toHaveBeenCalledTimes(2);
		expect(updateIntentSpy).toHaveBeenCalledTimes(4);
		expect(updateIntentSpy.mock.calls.map((c) => c[1].row.content_b64)).toEqual([
			expect.stringContaining('edit A'),
			expect.stringContaining('edit A'),
			expect.stringContaining('edit B'),
			expect.stringContaining('edit B'),
		]);
	});
});

describe('editMessage/deleteMessage refuse an unverified shape row as a base (§R3)', () => {
	it('editMessage treats a row with a signature that does not verify as if it were absent', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, { ...GENESIS_ROW, content_b64: 'enc(tampered)' });

		await expect(store.editMessage(PEER_HASH, MSG_ID, 'edit')).rejects.toThrow(/not found/i);
	});

	it('deleteMessage treats a row with a signature that does not verify as if it were absent', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, { ...GENESIS_ROW, owner_timestamp: 999999 });

		await expect(store.deleteMessage(PEER_HASH, MSG_ID)).rejects.toThrow(/not found/i);
	});
});

describe('editMessage race (§3.3 — a late ack/rejection of A must not touch B; §3.12 coalesces the race away)', () => {
	it('two concurrent edits of the same message coalesce into a single write with the latest text', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);

		const [a, b] = await Promise.allSettled([
			store.editMessage(PEER_HASH, MSG_ID, 'edit A'),
			store.editMessage(PEER_HASH, MSG_ID, 'edit B'),
		]);

		expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);

		const edits = sent.filter((m) => m.relation === 'dialog_messages' && m.type === 'update');
		expect(edits).toHaveLength(1);
		expect(edits[0].row.parent_sign_hash).toBe(SIGN_HASH);

		const finalRow = collections.dialog.messages.rows.get(MSG_ID);
		expect(finalRow.content_b64).toBe(edits[0].row.content_b64);
	});

	it('a coalescing edit whose durable update fails throws, rather than silently losing the newer text', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);

		updateIntentSpy.mockImplementationOnce(async () => false);

		const [a, b] = await Promise.allSettled([
			store.editMessage(PEER_HASH, MSG_ID, 'edit A'),
			store.editMessage(PEER_HASH, MSG_ID, 'edit B'),
		]);
		expect(a.status).toBe('fulfilled');
		expect(b.status).toBe('rejected');

		const edits = sent.filter((m) => m.relation === 'dialog_messages' && m.type === 'update');
		expect(edits).toHaveLength(1);
		expect(edits[0].row.content_b64).toBe('enc("edit A")');
	});

	it('an edit that starts only after the previous one is fully dispatched is independent, not coalesced', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);

		await store.editMessage(PEER_HASH, MSG_ID, 'edit A');
		await store.editMessage(PEER_HASH, MSG_ID, 'edit B');

		const edits = sent.filter((m) => m.relation === 'dialog_messages' && m.type === 'update');
		expect(edits).toHaveLength(2);
		expect(edits[0].row.content_b64).not.toBe(edits[1].row.content_b64);
	});

	it('a later, unrelated edit of the same message chains onto the CURRENT tip, not a leftover base from a completed edit', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);

		await store.editMessage(PEER_HASH, MSG_ID, 'edit A');

		const nextRow = signedMessageRow(myIdentity, {
			message_id: MSG_ID, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
			content_b64: 'enc("edit A")', deleted_flag: false,
			refs_map_b64: `enc(${JSON.stringify({ [MSG_ID]: SIGN_HASH })})`,
			parent_sign_hash: SIGN_HASH, owner_timestamp: 2000,
		});
		const NEXT_SIGN_HASH = nextRow.sign_hash;
		collections.dialog.messages.rows.set(MSG_ID, nextRow);

		await store.editMessage(PEER_HASH, MSG_ID, 'edit B');

		const edits = sent.filter((m) => m.relation === 'dialog_messages' && m.type === 'update');
		expect(edits).toHaveLength(2);
		expect(edits[0].row.parent_sign_hash).toBe(SIGN_HASH);
		expect(edits[1].row.parent_sign_hash).toBe(NEXT_SIGN_HASH);
	});

	it('never runs two writes for one message concurrently, but a second edit mid-flight still gets its own write', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);
		let NEW_SIGN_HASH;
		let callCount = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		const gates = [];
		const base = sendImpl;
		sendImpl = async (mutations) => {
			const isFirstCall = ++callCount === 1;
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((release) => gates.push(release));
			inFlight--;
			const result = await base(mutations);
			if (isFirstCall) {
				const nextRow = signedMessageRow(myIdentity, {
					message_id: MSG_ID, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH,
					content_b64: 'enc("edit A")', deleted_flag: false,
					refs_map_b64: `enc(${JSON.stringify({ [MSG_ID]: SIGN_HASH })})`,
					parent_sign_hash: SIGN_HASH, owner_timestamp: mutations[0].row.owner_timestamp,
				});
				NEW_SIGN_HASH = nextRow.sign_hash;
				collections.dialog.messages.rows.set(MSG_ID, nextRow);
			}
			return result;
		};
		const releaseAll = async () => {
			while (gates.length) gates.shift()();
			await flush();
		};

		const first = store.editMessage(PEER_HASH, MSG_ID, 'edit A');
		await flush();

		const second = store.editMessage(PEER_HASH, MSG_ID, 'edit B');
		await flush();

		await releaseAll();
		await releaseAll();
		await Promise.all([first, second]);

		const edits = sent.filter((m) => m.relation === 'dialog_messages' && m.type === 'update');
		expect(edits).toHaveLength(2);
		expect(maxInFlight).toBe(1);
		expect(edits[1].row.parent_sign_hash).toBe(NEW_SIGN_HASH);
		expect(edits[1].row.parent_sign_hash).not.toBe(SIGN_HASH);
		expect(edits[1].row.owner_timestamp).toBeGreaterThan(edits[0].row.owner_timestamp);
	});
});

describe('editMessage resolves with the exact signed identity of the dispatched revision', () => {
	it('signHash is the sign_hash of the mutation that was actually signed and dispatched', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);

		const result = await store.editMessage(PEER_HASH, MSG_ID, 'edit A');

		const edits = sent.filter((m) => m.relation === 'dialog_messages' && m.type === 'update');
		expect(edits).toHaveLength(1);
		expect(result.signHash).toBeTruthy();
		expect(result.signHash).toBe(edits[0].changes.sign_hash);
	});

	it('does not sign a second time to obtain the identity the UI reads', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);

		await store.editMessage(PEER_HASH, MSG_ID, 'edit A');

		expect(createGenericMutationSpy).toHaveBeenCalledTimes(1);
	});

	it('a coalesced edit resolves with the sign_hash of the content that actually got dispatched', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false,
		});
		collections.dialog.messages.rows.set(MSG_ID, GENESIS_ROW);

		const [resultA, resultB] = await Promise.all([
			store.editMessage(PEER_HASH, MSG_ID, 'edit A'),
			store.editMessage(PEER_HASH, MSG_ID, 'edit B'),
		]);
		const edits = sent.filter((m) => m.relation === 'dialog_messages' && m.type === 'update');
		expect(edits).toHaveLength(1); // one signature for the whole coalesced burst
		expect(edits[0].row.content_b64).toMatch(/edit [AB]/);
		expect(resultA.signHash).toBe(edits[0].changes.sign_hash);
		expect(resultB.signHash).toBe(edits[0].changes.sign_hash);
	});
});

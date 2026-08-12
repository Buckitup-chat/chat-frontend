import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

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

const MY_HASH = 'u_' + '1'.repeat(128);
const PEER_HASH = 'u_' + '2'.repeat(128);
const DIALOG_HASH = 'di_' + '3'.repeat(128);
const MSG_ID = 'dmsg_' + '4'.repeat(128);
const SIGN_HASH = 'dms_' + '5'.repeat(128);

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

vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: (mutations) => sendImpl(mutations),
}));

vi.mock('@/api/client', () => ({
	api: {
		// Signing is covered by its own tests; here the mutation is just a
		// record of what the store decided to write.
		createGenericMutation: (relation, row, _skey, type) => ({
			type,
			relation,
			row,
			syncMetadata: { relation },
		}),
	},
}));

vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s) => (s ? new Uint8Array([1, 2, 3]) : null),
}));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => ({
				sign_skey: 'AAAA',
				crypt_skey: 'BBBB',
				evm_skey: 'cc',
			}),
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
		decryptContent: async () => null,
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
	setActivePinia(createPinia());
	collections = {
		cards: makeCollection({
			[PEER_HASH]: { user_hash: PEER_HASH, crypt_pkey: 'peerkey' },
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
	});

	it('an odd number of clicks ends with the reaction present', async () => {
		const store = useDialogsStore();

		await Promise.all([toggle(store), toggle(store), toggle(store)]);
		await flush();

		const writes = sent.filter((m) => m.relation === 'dialog_message_reactions');
		expect(writes.at(-1).row.deleted_flag).toBe(false);
		expect(writes.at(-1).row.type_b64).toBe('enc(👍)');
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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { recordAccepted, _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setStorageForTests, startLeaderElection, stopLeaderElection } from '@/lib/data/outbox';

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

const makeCollection = (rows = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
});

let collections;

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: MY_HASH }),
}));

vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

let dispatchCalls;
let pendingHandles;
vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: vi.fn(async (mutations) => {
		dispatchCalls.push(mutations);
		let resolveAcceptance;
		const acceptance = new Promise((r) => { resolveAcceptance = r; });
		const handle = { outboxId: `outbox-${dispatchCalls.length}`, phase: 'queued', result: undefined, acceptance };
		pendingHandles.push({ mutations, resolveAcceptance });
		return handle;
	}),
	DurabilityError: class MockDurabilityError extends Error {},
	IngestError: class MockIngestError extends Error {
		constructor(message, opts = {}) { super(message); this.name = 'IngestError'; this.permanent = opts.permanent ?? false; }
	},
	OWNER_FIELD: {
		dialog_keys: 'sender_hash',
		dialog_messages: 'sender_hash',
		dialog_message_reactions: 'reactor_hash',
		dialog_message_receipts: 'peer_hash',
	},
}));

vi.mock('@/lib/data/intents', () => {
	const store = new Map();
	let seq = 0;
	return {
		enqueueIntent: async (intent, userHash, relation) => {
			const id = `test-intent-${seq++}`;
			store.set(id, { id, userHash, relation, intent });
			return id;
		},
		updateIntent: async (id, intent) => {
			const existing = store.get(id);
			if (!existing) return false;
			store.set(id, { ...existing, intent });
			return true;
		},
		resolveIntent: async () => true,
		getIntent: async (id) => store.get(id) ?? null,
	};
});

vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation, row, _skey, type) => ({ type, relation, row, syncMetadata: { relation } }),
	},
}));

vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s) => (s ? new Uint8Array([1, 2, 3]) : null),
}));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => ({ sign_skey: 'AAAA', crypt_skey: 'BBBB', evm_skey: 'cc' }),
		}),
	},
}));

vi.mock('@/libs/DialogCrypto', () => ({
	DialogCrypto: {
		computeDialogHash: () => DIALOG_HASH,
		deriveSenderMsgKey: () => new Uint8Array(32),
		wrapSenderMsgKey: async () => ({ peerKemWrapKeyB64: 'wrap', peerWrappedMsgKeyB64: 'wrapped' }),
		computeReactionHash: (_k, messageId, reactor, emoji) => `dmr_${messageId}:${reactor}:${emoji}`,
		encryptContent: async (_k, text) => `enc(${text})`,
		decryptContent: async (_k, ciphertext) =>
			typeof ciphertext === 'string' && ciphertext.startsWith('enc(') && ciphertext.endsWith(')')
				? ciphertext.slice(4, -1) : null,
	},
}));

const { useDialogsStore } = await import('@/store/dialogs.store');

const flush = async () => {
	for (let i = 0; i < 5; i++) {
		for (let j = 0; j < 20; j++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	}
};

beforeEach(() => {
	setActivePinia(createPinia());
	stopLeaderElection();
	startLeaderElection(MY_HASH, () => {});
	dispatchCalls = [];
	pendingHandles = [];
	_setAcceptedSnapshotStorageForTests({
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
		cards: makeCollection({ [MY_HASH]: myIdentity.card, [PEER_HASH]: peerIdentity.card }),
		dialog: {
			keys: makeCollection({
				[`${DIALOG_HASH}|${MY_HASH}`]: { dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, deleted_flag: false },
			}),
			messages: makeCollection(),
			reactions: makeCollection(),
			receipts: makeCollection(),
			versions: makeCollection(),
		},
	};
});

const toggle = (store) =>
	store.toggleReaction(PEER_HASH, { messageId: MSG_ID, messageSignHash: SIGN_HASH, emoji: '👍' });

const liveReactionItem = (store) =>
	[...store.optimisticItems.values()].find((item) => item.type === 'reaction');

describe('toggleReaction coalescing tracks the REAL dispatch, never invents acceptance (L17-01/R4)', () => {
	it('rapid on/off/on: the live optimistic entry stays syncing until the real (shared) dispatch actually settles', async () => {
		const store = useDialogsStore();

		const p1 = toggle(store);
		const p2 = toggle(store);
		const p3 = toggle(store);
		await flush();

		expect(dispatchCalls).toHaveLength(1);

		const live = liveReactionItem(store);
		expect(live).toBeTruthy();
		expect(live.status).toBe('syncing');
		pendingHandles[0].resolveAcceptance({ kind: 'accepted' });
		await Promise.all([p1, p2, p3]);
		await flush();

		expect(liveReactionItem(store).status).toBe('synced');
		expect(dispatchCalls).toHaveLength(1); // still exactly one — acceptance didn't trigger a second send
	});

	it('permanent rejection of the shared dispatch marks the live entry error, not synced', async () => {
		const store = useDialogsStore();

		const p1 = toggle(store);
		const p2 = toggle(store);
		await flush();
		expect(dispatchCalls).toHaveLength(1);

		pendingHandles[0].resolveAcceptance({ kind: 'rejected', error: 'validation_failed' });
		await Promise.all([p1, p2]);
		await flush();

		expect(liveReactionItem(store).status).toBe('error');
	});

	it('explicit discard of the shared dispatch never reports synced', async () => {
		const store = useDialogsStore();

		const p1 = toggle(store);
		const p2 = toggle(store);
		await flush();
		expect(dispatchCalls).toHaveLength(1);

		pendingHandles[0].resolveAcceptance({ kind: 'discarded' });
		await Promise.all([p1, p2]);
		await flush();

		expect(liveReactionItem(store).status).not.toBe('synced');
		expect(liveReactionItem(store).status).toBe('error');
	});

	it('a superseded (non-live) optimistic entry is gone, not lingering with a status of its own', async () => {
		const store = useDialogsStore();

		const p1 = toggle(store);
		const p2 = toggle(store);
		const p3 = toggle(store);
		await flush();

		const reactionItems = [...store.optimisticItems.values()].filter((i) => i.type === 'reaction');
		expect(reactionItems).toHaveLength(1);

		pendingHandles[0].resolveAcceptance({ kind: 'accepted' });
		await Promise.all([p1, p2, p3]);
		await flush();

		const after = [...store.optimisticItems.values()].filter((i) => i.type === 'reaction');
		expect(after).toHaveLength(1);
		expect(after[0].status).toBe('synced');
	});
});

const REACTION_HASH = `dmr_${MSG_ID}:${MY_HASH}:👍`;

const rowOf = (call) => call[0].row;

describe('the reaction operation stays in flight until the REAL terminal outcome, not just a queued handle (L17-01/R4)', () => {
	it('a click during pending acceptance does not start a second transport, and the eventual second write is a toggle, not a duplicate insert', async () => {
		const store = useDialogsStore();

		toggle(store); // click ON
		await vi.waitFor(() => expect(dispatchCalls).toHaveLength(1));
		expect(rowOf(dispatchCalls[0]).deleted_flag).toBe(false); // ON

		toggle(store); // click OFF
		await new Promise((r) => setTimeout(r, 20));
		expect(dispatchCalls).toHaveLength(1); // still just the ON write — OFF has not been signed/sent yet

		await recordAccepted('dialog_message_reactions', REACTION_HASH, rowOf(dispatchCalls[0]));
		pendingHandles[0].resolveAcceptance({ kind: 'accepted' });

		await vi.waitFor(() => expect(dispatchCalls).toHaveLength(2));
		const second = rowOf(dispatchCalls[1]);
		expect(second.deleted_flag).toBe(true); // OFF really is OFF, not a repeated ON
		expect(dispatchCalls[1][0].type).toBe('update'); // a toggle of the just-accepted row, never a second insert
	});

	it('repeated ON -> pending -> OFF -> ON with controlled terminal outcomes ends with the correct final state', async () => {
		const store = useDialogsStore();

		toggle(store); // ON
		await vi.waitFor(() => expect(dispatchCalls).toHaveLength(1));
		toggle(store); // OFF, queued behind ON's still-pending acceptance

		await recordAccepted('dialog_message_reactions', REACTION_HASH, rowOf(dispatchCalls[0]));
		pendingHandles[0].resolveAcceptance({ kind: 'accepted' });
		await vi.waitFor(() => expect(dispatchCalls).toHaveLength(2));
		expect(rowOf(dispatchCalls[1]).deleted_flag).toBe(true); // OFF

		toggle(store);
		await new Promise((r) => setTimeout(r, 20));
		expect(dispatchCalls).toHaveLength(2); // third write still blocked

		await recordAccepted('dialog_message_reactions', REACTION_HASH, rowOf(dispatchCalls[1]));
		pendingHandles[1].resolveAcceptance({ kind: 'accepted' });
		await vi.waitFor(() => expect(dispatchCalls).toHaveLength(3));

		expect(rowOf(dispatchCalls[2]).deleted_flag).toBe(false); // ON again
		expect(dispatchCalls[2][0].type).toBe('update'); // toggling the accepted OFF row, not a fresh insert

		pendingHandles[2].resolveAcceptance({ kind: 'accepted' });
		await flush();
		expect(liveReactionItem(store).status).toBe('synced');
	});

	it('a late rejection of a superseded dispatch does not mark the live (newer, independent) projection synced or remove it', async () => {
		const store = useDialogsStore();

		toggle(store); // click A: ON
		await vi.waitFor(() => expect(dispatchCalls).toHaveLength(1));

		toggle(store); // click B: OFF — queued behind A, gets its OWN dispatch once A settles
		await new Promise((r) => setTimeout(r, 20));
		expect(dispatchCalls).toHaveLength(1);

		pendingHandles[0].resolveAcceptance({ kind: 'rejected', error: 'validation_failed' });
		await vi.waitFor(() => expect(dispatchCalls).toHaveLength(2)); // B's own write, now unblocked, proceeds

		const live = liveReactionItem(store);
		expect(live).toBeTruthy();
		expect(live.status).toBe('syncing');

		await recordAccepted('dialog_message_reactions', REACTION_HASH, rowOf(dispatchCalls[1]));
		pendingHandles[1].resolveAcceptance({ kind: 'accepted' });
		await flush();

		expect(liveReactionItem(store).status).toBe('synced');
	});

	it('a permanently rejected key write is never cached as success (queued/follower path)', async () => {
		const store = useDialogsStore();

		toggle(store);
		await vi.waitFor(() => expect(dispatchCalls).toHaveLength(1));
		pendingHandles[0].resolveAcceptance({ kind: 'discarded' });
		await flush();

		expect(liveReactionItem(store).status).toBe('error');
		expect(liveReactionItem(store).status).not.toBe('synced');
	});
});

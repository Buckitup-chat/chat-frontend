import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { signFields, toBase64 } from '@/lib/pq/signature';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
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
	},
}));

const { useDialogsStore } = await import('@/store/dialogs.store');

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
			keys: makeCollection(), // empty — this is exactly what's under test
			messages: makeCollection(),
			reactions: makeCollection(),
			receipts: makeCollection(),
			versions: makeCollection(),
		},
	};
});

describe('initDialogKeys tracks the REAL acceptance of its own key write (L17-01/R4)', () => {
	it('a concurrent call reuses the same in-flight (still-queued) result, no second dispatch', async () => {
		const store = useDialogsStore();

		const p1 = store.initDialogKeys(PEER_HASH);
		const p2 = store.initDialogKeys(PEER_HASH);
		await new Promise((r) => setTimeout(r, 10));

		expect(dispatchCalls).toHaveLength(1); // one signed dialog_keys snapshot for both callers

		pendingHandles[0].resolveAcceptance({ kind: 'accepted' });
		await expect(p1).resolves.toBe(DIALOG_HASH);
		await expect(p2).resolves.toBe(DIALOG_HASH);
		expect(dispatchCalls).toHaveLength(1);
	});

	it('a send arriving after the guard clears but before the shape echoes the row does not sign a duplicate insert', async () => {
		const store = useDialogsStore();

		const first = store.initDialogKeys(PEER_HASH);
		await new Promise((r) => setTimeout(r, 10));
		expect(dispatchCalls).toHaveLength(1);

		pendingHandles[0].resolveAcceptance({ kind: 'accepted' });
		await first;

		const second = await store.initDialogKeys(PEER_HASH);

		expect(second).toBe(DIALOG_HASH);
		expect(dispatchCalls).toHaveLength(1); // still just the one signed snapshot
	});

	it('a permanently rejected key write does not cache — the next call is a genuine, allowed retry', async () => {
		const store = useDialogsStore();

		const first = store.initDialogKeys(PEER_HASH);
		await new Promise((r) => setTimeout(r, 10));
		pendingHandles[0].resolveAcceptance({ kind: 'rejected', error: 'validation_failed' });

		await expect(first).rejects.toThrow(/not accepted/);
		expect(dispatchCalls).toHaveLength(1);

		const retry = store.initDialogKeys(PEER_HASH);
		await new Promise((r) => setTimeout(r, 10));
		expect(dispatchCalls).toHaveLength(2);
		pendingHandles[1].resolveAcceptance({ kind: 'accepted' });
		await expect(retry).resolves.toBe(DIALOG_HASH);
	});
});

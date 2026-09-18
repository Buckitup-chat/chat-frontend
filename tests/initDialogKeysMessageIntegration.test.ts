import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { signFields, toBase64 } from '@/lib/pq/signature';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setOwnObservedTailsStorageForTests } from '@/lib/data/ownObservedTails';
import {
	_setStorageForTests, _setLeaderForTests, stopDrainLoop,
	pendingEntries, quarantinedEntries, startLeaderElection, stopLeaderElection,
} from '@/lib/data/outbox';

const makeIdentity = (seed: number) => {
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
		sign_b64: null as string | null,
	};
	card.sign_b64 = signFields(card, sign.secretKey);
	return { sign, userHash, card };
};

const myIdentity = makeIdentity(1);
const peerIdentity = makeIdentity(2);
const MY_HASH = myIdentity.userHash;
const PEER_HASH = peerIdentity.userHash;
const DIALOG_HASH = 'di_' + '3'.repeat(128);
const SKEY = new Uint8Array(32).fill(7);

const makeCollection = (rows: Record<string, unknown> = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key: string) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
});

let collections: { cards: ReturnType<typeof makeCollection>; dialog: Record<string, ReturnType<typeof makeCollection>> };

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: MY_HASH }),
}));

vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

type Mutation = { type: string; modified?: Record<string, unknown>; changes?: Record<string, unknown>; syncMetadata: { relation: string } };
const rowOf = (m: Mutation) => (m.modified ?? m.changes)!;

let sent: Array<{ relation: string; row: Record<string, unknown> }>;
let rejectKeyPermanently: boolean;
vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string): Mutation =>
			type === 'insert'
				? { type, modified: row, syncMetadata: { relation } }
				: { type, changes: row, syncMetadata: { relation } },
		ingestWithAuthEach: async (mutations: Mutation[]) => {
			const m = mutations[0];
			const relation = m.syncMetadata.relation;
			if (relation === 'dialog_keys' && rejectKeyPermanently) {
				return {
					status: 422,
					json: async () => ({ results: [{ index: 0, status: 'error', error: 'validation_failed', details: {} }] }),
				} as unknown as Response;
			}
			sent.push({ relation, row: rowOf(m) });
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		},
	},
}));

vi.mock('@/lib/data/intents', () => {
	const store = new Map<string, { id: string; userHash: string; relation: string; intent: unknown }>();
	let seq = 0;
	return {
		enqueueIntent: async (intent: unknown, userHash: string, relation: string) => {
			const id = `test-intent-${seq++}`;
			store.set(id, { id, userHash, relation, intent });
			return id;
		},
		updateIntent: async (id: string, intent: unknown) => {
			const existing = store.get(id);
			if (!existing) return false;
			store.set(id, { ...existing, intent });
			return true;
		},
		resolveIntent: async () => true,
		getIntent: async (id: string) => store.get(id) ?? null,
	};
});

vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s: string) => (s ? new Uint8Array([1, 2, 3]) : null),
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
		encryptContent: async (_k: unknown, text: string) => `enc(${text})`,
	},
}));

const { useDialogsStore } = await import('@/store/dialogs.store');
const { drainPendingWrites } = await import('@/lib/data/ingest');

const flush = async () => {
	for (let i = 0; i < 10; i++) {
		for (let j = 0; j < 20; j++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	}
};

const makeMemoryStore = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

beforeEach(() => {
	setActivePinia(createPinia());
	stopLeaderElection();
	startLeaderElection(MY_HASH, () => {});
	sent = [];
	rejectKeyPermanently = false;
	_setAcceptedSnapshotStorageForTests(makeMemoryStore());
	_setStorageForTests(makeMemoryStore());
	_setOwnObservedTailsStorageForTests(makeMemoryStore());
	collections = {
		cards: makeCollection({ [MY_HASH]: myIdentity.card, [PEER_HASH]: peerIdentity.card }),
		dialog: {
			// Deliberately never echoed — the point of this suite.
			keys: makeCollection(),
			messages: makeCollection(),
			reactions: makeCollection(),
			receipts: makeCollection(),
			versions: makeCollection(),
		},
	};
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
});

describe('initDialogKeys through the real production path (sendMessage, L17-01/R4)', () => {
	it('two messages sent before key acceptance share one durable dialog_keys snapshot; neither reaches transport until it is accepted, and the key is sent exactly once', async () => {
		_setLeaderForTests(false); // follower — nothing reaches transport on its own

		const statuses1: unknown[] = [];
		const statuses2: unknown[] = [];
		const store = useDialogsStore();

		await store.sendMessage(PEER_HASH, 'hello', (s: unknown) => statuses1.push(s));
		await flush();
		await store.sendMessage(PEER_HASH, 'world', (s: unknown) => statuses2.push(s));
		await flush();

		expect(sent).toHaveLength(0); // still follower — nothing dispatched yet

		const pendingBefore = await pendingEntries(MY_HASH);
		const keyEntriesBefore = pendingBefore.filter((e) => e.relation === 'dialog_keys');
		expect(keyEntriesBefore).toHaveLength(1); // one durable snapshot for both sends
		expect(pendingBefore.filter((e) => e.relation === 'dialog_messages')).toHaveLength(0);

		_setLeaderForTests(true);
		drainPendingWrites(MY_HASH, SKEY);
		await vi.waitFor(() => expect(sent.filter((s) => s.relation === 'dialog_messages')).toHaveLength(2));

		expect(sent.filter((s) => s.relation === 'dialog_keys')).toHaveLength(1);
		const messageEntries = (await pendingEntries(MY_HASH)).filter((e) => e.relation === 'dialog_messages');
		expect(messageEntries.every((e) => !e.dependsOn?.length)).toBe(true); // no dependsOn on an already-accepted marker
		await flush();
		expect(statuses1).toContain('synced');
		expect(statuses2).toContain('synced');
	});

	it('a permanently rejected key write is never cached as success — no message is ever dispatched for it', async () => {
		_setLeaderForTests(true);
		rejectKeyPermanently = true;

		const statuses: [unknown, unknown][] = [];
		const store = useDialogsStore();
		await store.sendMessage(PEER_HASH, 'hello', (s: unknown, cause: unknown) => statuses.push([s, cause]));
		await flush();

		expect(sent.filter((s) => s.relation === 'dialog_messages')).toHaveLength(0);
		expect(sent.filter((s) => s.relation === 'dialog_keys')).toHaveLength(0); // rejected responses are not "sent"
		const quarantined = await quarantinedEntries(MY_HASH);
		expect(quarantined.filter((e) => e.relation === 'dialog_keys')).toHaveLength(1);

		const pending = await pendingEntries(MY_HASH);
		expect(pending.filter((e) => e.relation === 'dialog_messages')).toHaveLength(0);
		expect(statuses.some(([s]) => s === 'error')).toBe(true);
	});
});

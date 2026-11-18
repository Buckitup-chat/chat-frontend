import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useMemoryLocalStore } from './helpers/dialogKeyPublished';
import { setActivePinia, createPinia } from 'pinia';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { signFields, toBase64, fromBase64 } from '@buckitup/pq-client/signature';
import { signRow } from '@buckitup/pq-client/rows';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setOwnObservedTailsStorageForTests } from '@/lib/data/ownObservedTails';
import { _setProjectionStorageForTests } from '@/lib/data/messageProjections';
import { _setStorageForTests, _setLeaderForTests, stopDrainLoop, quarantinedEntries, startLeaderElection, stopLeaderElection } from '@/lib/data/outbox';

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
	return { sign, kem, userHash, card };
};

const me = makeIdentity(1);
const peer = makeIdentity(2);
const MY_HASH = me.userHash;
const PEER_HASH = peer.userHash;
const DIALOG_HASH = 'di_' + '4'.repeat(128);
const KEY_ID = `${DIALOG_HASH}|${MY_HASH}`;

const makeCollection = () => ({
	rows: new Map<string, unknown>(),
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

const server = {
	keys: new Map<string, Record<string, unknown>>(),
	messages: [] as Record<string, unknown>[],
	keyRequests: [] as Array<{ type: string; row: Record<string, unknown> }>,
};

const keyResult = (m: Mutation, index: number) => {
	const row = (m.modified ?? m.changes)!;
	server.keyRequests.push({ type: m.type, row });
	const id = `${row.dialog_hash}|${row.sender_hash}`;
	const stored = server.keys.get(id);
	if (m.type === 'insert' && stored) {
		return { status: 200, result: { index, status: 'exists', conflicted: stored.sign_b64 !== row.sign_b64 } };
	}
	if (m.type === 'update' && stored && Number(row.owner_timestamp) <= Number(stored.owner_timestamp)) {
		return { status: 422, result: { index, status: 'error', error: 'validation_failed', details: { owner_timestamp: ['timestamp not newer'] } } };
	}
	server.keys.set(id, row);
	return { status: 200, result: { index, status: 'ok', txid: 200 } };
};

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: Mutation[]) => {
			let status = 200;
			const results = mutations.map((m, index) => {
				if (m.syncMetadata.relation === 'dialog_keys') {
					const outcome = keyResult(m, index);
					status = Math.max(status, outcome.status);
					return outcome.result;
				}
				if (m.syncMetadata.relation === 'dialog_messages') server.messages.push((m.modified ?? m.changes)!);
				return { index, status: 'ok', txid: 100 + index };
			});
			return { status, json: async () => ({ results }) } as unknown as Response;
		},
	},
}));

vi.mock('@/lib/data/intents', () => {
	const store = new Map<string, { id: string; userHash: string; relation: string; intent: unknown }>();
	let seq = 0;
	return {
		onIntentChange: () => () => {},
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
		intentsOf: async (userHash: string) => ({ entries: [...store.values()].filter((e) => e.userHash === userHash), issues: [] }),
	};
});

vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s: string) => (s ? fromBase64(s) : null),
}));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => ({ sign_skey: toBase64(me.sign.secretKey), crypt_skey: toBase64(me.kem.secretKey) }),
		}),
	},
}));

vi.mock('@buckitup/pq-client/dialogs', async (importOriginal) => ({
	...(await importOriginal<typeof import('@buckitup/pq-client/dialogs')>()),
	dialogHash: () => DIALOG_HASH,
}));

const { useDialogsStore } = await import('@/store/dialogs.store');
const { drainPendingWrites } = await import('@/lib/data/ingest');
const { kvGet } = await import('@/lib/data/localStore');
const { wrapSenderMsgKey, deriveSenderMsgKey } = await import('@buckitup/pq-client/dialogs');

const PUBLISHED_HERE = `dialog-key-published-here:${MY_HASH}|${DIALOG_HASH}`;

const memoryStore = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const firstDeviceKeyRow = async (ownerTimestamp: number) => {
	const senderMsgKey = deriveSenderMsgKey(me.sign.secretKey, me.kem.secretKey, PEER_HASH);
	const wrapped = await wrapSenderMsgKey(senderMsgKey, peer.kem.publicKey);
	return signRow('dialog_keys', {
		dialog_hash: DIALOG_HASH,
		sender_hash: MY_HASH,
		peer_hash: PEER_HASH,
		...wrapped,
		owner_timestamp: ownerTimestamp,
		deleted_flag: false,
	}, me.sign.secretKey);
};

const send = async (text: string) => {
	const statuses: unknown[] = [];
	await useDialogsStore().sendMessage(PEER_HASH, text, (s: unknown) => statuses.push(s));
	drainPendingWrites(MY_HASH, me.sign.secretKey);
	await vi.waitFor(() => expect(statuses.some((s) => s === 'synced' || s === 'error')).toBe(true), { timeout: 10_000 });
	return statuses;
};

const reload = () => {
	setActivePinia(createPinia());
	stopLeaderElection();
	startLeaderElection(MY_HASH, () => {});
	_setLeaderForTests(true);
};

beforeEach(async () => {
	await useMemoryLocalStore();
	_setAcceptedSnapshotStorageForTests(memoryStore());
	_setStorageForTests(memoryStore());
	_setProjectionStorageForTests(memoryStore());
	_setOwnObservedTailsStorageForTests(memoryStore());
	server.keys.clear();
	server.messages = [];
	server.keyRequests = [];
	collections = {
		cards: makeCollection(),
		dialog: { keys: makeCollection(), messages: makeCollection(), reactions: makeCollection(), receipts: makeCollection(), versions: makeCollection() },
	};
	collections.cards.rows.set(MY_HASH, me.card);
	collections.cards.rows.set(PEER_HASH, peer.card);
	reload();
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
});

describe('a second device of the account sends into a dialog whose key the first device published', () => {
	it('republishes its key once as a newer update, sends the message, and after a reload sends without touching the key', async () => {
		const published = await firstDeviceKeyRow(1_700_000_100);
		server.keys.set(KEY_ID, published);
		collections.dialog.keys.rows.set(KEY_ID, published);

		expect(await send('from the second device')).toContain('synced');
		expect(server.keyRequests).toHaveLength(1);
		expect(server.keyRequests[0].type).toBe('update');
		expect(Number(server.keyRequests[0].row.owner_timestamp)).toBeGreaterThan(1_700_000_100);
		expect(server.messages).toHaveLength(1);
		expect(await kvGet(PUBLISHED_HERE)).toBe(true);

		collections.dialog.keys.rows.set(KEY_ID, server.keys.get(KEY_ID));
		reload();

		expect(await send('after a reload')).toContain('synced');
		expect(server.keyRequests).toHaveLength(1);
		expect(server.messages).toHaveLength(2);
	});

	it('an insert answered with exists, before the first device\'s key reached this view, fails the send once and does not block the next one', async () => {
		server.keys.set(KEY_ID, await firstDeviceKeyRow(1_700_000_100));

		expect(await send('before the key row arrived')).toContain('error');
		expect(server.keyRequests.map((r) => r.type)).toEqual(['insert']);
		expect(server.messages).toHaveLength(0);
		expect((await quarantinedEntries(MY_HASH)).filter((e) => e.relation === 'dialog_keys')).toHaveLength(1);

		collections.dialog.keys.rows.set(KEY_ID, server.keys.get(KEY_ID));

		expect(await send('once it arrived')).toContain('synced');
		expect(server.keyRequests.map((r) => r.type)).toEqual(['insert', 'update']);
		expect(server.messages).toHaveLength(1);
		expect(await kvGet(PUBLISHED_HERE)).toBe(true);
	});
});

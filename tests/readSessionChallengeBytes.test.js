import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setIntentStorageForTests } from '@/lib/data/intents';
import { _setStorageForTests as setOutboxStorage } from '@/lib/data/outbox';

let vaults;
let rawStore;

const makeVault = (id) => {
	const data = new Map();
	return {
		id,
		async set(k, v) { data.set(k, v); },
		async get(k) { return data.get(k); },
	};
};

vi.mock('@lo-fi/local-vault', () => ({
	connect: async ({ vaultID, addNewVault }) => {
		if (addNewVault) {
			const id = `vault-${vaults.size + 1}`;
			vaults.set(id, makeVault(id));
			return vaults.get(id);
		}
		return vaults.get(vaultID);
	},
	rawStorage: () => rawStore,
}));
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));

const cardRows = new Map();
vi.mock('@/lib/data/collections', () => ({
	resetUserStorageCollection: () => {},
	getUserCardsCollection: () => ({
		async preload() {},
		get: (k) => cardRows.get(k),
		get toArray() { return [...cardRows.values()]; },
	}),
}));

vi.mock('@/lib/data/ingest', async () => {
	const actual = await vi.importActual('@/lib/data/ingest');
	return {
		...actual,
		sendMutationsAndAwaitShape: async (mutations) => {
			for (const m of mutations) {
				const row = m.modified ?? m.changes;
				if (m.syncMetadata?.relation === 'user_cards') cardRows.set(row.user_hash, { ...cardRows.get(row.user_hash), ...row });
			}
			return { outboxId: 'test-outbox-id', phase: 'accepted', result: { txids: [] }, acceptance: Promise.resolve({ kind: 'accepted' }) };
		},
		drainPendingWrites: async () => {},
		stopDrainLoop: () => {},
	};
});

vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	putStorageRow: async () => ({}),
	putStorageJsonPatch: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	saveStorageJsonPatch: async () => 'synced',
}));

const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');
const { openSession, clearSessions, bearerFor } = await import('@/lib/data/readSession');

const memoryStore = () => ({
	_map: new Map(),
	async get(k) { return this._map.get(k) ?? null; },
	async set(k, v) { this._map.set(k, v); },
	async delete(k) { this._map.delete(k); },
	async keys() { return [...this._map.keys()]; },
	async clear() { this._map.clear(); },
});

const b64ToBytes = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));

beforeEach(() => {
	vaults = new Map();
	cardRows.clear();
	_setIntentStorageForTests(memoryStore());
	setOutboxStorage(memoryStore());
	_setAcceptedSnapshotStorageForTests(memoryStore());
	const store = new Map();
	rawStore = {
		async get(k) { return store.get(k); },
		async set(k, v) { store.set(k, v); },
		async remove(k) { store.delete(k); },
	};
	EncryptionManagerPQ.instance = null;
	clearSessions();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('read_session PoP signs the exact challenge bytes the backend verifies', () => {
	it('signature verifies against TextEncoder().encode(challenge), not atob(challenge)', async () => {
		const em = EncryptionManagerPQ.getInstance();
		const identity = await em.createUserVault({ name: 'Reader' });
		expect(em.isAuth).toBe(true);
		const signPkey = b64ToBytes(identity.sign_pkey);

		const challenge = randomBytes(32).toString('hex');
		expect(challenge).toMatch(/^[0-9a-f]{64}$/);

		let submitted = null;
		vi.stubGlobal('fetch', async (input, init) => {
			const url = String(input);
			if (url.endsWith('/challenge')) {
				return new Response(JSON.stringify({ challenge_id: 'cid-1', challenge, expires_in: 60 }), { status: 200 });
			}
			if (url.endsWith('/read_session')) {
				submitted = JSON.parse(init.body);
				return new Response(JSON.stringify({ token: 'tok', shape: submitted.shape, expires_in: 300 }), { status: 200 });
			}
			throw new Error(`unexpected fetch ${url}`);
		});

		const token = await openSession('user_card');
		expect(token).toBe('tok');
		expect(submitted).not.toBeNull();
		expect(submitted.user_hash).toBe(identity.user_hash);
		expect(submitted.challenge_id).toBe('cid-1');

		const signature = b64ToBytes(submitted.signature);
		const utf8Bytes = new TextEncoder().encode(challenge);
		const base64DecodedBytes = Uint8Array.from(atob(challenge), (c) => c.charCodeAt(0));

		const verifiesUtf8 = ml_dsa87.verify(signature, utf8Bytes, signPkey);
		const verifiesBase64Decoded = ml_dsa87.verify(signature, base64DecodedBytes, signPkey);

		expect(signature.length).toBe(4627);
		expect(verifiesBase64Decoded).toBe(false);
		expect(verifiesUtf8).toBe(true);
	});
});

describe('logout clears read-session tokens', () => {
	it('EncryptionManagerPQ.logout() drops every token the session opened', async () => {
		const em = EncryptionManagerPQ.getInstance();
		await em.createUserVault({ name: 'Reader' });
		let n = 0;
		vi.stubGlobal('fetch', async (input, init) => {
			const url = String(input);
			if (url.endsWith('/challenge')) {
				return new Response(JSON.stringify({ challenge_id: `cid-${n}`, challenge: randomBytes(32).toString('hex'), expires_in: 60 }), { status: 200 });
			}
			if (url.endsWith('/read_session')) {
				const { shape } = JSON.parse(init.body);
				return new Response(JSON.stringify({ token: `tok-${shape}-${++n}`, shape, expires_in: 300 }), { status: 200 });
			}
			throw new Error(`unexpected fetch ${url}`);
		});

		await openSession('user_card');
		await openSession('file_chunk');
		expect(bearerFor('user_card')).toBe('Bearer tok-user_card-1');
		expect(bearerFor('file_chunk')).toBe('Bearer tok-file_chunk-2');

		await em.logout();

		expect(em.isAuth).toBe(false);
		expect(bearerFor('user_card')).toBe('');
		expect(bearerFor('file_chunk')).toBe('');
	});
});

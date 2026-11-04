import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, get, set } from 'idb-keyval';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repairVaultStore, STARTUP_WAIT_MS } from '@/lib/vaultStore';

// #51: on one browser profile 'keyval-store' existed without its 'keyval'
// store, and every vault access threw NotFoundError.

// EncryptionManagerPQ reads through rawStorage('idb'), which is
// @byojs/storage's idb adapter (the real one here). Only connect() needs
// WebAuthn, and nothing here reaches it. The user cards shape is not part
// of local startup.
vi.mock('@lo-fi/local-vault', async () => {
	const idb = (await import('@byojs/storage/idb')).default;
	return {
		rawStorage: () => idb,
		connect: async () => {
			throw new Error('connect() must not be reached');
		},
	};
});
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => ({ toArray: [], async preload() {}, subscribeChanges: () => ({ unsubscribe() {} }) }),
}));
vi.mock('@/lib/data/attach', () => ({ preloadWithRetry: async () => false }));

const openDb = (stores: string[] = [], version?: number) =>
	new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open('keyval-store', version);
		req.onupgradeneeded = () => stores.forEach((s) => req.result.createObjectStore(s));
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

const createDb = async (stores: string[]) => (await openDb(stores, 1)).close();

// What the vault libraries read and write through: idb-keyval's default
// store is this same call, made once per page.
const vaultStorage = () => {
	const store = createStore('keyval-store', 'keyval');
	return { get: (k: string) => get(k, store), set: (k: string, v: unknown) => set(k, v, store) };
};

const versionOf = async () => (await indexedDB.databases()).find((d) => d.name === 'keyval-store')?.version;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
});

describe('repairVaultStore', () => {
	it('creates the missing store, so the vault storage works again', async () => {
		await createDb(['other']);

		await repairVaultStore();

		const storage = vaultStorage();
		await storage.set('pq-vaults-registry', [{ user_hash: 'u1' }]);
		expect(await storage.get('pq-vaults-registry')).toEqual([{ user_hash: 'u1' }]);
	});

	it('leaves a healthy database as it is', async () => {
		const storage = vaultStorage();
		await storage.set('pq-vaults-registry', [{ user_hash: 'u1' }]);

		await repairVaultStore();

		expect(await versionOf()).toBe(1);
		expect(await storage.get('pq-vaults-registry')).toEqual([{ user_hash: 'u1' }]);
	});

	it('creates the database with its store on a fresh profile, as idb-keyval would', async () => {
		await repairVaultStore();

		expect(await versionOf()).toBe(1);
		const storage = vaultStorage();
		await storage.set('k', 'v');
		expect(await storage.get('k')).toBe('v');
	});

	it('does not hold startup while another tab has the database open; the store appears once it closes', async () => {
		await createDb(['other']);
		const otherTab = await openDb();

		expect(await repairVaultStore()).toBe(true);

		const storage = vaultStorage();
		const read = storage.get('pq-vaults-registry');
		otherTab.close();
		expect(await read).toBeUndefined();
	});

	it('holds startup no longer than its limit while an earlier repair waits for another tab', async () => {
		await createDb(['other']);
		const otherTab = await openDb();
		await repairVaultStore();

		vi.useFakeTimers({ toFake: ['setTimeout'] });
		try {
			let started = false;
			void repairVaultStore().then(() => (started = true));
			await vi.advanceTimersByTimeAsync(STARTUP_WAIT_MS - 1);
			expect(started).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(started).toBe(true);
		} finally {
			vi.useRealTimers();
		}

		otherTab.close();
		expect(await vaultStorage().get('pq-vaults-registry')).toBeUndefined();
	});
});

describe('local startup', () => {
	// App start, Create and Restore all run it first.
	it('completes on a broken vault database, with no accounts listed', async () => {
		await createDb(['other']);
		setActivePinia(createPinia());
		const { userPQStore } = await import('@/store/userPQ.store');
		const store = userPQStore();

		await expect(store.initialize()).resolves.toBeUndefined();
		expect(store.isInitialized).toBe(true);
		expect(store.myLocalUsers).toEqual([]);
	});
});

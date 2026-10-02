import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexedDBAdapter } from '@tanstack/offline-transactions';
import { IndexedDbStore, StorageReadError } from '@/lib/data/indexedDbStore';
import { createSecureStore, deriveLocalStorageKey, DecryptFailedError } from '@/lib/data/secureStore';

const DB = 'buckitup-strict-store-test';

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const failingOpen = () => {
	vi.stubGlobal('indexedDB', {
		open: () => {
			const request = {} as IDBOpenDBRequest & { error: DOMException };
			queueMicrotask(() => {
				Object.defineProperty(request, 'error', { value: new DOMException('open refused', 'UnknownError') });
				request.onerror?.(new Event('error'));
			});
			return request;
		},
	});
	return () => vi.unstubAllGlobals();
};

const abortNext = (method: 'get' | 'getAllKeys' | 'put' | 'delete' | 'clear') => {
	const proto = IDBObjectStore.prototype as unknown as Record<string, (...args: unknown[]) => IDBRequest>;
	const real = proto[method];
	vi.spyOn(proto, method).mockImplementationOnce(function (this: IDBObjectStore, ...args: unknown[]) {
		const request = real.apply(this, args);
		this.transaction.abort();
		return request;
	});
};

describe('IndexedDbStore: an answer only when IndexedDB gave one', () => {
	it('round-trips a value', async () => {
		const store = new IndexedDbStore(DB);
		await store.set('k', 'v');
		expect(await store.get('k')).toBe('v');
		expect(await store.keys()).toEqual(['k']);
	});

	it('a key that is not stored is null, and an empty store has no keys', async () => {
		const store = new IndexedDbStore(DB);
		expect(await store.get('absent')).toBeNull();
		expect(await store.keys()).toEqual([]);
	});

	it('delete and clear remove what they name', async () => {
		const store = new IndexedDbStore(DB);
		await store.set('a', '1');
		await store.set('b', '2');
		await store.delete('a');
		expect(await store.keys()).toEqual(['b']);
		await store.clear();
		expect(await store.keys()).toEqual([]);
	});

	it('an open that fails is a StorageReadError for get and keys, never null or []', async () => {
		const restore = failingOpen();
		const store = new IndexedDbStore(DB);
		try {
			const read = await store.get('k').catch((e: unknown) => e);
			expect(read).toBeInstanceOf(StorageReadError);
			expect(read).toMatchObject({ operation: 'get' });
			expect((read as Error).cause).toBeInstanceOf(DOMException);
			await expect(store.keys()).rejects.toMatchObject({ name: 'StorageReadError', operation: 'keys' });
		} finally {
			restore();
		}
	});

	it('no IndexedDB at all, as in Node, is a StorageReadError for get and keys, never null or []', async () => {
		const saved = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')!;
		delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
		try {
			const store = new IndexedDbStore(DB);
			const read = await store.get('k').catch((e: unknown) => e);
			expect(read).toBeInstanceOf(StorageReadError);
			expect((read as Error).cause).toBeInstanceOf(ReferenceError);
			await expect(store.keys()).rejects.toBeInstanceOf(StorageReadError);
			await expect(store.set('k', 'v')).rejects.toBeInstanceOf(ReferenceError);
		} finally {
			Object.defineProperty(globalThis, 'indexedDB', saved);
		}
	});

	it('a get whose transaction fails is a StorageReadError, not null', async () => {
		const store = new IndexedDbStore(DB);
		await store.set('k', 'v');
		abortNext('get');

		await expect(store.get('k')).rejects.toBeInstanceOf(StorageReadError);
		expect(await store.get('k')).toBe('v'); // the record was there all along
	});

	it('a get with a key IndexedDB refuses is a StorageReadError', async () => {
		const store = new IndexedDbStore(DB);
		await expect(store.get({} as unknown as string)).rejects.toBeInstanceOf(StorageReadError);
	});

	it('a keys listing whose transaction fails is a StorageReadError, not []', async () => {
		const store = new IndexedDbStore(DB);
		await store.set('k', 'v');
		abortNext('getAllKeys');

		await expect(store.keys()).rejects.toMatchObject({ name: 'StorageReadError', operation: 'keys' });
		expect(await store.keys()).toEqual(['k']);
	});

	it('set, delete and clear reject when their transaction fails, and nothing changed', async () => {
		const store = new IndexedDbStore(DB);
		await store.set('keep', 'v');

		abortNext('put');
		await expect(store.set('new', 'x')).rejects.toBeTruthy();
		abortNext('delete');
		await expect(store.delete('keep')).rejects.toBeTruthy();
		abortNext('clear');
		await expect(store.clear()).rejects.toBeTruthy();

		expect(await store.keys()).toEqual(['keep']);
	});

	it('set, delete and clear reject when the database cannot be opened', async () => {
		const restore = failingOpen();
		const store = new IndexedDbStore(DB);
		try {
			await expect(store.set('k', 'v')).rejects.toBeInstanceOf(DOMException);
			await expect(store.delete('k')).rejects.toBeInstanceOf(DOMException);
			await expect(store.clear()).rejects.toBeInstanceOf(DOMException);
		} finally {
			restore();
		}
	});

	it('a failed open is not kept: the next operation opens again', async () => {
		const restore = failingOpen();
		const store = new IndexedDbStore(DB);
		await expect(store.get('k')).rejects.toBeInstanceOf(StorageReadError);
		restore();

		await store.set('k', 'v');
		expect(await store.get('k')).toBe('v');
	});
});

describe('IndexedDbStore reads the databases the package adapter wrote', () => {
	it('records written by the old IndexedDBAdapter are read as they are, and the reverse', async () => {
		const legacy = new IndexedDBAdapter(DB);
		await legacy.set('outbox-entry', '{"id":"outbox-entry"}');
		await legacy.set('clock|user_cards|u_x', 'sealed-bytes');

		const strict = new IndexedDbStore(DB);
		expect(await strict.get('outbox-entry')).toBe('{"id":"outbox-entry"}');
		expect((await strict.keys()).sort()).toEqual(['clock|user_cards|u_x', 'outbox-entry']);

		await strict.set('written-by-strict', 'v2');
		expect(await new IndexedDBAdapter(DB).get('written-by-strict')).toBe('v2');
	});

	it('uses the same database version and object store as the package adapter', async () => {
		await new IndexedDBAdapter(DB).set('k', 'v');
		await new IndexedDbStore(DB).get('k');

		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(DB);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		expect(db.version).toBe(1);
		expect([...db.objectStoreNames]).toEqual(['transactions']);
		db.close();
	});
});

describe('the secure store over IndexedDbStore', () => {
	it('passes a StorageReadError through, never as DecryptFailedError', async () => {
		const restore = failingOpen();
		const key = await deriveLocalStorageKey(new Uint8Array(32).fill(1));
		const secure = createSecureStore(new IndexedDbStore(DB), { getKey: async () => key });
		try {
			const read = await secure.get('k').catch((e: unknown) => e);
			expect(read).toBeInstanceOf(StorageReadError);
			expect(read).not.toBeInstanceOf(DecryptFailedError);
			await expect(secure.keys()).rejects.toBeInstanceOf(StorageReadError);
		} finally {
			restore();
		}
	});
});

describe('production modules use only the strict store', () => {
	const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|js|vue)$/.test(name) ? [path] : [];
	});

	it('nothing under src imports the package IndexedDBAdapter', () => {
		const offenders = sourceFiles(join(process.cwd(), 'src')).filter((file) =>
			/import\s*\{[^}]*\bIndexedDBAdapter\b[^}]*\}\s*from\s*['"]@tanstack\/offline-transactions['"]/.test(readFileSync(file, 'utf8')));
		expect(offenders).toEqual([]);
	});
});

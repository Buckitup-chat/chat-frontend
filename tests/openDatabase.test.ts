// A connection the app keeps open must not block a delete ("Wipe all") or an
// upgrade from another tab: every store opens through openDatabase, which
// closes and forgets its connection on versionchange and opens again on the
// next use.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase } from '@/lib/data/openDatabase';

vi.mock('@/lib/data/localCrypto', async () => {
	const { deriveLocalStorageKey } = await import('@/lib/data/secureStore');
	const key = deriveLocalStorageKey(new Uint8Array(32).fill(7));
	return { getLocalStorageKey: () => key, getLocalStorageKeyFor: () => key };
});

const USER = 'u_' + 'a'.repeat(128);

/** A delete as another tab, or the wipe, issues it: 'blocked' while a connection here stays open. */
const remove = (name: string) =>
	new Promise<'done' | 'blocked'>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve('done');
		request.onblocked = () => resolve('blocked');
		request.onerror = () => reject(request.error);
	});

const names = async () => (await indexedDB.databases()).map((db) => db.name);

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('openDatabase', () => {
	const upgrade = (db: IDBDatabase) => db.createObjectStore('s');

	it('opens a database once and keeps the connection', async () => {
		const first = await openDatabase('buckitup-test', 1, upgrade);
		expect(await openDatabase('buckitup-test', 1, upgrade)).toBe(first);
		expect([...first.objectStoreNames]).toEqual(['s']);
	});

	it('lets a delete from elsewhere through, and opens again on the next call', async () => {
		const first = await openDatabase('buckitup-test', 1, upgrade);
		expect(await remove('buckitup-test')).toBe('done');
		expect(await names()).toEqual([]);

		const again = await openDatabase('buckitup-test', 1, upgrade);
		expect(again).not.toBe(first);
		expect([...again.objectStoreNames]).toEqual(['s']);
	});

	it('lets another tab upgrade the database', async () => {
		await openDatabase('buckitup-test', 1, upgrade);
		const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('buckitup-test', 2);
			request.onsuccess = () => resolve(request.result);
			request.onblocked = () => reject(new Error('blocked'));
		});
		expect(upgraded.version).toBe(2);
		upgraded.close();
	});

	it('does not keep a failed open', async () => {
		const refusing = Object.assign(Object.create(indexedDB), {
			open: () => { throw new DOMException('refused', 'UnknownError'); },
		});
		const real = indexedDB;
		vi.stubGlobal('indexedDB', refusing);
		await expect(openDatabase('buckitup-test', 1, upgrade)).rejects.toThrow('refused');
		vi.stubGlobal('indexedDB', real);
		await expect(openDatabase('buckitup-test', 1, upgrade)).resolves.toBeTruthy();
		vi.unstubAllGlobals();
	});
});

// Each store, after it has been used, as a wipe or another tab's upgrade finds it.
const stores: Array<[string, string, () => Promise<unknown>]> = [
	['the local store', 'buckitup-local-store', async () => {
		const { kvSet, kvGet } = await import('@/lib/data/localStore');
		await kvSet(`us|${USER}|1`, { v: 1 });
		return kvGet(`us|${USER}|1`);
	}],
	['the dialog cache', 'dialog-synced-cache', async () => {
		const { readDialogRow } = await import('@/lib/data/dialogCache');
		return readDialogRow('dialog_messages', 'm1');
	}],
	['the message projections', 'buckitup-message-projections', async () => {
		const { removeProjection } = await import('@/lib/data/messageProjections');
		return removeProjection('m1');
	}],
	['the user cards cache', 'user-synced-cache', async () => {
		const { readCachedCards } = await import('@/lib/data/userCardsCache');
		return readCachedCards();
	}],
	['the outbox leader lease', 'buckitup-outbox-leader-lease', async () => {
		const outbox = await import('@/lib/data/outbox');
		outbox._setActiveSessionForTests(USER);
		// No Web Locks here: leadership goes through the lease database.
		const run = await outbox.withAcquiredLeadership(USER, async () => 'ran');
		outbox._setActiveSessionForTests(null);
		return run;
	}],
];

describe.each(stores)('%s', (_label, name, use) => {
	it('closes its connection for a delete, and opens again on the next use', async () => {
		await use();
		expect(await names()).toContain(name);

		expect(await remove(name)).toBe('done');
		expect(await names()).not.toContain(name);

		await use();
		expect(await names()).toContain(name);
	});
});

describe('no store opens a database by hand', () => {
	const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|js|vue)$/.test(entry) ? [path] : [];
	});

	// The chunk cache works without its database while another tab holds an
	// older version open, and the vault repair closes its connection at once.
	it('only openDatabase, the chunk cache and the vault repair call indexedDB.open', () => {
		const src = join(process.cwd(), 'src');
		const openers = sourceFiles(src)
			.filter((file) => /\bindexedDB\.open\(|\bfactory\.open\(/.test(readFileSync(file, 'utf8')))
			.map((file) => relative(src, file))
			.sort();
		expect(openers).toEqual(['lib/data/chunkCache.ts', 'lib/data/openDatabase.ts', 'lib/vaultStore.ts']);
	});
});

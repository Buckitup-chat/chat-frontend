import { markTouched } from './readCache';
import type { UserCardRow } from './types';

const DB_NAME = 'user-synced-cache';
const DB_VERSION = 1;
const STORE = 'user_cards';
const MAIN_STORES = ['user_cards', 'user_storage'];
const TABLE = 'user_cards';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
	if (dbPromise) return dbPromise;
	if (typeof indexedDB === 'undefined') {
		dbPromise = Promise.resolve(null);
		return dbPromise;
	}
	dbPromise = new Promise((resolve) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			for (const name of MAIN_STORES) {
				if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: '__key' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => {
			console.warn('[userCardsCache] cannot open IndexedDB:', req.error);
			resolve(null);
		};
	});
	return dbPromise;
}

function run<T>(mode: 'readonly' | 'readwrite', fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
	return openDb().then((db) => {
		if (!db) return undefined;
		return new Promise<T>((resolve, reject) => {
			const tx = db.transaction(STORE, mode);
			const request = fn(tx.objectStore(STORE));
			tx.oncomplete = () => resolve(request.result);
			tx.onerror = () => reject(tx.error);
		});
	});
}

const fromDisk = ({ __key: _key, ...record }: Record<string, unknown>): UserCardRow => ({
	...record,
	...(typeof record.owner_timestamp === 'bigint' ? { owner_timestamp: Number(record.owner_timestamp) } : {}),
}) as unknown as UserCardRow;

export async function readCachedCards(): Promise<UserCardRow[]> {
	try {
		const all = (await run<Record<string, unknown>[]>('readonly', (s) => s.getAll())) ?? [];
		return all.map(fromDisk);
	} catch (e) {
		console.warn('[userCardsCache] read failed:', e);
		return [];
	}
}

export async function readCachedCard(userHash: string): Promise<UserCardRow | null> {
	try {
		const record = await run<Record<string, unknown> | undefined>('readonly', (s) => s.get(userHash));
		return record ? fromDisk(record) : null;
	} catch {
		return null;
	}
}

interface MirrorableCollection {
	subscribeChanges(
		callback: (changes: Array<{ key: unknown; value?: Record<string, unknown>; type: string }>) => void,
		options?: { includeInitialState?: boolean }
	): { unsubscribe(): void };
}

export function mirrorUserCards(collection: MirrorableCollection): () => void {
	if (typeof collection?.subscribeChanges !== 'function') return () => {};
	const sub = collection.subscribeChanges(
		(changes) => {
			for (const change of changes) {
				const key = String(change.key);
				markTouched(TABLE, key);
				const write = change.type === 'delete'
					? run('readwrite', (s) => s.delete(key))
					: change.value ? run('readwrite', (s) => s.put({ ...change.value, __key: key })) : null;
				write?.catch((e) => console.warn(`[userCardsCache] could not persist ${key}:`, e));
			}
		},
		{ includeInitialState: true }
	);
	return () => sub.unsubscribe();
}

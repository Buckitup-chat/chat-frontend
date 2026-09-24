import { markTouched, isTouched } from './readCache';

const DB_NAME = 'dialog-synced-cache';
const DB_VERSION = 2;

export const DIALOG_CACHE_TABLES = [
	'dialog_keys',
	'dialog_messages',
	'dialog_messages_versions',
	'dialog_message_reactions',
	'dialog_message_receipts',
] as const;
export type DialogCacheTable = (typeof DIALOG_CACHE_TABLES)[number];

type Row = Record<string, unknown>;

const mainKeyOf: Record<DialogCacheTable, (r: Row) => string> = {
	dialog_keys: (r) => `${r.dialog_hash}:${r.sender_hash}`,
	dialog_messages: (r) => String(r.message_id),
	dialog_messages_versions: (r) => `${r.message_id}:${r.sign_hash}`,
	dialog_message_reactions: (r) => String(r.reaction_hash),
	dialog_message_receipts: (r) => String(r.receipt_hash),
};
const mainKeyFromCollectionKey = (table: DialogCacheTable, key: string): string =>
	table === 'dialog_keys' || table === 'dialog_messages_versions' ? key.replace('|', ':') : key;

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
			for (const table of DIALOG_CACHE_TABLES) {
				if (!req.result.objectStoreNames.contains(table)) req.result.createObjectStore(table, { keyPath: '__key' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => {
			console.warn('[dialogCache] cannot open IndexedDB:', req.error);
			resolve(null);
		};
	});
	return dbPromise;
}

function run<T>(table: DialogCacheTable, mode: 'readonly' | 'readwrite', fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
	return openDb().then((db) => {
		if (!db) return undefined;
		return new Promise<T | undefined>((resolve, reject) => {
			const tx = db.transaction(table, mode);
			const request = fn(tx.objectStore(table));
			tx.oncomplete = () => resolve(request ? request.result : undefined);
			tx.onerror = () => reject(tx.error);
		});
	});
}

interface DialogCacheStore {
	getAll(table: DialogCacheTable): Promise<Row[]>;
	get(table: DialogCacheTable, key: string): Promise<Row | undefined>;
	put(table: DialogCacheTable, record: Row): Promise<void>;
	delete(table: DialogCacheTable, key: string): Promise<void>;
	clear(table: DialogCacheTable): Promise<void>;
}
const indexedDbStore: DialogCacheStore = {
	getAll: async (table) => (await run<Row[]>(table, 'readonly', (s) => s.getAll())) ?? [],
	get: (table, key) => run<Row | undefined>(table, 'readonly', (s) => s.get(key)),
	put: async (table, record) => { await run(table, 'readwrite', (s) => s.put(record)); },
	delete: async (table, key) => { await run(table, 'readwrite', (s) => s.delete(key)); },
	clear: async (table) => { await run(table, 'readwrite', (s) => s.clear()); },
};
let store: DialogCacheStore = indexedDbStore;

export function _setDialogCacheStoreForTests(adapter: DialogCacheStore | null): void {
	store = adapter ?? indexedDbStore;
}

const CACHE_METADATA = ['__key', '__awaitingEcho', '__ignoreEchoSignHash'];
const fromDisk = (record: Row): Row => {
	const row = { ...record };
	for (const field of CACHE_METADATA) delete row[field];
	if (typeof row.owner_timestamp === 'bigint') row.owner_timestamp = Number(row.owner_timestamp);
	return row;
};

export async function readDialogRows(table: DialogCacheTable, dialogHash: string): Promise<Row[]> {
	try {
		const all = await store.getAll(table);
		return all.map(fromDisk).filter((r) => r.dialog_hash === dialogHash);
	} catch (e) {
		console.warn(`[dialogCache] read of ${table} failed:`, e);
		return [];
	}
}

export async function readDialogRow(table: DialogCacheTable, collectionKey: string): Promise<Row | null> {
	if (isTouched(table, collectionKey)) return null;
	try {
		const record = await store.get(table, mainKeyFromCollectionKey(table, collectionKey));
		return record ? fromDisk(record) : null;
	} catch {
		return null;
	}
}

interface MirrorableCollection {
	subscribeChanges(
		callback: (changes: Array<{ key: unknown; value?: Row; type: string }>) => void,
		options?: { includeInitialState?: boolean }
	): { unsubscribe(): void };
}

export function mirrorDialogTable(collection: MirrorableCollection, table: DialogCacheTable): () => void {
	if (typeof collection?.subscribeChanges !== 'function') return () => {};
	const sub = collection.subscribeChanges(
		(changes) => {
			for (const change of changes) {
				const key = String(change.key);
				markTouched(table, key);
				const write = change.type === 'delete'
					? store.delete(table, mainKeyFromCollectionKey(table, key))
					: change.value
						? store.put(table, { ...change.value, __awaitingEcho: false, __key: mainKeyOf[table](change.value!) })
						: null;
				write?.catch((e) => console.warn(`[dialogCache] could not persist ${table}:${key}:`, e));
			}
		},
		{ includeInitialState: true }
	);
	return () => sub.unsubscribe();
}

export async function clearDialogCache(): Promise<void> {
	for (const table of DIALOG_CACHE_TABLES) {
		await store.clear(table).catch(() => {});
	}
}

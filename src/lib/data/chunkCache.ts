// Persistent cache of ENCRYPTED chunks, keyed by (fileId, index).
//
// What goes to disk is exactly what the device already stores — ciphertext —
// so this adds zero secrets to the client, consistent with the persistence
// rule the shape store follows (persistence.ts: cleartext SQLite is fine
// because row contents are E2E-encrypted before they get there). Decrypted
// bytes stay session-only in the in-memory media cache.
//
// What it buys: chunks are immutable and content-addressed, so a reload —
// or no uplink at all — reassembles an attachment from disk instead of
// re-downloading it. The uploader seeds its own chunks at send time, so a
// sender never re-downloads what it just encrypted.
//
// IndexedDB, budgeted, LRU by last use. Everything degrades to a no-op where
// IndexedDB is missing (node, some private windows): the cache is an
// optimization, never a dependency.

const DB_NAME = 'buckitup-chunks';
const STORE = 'chunks';
const BUDGET_BYTES = 512 * 1024 * 1024;

interface ChunkRecord {
	key: string; // `${fileId}:${index}`
	fileId: string;
	bytes: ArrayBuffer;
	size: number;
	lastUsed: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

const openDb = (): Promise<IDBDatabase | null> => {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve) => {
		if (typeof indexedDB === 'undefined') return resolve(null);
		try {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => {
				const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
				store.createIndex('lastUsed', 'lastUsed');
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	return dbPromise;
};

const tx = (db: IDBDatabase, mode: globalThis.IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);

const reqAsPromise = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

const chunkKey = (fileId: string, index: number) => `${fileId}:${index}`;

export const getCachedChunk = async (fileId: string, index: number): Promise<Uint8Array | null> => {
	const db = await openDb();
	if (!db) return null;
	try {
		const rec = await reqAsPromise<ChunkRecord | undefined>(tx(db, 'readonly').get(chunkKey(fileId, index)));
		if (!rec) return null;
		// LRU touch; fire-and-forget, a failed touch only skews eviction order
		tx(db, 'readwrite').put({ ...rec, lastUsed: Date.now() });
		return new Uint8Array(rec.bytes);
	} catch {
		return null;
	}
};

export const putCachedChunk = async (fileId: string, index: number, bytes: Uint8Array): Promise<void> => {
	const db = await openDb();
	if (!db) return;
	try {
		const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		await reqAsPromise(tx(db, 'readwrite').put({
			key: chunkKey(fileId, index),
			fileId,
			bytes: buf,
			size: bytes.byteLength,
			lastUsed: Date.now(),
		} satisfies ChunkRecord));
		await evictOverBudget(db);
	} catch {
		/* cache full or blocked — the network path still works */
	}
};

/** Oldest-used chunks go first once the byte budget is crossed. */
const evictOverBudget = async (db: IDBDatabase): Promise<void> => {
	const all = await reqAsPromise<ChunkRecord[]>(tx(db, 'readonly').getAll());
	let total = all.reduce((n, r) => n + r.size, 0);
	if (total <= BUDGET_BYTES) return;
	const byAge = [...all].sort((a, b) => a.lastUsed - b.lastUsed);
	const store = tx(db, 'readwrite');
	for (const rec of byAge) {
		if (total <= BUDGET_BYTES) break;
		store.delete(rec.key);
		total -= rec.size;
	}
};

/** Ask the browser not to evict our origin storage under pressure. */
export const requestPersistentStorage = (): void => {
	try {
		navigator.storage?.persist?.().catch(() => {});
	} catch {
		/* optional nicety */
	}
};

/** Test seam: forget the open database so a fresh fake can be installed. */
export const __resetChunkCacheForTests = (): void => {
	dbPromise = null;
};

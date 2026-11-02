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
//
// A chunk can also be pinned: an account on this device keeps the file it
// belongs to (keptFiles.ts). Each record lists the accounts pinning it in the
// clear (local metadata need not be hidden, docs/invariants.md §1), so an
// account's pins can be dropped without its key when it leaves the device.
// A pinned chunk stays while any account pins it; eviction skips it, and a
// failed pin is an error for the caller, not a swallowed cache miss.

const DB_NAME = 'buckitup-chunks';
const STORE = 'chunks';
const BUDGET_BYTES = 512 * 1024 * 1024;

interface ChunkRecord {
	key: string; // `${fileId}:${index}`
	fileId: string;
	bytes: ArrayBuffer;
	/** The chunk's signed data_hash, checked when it was stored: a read compares strings, not SHA3 over 4 MiB. */
	dataHash: string;
	size: number;
	lastUsed: number;
	/** Accounts on this device that keep the file this chunk belongs to (keptFiles.ts). Absent or empty: plain cache. */
	pins?: string[];
}

const isPinned = (rec: ChunkRecord): boolean => !!rec.pins?.length;

let dbPromise: Promise<IDBDatabase | null> | null = null;
let budgetBytes = BUDGET_BYTES;

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

/**
 * One transaction, settled when it commits. `body` issues its requests from
 * request callbacks, so every read and the write it decides stay inside the
 * same transaction — another tab's pin cannot land between them. A failed
 * request aborts the transaction and the promise rejects with the
 * transaction's error: a full disk arrives here as QuotaExceededError.
 */
const inTx = <T>(db: IDBDatabase, mode: globalThis.IDBTransactionMode, body: (store: IDBObjectStore, settle: (value: T) => void, fail: (e: Error) => void) => void): Promise<T> =>
	new Promise((resolve, reject) => {
		let result: T | undefined;
		let failure: Error | null = null;
		let tx: IDBTransaction;
		try {
			tx = db.transaction(STORE, mode);
		} catch (e) {
			reject(e);
			return;
		}
		tx.oncomplete = () => (failure ? reject(failure) : resolve(result as T));
		tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('The chunk store transaction was aborted', 'AbortError'));
		const fail = (e: Error) => {
			failure = e;
			try { tx.abort(); } catch { /* already finished */ }
		};
		try {
			body(tx.objectStore(STORE), (value) => { result = value; }, fail);
		} catch (e) {
			fail(e as Error);
		}
	});

const chunkKey = (fileId: string, index: number) => `${fileId}:${index}`;
/** Every chunk key of one file: `${fileId}:` followed by an index. */
const fileRange = (fileId: string) => IDBKeyRange.bound(`${fileId}:`, `${fileId}:￿`);

const copyOf = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** The cached chunk if it is the one with `dataHash`; anything else reads as absent and is overwritten by the next store. */
export const getCachedChunk = async (fileId: string, index: number, dataHash: string): Promise<Uint8Array | null> => {
	const db = await openDb();
	if (!db) return null;
	try {
		const rec = await inTx<ChunkRecord | undefined>(db, 'readonly', (store, settle) => {
			const req = store.get(chunkKey(fileId, index));
			req.onsuccess = () => settle(req.result as ChunkRecord | undefined);
		});
		if (!rec || rec.dataHash !== dataHash) return null;
		// LRU touch; fire-and-forget, a failed touch only skews eviction order.
		// It re-reads the record in its own transaction, so a pin added since
		// the read above is kept.
		inTx<void>(db, 'readwrite', (store) => {
			const req = store.get(rec.key);
			req.onsuccess = () => {
				const cur = req.result as ChunkRecord | undefined;
				if (cur && cur.dataHash === dataHash) store.put({ ...cur, lastUsed: Date.now() });
			};
		}).catch(() => {});
		return new Uint8Array(rec.bytes);
	} catch {
		return null;
	}
};

/**
 * Stores a chunk whose bytes hash to `dataHash`; the caller has checked that
 * they do. A cache write: failures are swallowed. Pins on the same chunk are
 * kept, and a kept chunk is never replaced by another file's bytes under the
 * same key.
 */
export const putCachedChunk = async (fileId: string, index: number, bytes: Uint8Array, dataHash: string): Promise<void> => {
	const db = await openDb();
	if (!db) return;
	try {
		const key = chunkKey(fileId, index);
		await inTx<void>(db, 'readwrite', (store) => {
			const req = store.get(key);
			req.onsuccess = () => {
				const cur = req.result as ChunkRecord | undefined;
				if (cur && isPinned(cur) && cur.dataHash !== dataHash) return;
				store.put({
					key,
					fileId,
					bytes: copyOf(bytes),
					dataHash,
					size: bytes.byteLength,
					lastUsed: Date.now(),
					pins: cur && cur.dataHash === dataHash ? cur.pins : undefined,
				} satisfies ChunkRecord);
			};
		});
		await evictOverBudget(db);
	} catch {
		/* cache full or blocked — the network path still works */
	}
};

/** Thrown where a chunk cannot be kept on this device; the person is told. */
export class ChunkPinError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'ChunkPinError';
	}
}

/**
 * Marks chunk `index` of `fileId` as kept by `owner`, storing `bytes` if the
 * device does not hold the chunk. Unlike a cache write, a failure throws — a
 * full disk rejects with the browser's QuotaExceededError — and nothing is
 * pinned. A chunk another account keeps under a different hash is not
 * replaced.
 */
export const pinChunk = async (fileId: string, index: number, dataHash: string, owner: string, bytes: Uint8Array): Promise<void> => {
	const db = await openDb();
	if (!db) throw new ChunkPinError('This browser gives the app no local database, so files cannot be kept on this device.');
	const key = chunkKey(fileId, index);
	await inTx<void>(db, 'readwrite', (store, _settle, fail) => {
		const req = store.get(key);
		req.onsuccess = () => {
			const cur = req.result as ChunkRecord | undefined;
			if (cur && cur.dataHash === dataHash) {
				const pins = cur.pins?.includes(owner) ? cur.pins : [...(cur.pins ?? []), owner];
				store.put({ ...cur, pins, lastUsed: Date.now() });
				return;
			}
			if (cur && isPinned(cur)) {
				fail(new ChunkPinError(`Chunk ${index} of file ${fileId} is kept on this device with other contents.`));
				return;
			}
			store.put({
				key, fileId, bytes: copyOf(bytes), dataHash, size: bytes.byteLength, lastUsed: Date.now(), pins: [owner],
			} satisfies ChunkRecord);
		};
	});
};

/** Drops `owner`'s pins from every chunk in `range` (all of them when null); a chunk another account pins stays pinned. */
const unpinWhere = async (owner: string, range: IDBKeyRange | null): Promise<void> => {
	const db = await openDb();
	if (!db) return;
	await inTx<void>(db, 'readwrite', (store) => {
		const req = store.openCursor(range);
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) return;
			const rec = cursor.value as ChunkRecord;
			if (rec.pins?.includes(owner)) cursor.update({ ...rec, pins: rec.pins.filter((p) => p !== owner) });
			cursor.continue();
		};
	});
	// What is no longer kept is cache again, and counts against its budget.
	await evictOverBudget(db).catch(() => {});
};

/** `owner` no longer keeps `fileId`: its chunks stay as cache unless another account keeps them. */
export const unpinFile = (fileId: string, owner: string): Promise<void> => unpinWhere(owner, fileRange(fileId));

/** `owner` leaves this device: every pin it holds goes. */
export const unpinAllOf = (owner: string): Promise<void> => unpinWhere(owner, null);

/** Bytes of the chunks `owner` keeps; a chunk shared with another account counts for both. */
export const pinnedBytesOf = async (owner: string): Promise<number> => {
	const db = await openDb();
	if (!db) return 0;
	return inTx<number>(db, 'readonly', (store, settle) => {
		let total = 0;
		const req = store.openCursor();
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) return settle(total);
			const rec = cursor.value as ChunkRecord;
			if (rec.pins?.includes(owner)) total += rec.size;
			cursor.continue();
		};
	});
};

/**
 * Oldest-used unpinned chunks go first once the cache's byte budget is
 * crossed. Kept chunks are never evicted and do not count against the
 * budget: keeping files does not shrink the cache, and the cache never
 * pushes a kept file out. One transaction, so a chunk pinned meanwhile is not
 * deleted.
 */
const evictOverBudget = (db: IDBDatabase): Promise<void> =>
	inTx<void>(db, 'readwrite', (store) => {
		let total = 0;
		const sum = store.openCursor();
		sum.onsuccess = () => {
			const cursor = sum.result;
			if (cursor) {
				const rec = cursor.value as ChunkRecord;
				if (!isPinned(rec)) total += rec.size;
				cursor.continue();
				return;
			}
			if (total <= budgetBytes) return;
			const byAge = store.index('lastUsed').openCursor();
			byAge.onsuccess = () => {
				const c = byAge.result;
				if (!c || total <= budgetBytes) return;
				const rec = c.value as ChunkRecord;
				if (!isPinned(rec)) {
					c.delete();
					total -= rec.size;
				}
				c.continue();
			};
		};
	});

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
	budgetBytes = BUDGET_BYTES;
};

/** Test seam: a small budget, so eviction can be exercised with small chunks. */
export const __setChunkBudgetForTests = (bytes: number): void => {
	budgetBytes = bytes;
};

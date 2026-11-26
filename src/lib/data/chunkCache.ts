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
// belongs to (keptFiles.ts). Each chunk's metadata lists the accounts pinning
// it in the clear (local metadata need not be hidden, docs/invariants.md §1),
// so an account's pins can be dropped without its key when it leaves the
// device. A pinned chunk stays while any account pins it; eviction skips it,
// and a failed pin is an error for the caller, not a swallowed cache miss.
//
// A chunk is two records under one key, written and deleted in the same
// transaction: its bytes in `chunks`, everything else in `meta`. A pin, an
// unpin or an LRU touch rewrites the small `meta` record and never the bytes.
//
// Eviction and per-account reads walk indexes on `meta`, not the chunks: an
// unpinned chunk's metadata carries `evictable` = [lastUsed, size], and the
// sparse index on it sums and orders the cache without reading a byte or
// visiting a kept chunk; the multi-entry index on `pins` finds one account's
// chunks.

import { opensRefused } from './openDatabase';

const DB_NAME = 'buckitup-chunks';
const DB_VERSION = 3;
/** The chunks' bytes: ChunkBytes. */
const BYTES = 'chunks';
/** Everything else about them: ChunkMeta. */
const META = 'meta';
const BUDGET_BYTES = 512 * 1024 * 1024;

interface ChunkBytes {
	key: string; // `${fileId}:${index}`
	bytes: ArrayBuffer;
}

interface ChunkMeta {
	key: string; // `${fileId}:${index}`
	/** The chunk's signed data_hash, checked when it was stored: a read compares strings, not SHA3 over 4 MiB. */
	dataHash: string;
	size: number;
	lastUsed: number;
	/** Accounts on this device that keep the file this chunk belongs to (keptFiles.ts). Absent or empty: plain cache. */
	pins?: string[];
	/** [lastUsed, size], on unpinned chunks only: what eviction reads. */
	evictable?: [number, number];
}

const isPinned = (meta: Pick<ChunkMeta, 'pins'>): boolean => !!meta.pins?.length;

/** The metadata as stored: `evictable` follows its pins, `pins` is dropped when empty. */
const stored = (meta: ChunkMeta): ChunkMeta => {
	const { pins, ...rest } = meta;
	delete rest.evictable;
	return pins?.length ? { ...rest, pins } : { ...rest, evictable: [rest.lastUsed, rest.size] };
};

let dbPromise: Promise<IDBDatabase | null> | null = null;
let budgetBytes = BUDGET_BYTES;

const openDb = (): Promise<IDBDatabase | null> => {
	if (dbPromise) return dbPromise;
	const opening: Promise<IDBDatabase | null> = new Promise((resolve) => {
		if (typeof indexedDB === 'undefined' || opensRefused()) return resolve(null);
		let blocked = false;
		try {
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = () => {
				// A cache: an older layout is dropped, not migrated.
				for (const name of Array.from(req.result.objectStoreNames)) req.result.deleteObjectStore(name);
				req.result.createObjectStore(BYTES, { keyPath: 'key' });
				const meta = req.result.createObjectStore(META, { keyPath: 'key' });
				meta.createIndex('evictable', 'evictable');
				meta.createIndex('pins', 'pins', { multiEntry: true });
			};
			req.onsuccess = () => {
				const db = req.result;
				const ready = blocked ? Promise.resolve(db) : opening;
				const forget = () => {
					if (dbPromise === ready) dbPromise = null;
				};
				// Holding the connection would block another tab's upgrade.
				db.onversionchange = () => {
					db.close();
					forget();
				};
				db.onclose = forget;
				if (!blocked) resolve(db);
				else if (dbPromise === opening) dbPromise = ready;
				else db.close();
			};
			// Another tab holds an older version open. Until it closes, this tab
			// works without the cache; the open goes on and takes over when it lands.
			req.onblocked = () => {
				blocked = true;
				resolve(null);
			};
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	dbPromise = opening;
	return opening;
};

/**
 * One transaction over `stores`, settled when it commits. `body` issues its
 * requests from request callbacks, so every read and the write it decides
 * stay inside the same transaction — another tab's pin cannot land between
 * them. A failed request aborts the transaction and the promise rejects with
 * the transaction's error: a full disk arrives here as QuotaExceededError.
 */
const inTx = <T>(
	db: IDBDatabase,
	stores: string[],
	mode: globalThis.IDBTransactionMode,
	body: (tx: IDBTransaction, settle: (value: T) => void, fail: (e: Error) => void) => void,
): Promise<T> =>
	new Promise((resolve, reject) => {
		let result: T | undefined;
		let failure: Error | null = null;
		let tx: IDBTransaction;
		try {
			tx = db.transaction(stores, mode);
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
			body(tx, (value) => { result = value; }, fail);
		} catch (e) {
			fail(e as Error);
		}
	});

const chunkKey = (fileId: string, index: number) => `${fileId}:${index}`;
/** Every chunk key of one file: `${fileId}:` followed by an index. */
const fileRange = (fileId: string) => IDBKeyRange.bound(`${fileId}:`, `${fileId}:￿`);

const copyOf = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** Writes a chunk's bytes and its metadata, in the transaction `tx` over both stores. */
const writeChunk = (tx: IDBTransaction, key: string, bytes: Uint8Array, dataHash: string, pins: string[] | undefined): void => {
	tx.objectStore(BYTES).put({ key, bytes: copyOf(bytes) } satisfies ChunkBytes);
	tx.objectStore(META).put(stored({ key, dataHash, size: bytes.byteLength, lastUsed: Date.now(), pins }));
};

/**
 * The cached chunk if it is the one with `dataHash`; anything else reads as
 * absent and is overwritten by the next store. A read moves an unpinned chunk
 * to the back of the eviction order unless `touch` is false: a caller about to
 * pin the chunk spares the write.
 */
export const getCachedChunk = async (fileId: string, index: number, dataHash: string, opts: { touch?: boolean } = {}): Promise<Uint8Array | null> => {
	const db = await openDb();
	if (!db) return null;
	const key = chunkKey(fileId, index);
	try {
		const found = await inTx<{ meta: ChunkMeta; bytes: ArrayBuffer } | null>(db, [META, BYTES], 'readonly', (tx, settle) => {
			settle(null);
			const req = tx.objectStore(META).get(key);
			req.onsuccess = () => {
				const meta = req.result as ChunkMeta | undefined;
				if (meta?.dataHash !== dataHash) return;
				const read = tx.objectStore(BYTES).get(key);
				read.onsuccess = () => {
					const rec = read.result as ChunkBytes | undefined;
					if (rec) settle({ meta, bytes: rec.bytes });
				};
			};
		});
		if (!found) return null;
		// LRU touch; fire-and-forget, a failed touch only skews eviction order.
		// A kept chunk is never evicted, so it is not touched. The touch
		// re-reads the metadata in its own transaction, so a pin added since
		// the read above is kept.
		if (opts.touch !== false && !isPinned(found.meta)) {
			inTx<void>(db, [META], 'readwrite', (tx) => {
				const store = tx.objectStore(META);
				const req = store.get(key);
				req.onsuccess = () => {
					const cur = req.result as ChunkMeta | undefined;
					if (cur && cur.dataHash === dataHash) store.put(stored({ ...cur, lastUsed: Date.now() }));
				};
			}).catch(() => {});
		}
		return new Uint8Array(found.bytes);
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
		await inTx<void>(db, [META, BYTES], 'readwrite', (tx) => {
			const req = tx.objectStore(META).get(key);
			req.onsuccess = () => {
				const cur = req.result as ChunkMeta | undefined;
				if (cur && isPinned(cur) && cur.dataHash !== dataHash) return;
				writeChunk(tx, key, bytes, dataHash, cur && cur.dataHash === dataHash ? cur.pins : undefined);
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

/** The metadata with `owner` among its pins. */
const withPin = (meta: ChunkMeta, owner: string): ChunkMeta =>
	stored({ ...meta, pins: meta.pins?.includes(owner) ? meta.pins : [...(meta.pins ?? []), owner], lastUsed: Date.now() });

const openDbForPins = async (): Promise<IDBDatabase> => {
	const db = await openDb();
	if (!db) throw new ChunkPinError('The local database is not available, so files cannot be kept on this device.');
	return db;
};

/**
 * Marks chunk `index` of `fileId` as kept by `owner`, storing `bytes` if the
 * device does not hold the chunk. A full disk first frees the oldest unpinned
 * chunks, never a kept one, and the write is tried again; when no cache is
 * left to free it rejects with the browser's QuotaExceededError. Unlike a
 * cache write, a failure throws and nothing is pinned. A chunk another account
 * keeps under a different hash is not replaced.
 */
export const pinChunk = async (fileId: string, index: number, dataHash: string, owner: string, bytes: Uint8Array): Promise<void> => {
	const db = await openDbForPins();
	for (;;) {
		try {
			return await pinOnce(db, fileId, index, dataHash, owner, bytes);
		} catch (e) {
			if ((e as Error)?.name !== 'QuotaExceededError' || !(await evictUnpinned(db, (total) => total - bytes.byteLength))) throw e;
		}
	}
};

const pinOnce = (db: IDBDatabase, fileId: string, index: number, dataHash: string, owner: string, bytes: Uint8Array): Promise<void> => {
	const key = chunkKey(fileId, index);
	return inTx<void>(db, [META, BYTES], 'readwrite', (tx, _settle, fail) => {
		const meta = tx.objectStore(META);
		const req = meta.get(key);
		req.onsuccess = () => {
			const cur = req.result as ChunkMeta | undefined;
			if (cur && cur.dataHash === dataHash) {
				meta.put(withPin(cur, owner));
				return;
			}
			if (cur && isPinned(cur)) {
				fail(new ChunkPinError(`Chunk ${index} of file ${fileId} is kept on this device with other contents.`));
				return;
			}
			writeChunk(tx, key, bytes, dataHash, [owner]);
		};
	});
};

/**
 * Pins for `owner` the chunks of `fileId` this device already holds under
 * their signed hash, `dataHashes[i]` for chunk i, in one transaction and
 * without decrypting them: each was held to its hash when it was stored. Only
 * the chunks on disk get a write, and it is a write of their metadata.
 * Returns the indexes pinned; a failure throws, as pinChunk does.
 */
export const pinCachedChunks = async (fileId: string, dataHashes: string[], owner: string): Promise<Set<number>> => {
	const db = await openDbForPins();
	const present = new Set(await inTx<globalThis.IDBValidKey[]>(db, [META], 'readonly', (tx, settle) => {
		const req = tx.objectStore(META).getAllKeys(fileRange(fileId));
		req.onsuccess = () => settle(req.result);
	}));
	const held = dataHashes.map((_, i) => i).filter((i) => present.has(chunkKey(fileId, i)));
	const pinned = new Set<number>();
	if (!held.length) return pinned;
	await inTx<void>(db, [META], 'readwrite', (tx) => {
		const store = tx.objectStore(META);
		for (const i of held) {
			const req = store.get(chunkKey(fileId, i));
			req.onsuccess = () => {
				const meta = req.result as ChunkMeta | undefined;
				if (meta?.dataHash !== dataHashes[i]) return;
				if (!meta.pins?.includes(owner)) store.put(withPin(meta, owner));
				pinned.add(i);
			};
		}
	});
	return pinned;
};

/** Drops `owner`'s pins from its chunks, those of one file when `fileId` is given; a chunk another account pins stays pinned. */
const unpinWhere = async (owner: string, fileId: string | null): Promise<void> => {
	const db = await openDb();
	if (!db) return;
	await inTx<void>(db, [META], 'readwrite', (tx) => {
		const store = tx.objectStore(META);
		const req = fileId ? store.openCursor(fileRange(fileId)) : store.index('pins').openCursor(IDBKeyRange.only(owner));
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) return;
			const meta = cursor.value as ChunkMeta;
			if (meta.pins?.includes(owner)) cursor.update(stored({ ...meta, pins: meta.pins.filter((p) => p !== owner) }));
			cursor.continue();
		};
	});
	// What is no longer kept is cache again, and counts against its budget.
	await evictOverBudget(db).catch(() => {});
};

/** The files `owner` holds pins on, read from the pins index alone. */
export const pinnedFileIdsOf = async (owner: string): Promise<Set<string>> => {
	const db = await openDb();
	if (!db) return new Set();
	return inTx<Set<string>>(db, [META], 'readonly', (tx, settle) => {
		const fileIds = new Set<string>();
		settle(fileIds);
		const req = tx.objectStore(META).index('pins').openKeyCursor(IDBKeyRange.only(owner));
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) return;
			const key = String(cursor.primaryKey);
			fileIds.add(key.slice(0, key.lastIndexOf(':')));
			cursor.continue();
		};
	});
};

/** `owner` no longer keeps `fileId`: its chunks stay as cache unless another account keeps them. */
export const unpinFile = (fileId: string, owner: string): Promise<void> => unpinWhere(owner, fileId);

/** `owner` leaves this device: every pin it holds goes. */
export const unpinAllOf = (owner: string): Promise<void> => unpinWhere(owner, null);

const sumPinnedBy = async (owner: string, counts: (meta: ChunkMeta) => boolean): Promise<number> => {
	const db = await openDb();
	if (!db) return 0;
	return inTx<number>(db, [META], 'readonly', (tx, settle) => {
		let total = 0;
		const req = tx.objectStore(META).index('pins').openCursor(IDBKeyRange.only(owner));
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) return settle(total);
			const meta = cursor.value as ChunkMeta;
			if (counts(meta)) total += meta.size;
			cursor.continue();
		};
	});
};

/** Bytes of the chunks `owner` keeps; a chunk shared with another account counts for both. */
export const pinnedBytesOf = (owner: string): Promise<number> => sumPinnedBy(owner, () => true);

/** Bytes that stop being kept when `owner` leaves: its chunks no other account keeps. */
export const soleKeptBytesOf = (owner: string): Promise<number> => sumPinnedBy(owner, (meta) => meta.pins?.length === 1);

/**
 * Oldest-used unpinned chunks go first once the cache's byte budget is
 * crossed. Kept chunks are never evicted and do not count against the
 * budget: keeping files does not shrink the cache, and the cache never
 * pushes a kept file out. One transaction, so a chunk pinned meanwhile is not
 * deleted.
 */
const evictOverBudget = async (db: IDBDatabase): Promise<void> => {
	await evictUnpinned(db, () => budgetBytes);
};

const evictUnpinned = (db: IDBDatabase, target: (total: number) => number): Promise<number> =>
	inTx<number>(db, [META, BYTES], 'readwrite', (tx, settle) => {
		const index = tx.objectStore(META).index('evictable');
		let total = 0;
		let freed = 0;
		settle(0);
		const sum = index.openKeyCursor();
		sum.onsuccess = () => {
			const cursor = sum.result;
			if (cursor) {
				total += (cursor.key as [number, number])[1];
				cursor.continue();
				return;
			}
			const keep = target(total);
			if (total <= keep) return;
			const byAge = index.openKeyCursor();
			byAge.onsuccess = () => {
				const c = byAge.result;
				if (!c || total <= keep) return;
				tx.objectStore(META).delete(c.primaryKey);
				tx.objectStore(BYTES).delete(c.primaryKey);
				const size = (c.key as [number, number])[1];
				total -= size;
				freed += size;
				settle(freed);
				c.continue();
			};
		};
	});

export const cachedBytes = async (): Promise<number> => {
	const db = await openDb();
	if (!db) return 0;
	return inTx<number>(db, [META], 'readonly', (tx, settle) => {
		let total = 0;
		const req = tx.objectStore(META).index('evictable').openKeyCursor();
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) return settle(total);
			total += (cursor.key as [number, number])[1];
			cursor.continue();
		};
	});
};

export const clearChunkCache = async (): Promise<void> => {
	const db = await openDb();
	if (db) await evictUnpinned(db, () => 0);
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
	budgetBytes = BUDGET_BYTES;
};

/** Test seam: a small budget, so eviction can be exercised with small chunks. */
export const __setChunkBudgetForTests = (bytes: number): void => {
	budgetBytes = bytes;
};

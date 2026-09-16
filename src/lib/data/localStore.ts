// Minimal IndexedDB key-value store for rows that need local persistence
// (e.g. user_storage entries the server does not accept yet). Replaces the
// PGlite database as the local-durability layer — values are small opaque
// objects, no query engine needed.
//
// Values are encrypted at rest, and so are the key names: they read
// `us|<user_hash>|<uuid>`, so storing them verbatim would leak the account id
// even with the value sealed. Records written before encryption are migrated
// on first read, one key at a time — see kvGet.
import { createSecureStore, type StringStore } from './secureStore';

const DB_NAME = 'buckitup-local-store';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(STORE);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}
	return dbPromise;
};

const tx = async (mode: IDBTransactionMode) => (await openDb()).transaction(STORE, mode).objectStore(STORE);

const asPromise = <T>(req: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

/**
 * String view of the same object store, for the encryption wrapper to sit on.
 * Non-string values are reported as missing: those are pre-encryption records,
 * reachable only through the migration path below.
 */
const rawStore: StringStore = {
	async get(key) {
		const value = await asPromise((await tx('readonly')).get(key));
		return typeof value === 'string' ? value : null;
	},
	async set(key, value) {
		await asPromise((await tx('readwrite')).put(value, key));
	},
	async delete(key) {
		await asPromise((await tx('readwrite')).delete(key));
	},
	async keys() {
		return (await asPromise((await tx('readonly')).getAllKeys())) as string[];
	},
	async clear() {
		await asPromise((await tx('readwrite')).clear());
	},
};

// The key module is imported lazily: it reaches into the vault, which pulls in
// the whole crypto stack, and this module must stay cheap to import.
let store: StringStore = createSecureStore(rawStore, {
	getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
	hashKeys: true,
	keyNameSalt: 'buckitup-local-store-v1',
});

/**
 * Test hook: swap the backing store (node has no IndexedDB). Migration of
 * pre-encryption records is switched off with it — there is no object store to
 * migrate from.
 */
let migrateLegacy = true;
export function _setStoreForTests(replacement: StringStore): void {
	store = replacement;
	migrateLegacy = false;
}

/**
 * Take a pre-encryption record: the value sat in the object store as a plain
 * structured-clone object under its readable key name. Returns it and drops
 * the readable copy; the caller writes it back encrypted.
 */
const takeLegacy = async (key: string): Promise<unknown> => {
	if (!migrateLegacy) return undefined;
	const value = await asPromise((await tx('readonly')).get(key));
	if (value === undefined) return undefined;
	await asPromise((await tx('readwrite')).delete(key));
	return value;
};

export async function kvGet<T>(key: string): Promise<T | undefined> {
	let stored: string | null;
	try {
		stored = await store.get(key);
	} catch (e) {
		// Not readable with this account's key, or the vault is locked. The
		// record stays where it is: callers read a failure as "no local
		// revision", and that must never be allowed to mean "safe to discard".
		console.error(`[localStore] cannot read a local record:`, e);
		throw e;
	}
	if (stored !== null) return JSON.parse(stored) as T;

	const legacy = await takeLegacy(key);
	if (legacy === undefined) return undefined;
	await kvSet(key, legacy);
	return legacy as T;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
	await store.set(key, JSON.stringify(value));
}

export async function kvDelete(key: string): Promise<void> {
	await store.delete(key);
	// A pre-encryption twin under the readable key name may still exist if the
	// record was never read since encryption landed.
	await takeLegacy(key).catch(() => undefined);
}

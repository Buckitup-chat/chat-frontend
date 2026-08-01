// Minimal IndexedDB key-value store for rows that need local persistence
// (e.g. user_storage entries the server does not accept yet). Replaces the
// PGlite database as the local-durability layer — values are small opaque
// objects, no query engine needed.
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

export async function kvGet<T>(key: string): Promise<T | undefined> {
	return asPromise((await tx('readonly')).get(key)) as Promise<T | undefined>;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
	await asPromise((await tx('readwrite')).put(value, key));
}

export async function kvDelete(key: string): Promise<void> {
	await asPromise((await tx('readwrite')).delete(key));
}

const DB = 'user-synced-cache';
const STORE = 'user_cards';
const BINARY = ['sign_pkey', 'crypt_pkey', 'crypt_cert', 'contact_pkey', 'contact_cert', 'sign_b64'];

export const unpad = (card: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
	Object.entries(card).map(([k, v]) => [k, BINARY.includes(k) ? String(v).replace(/=+$/, '') : v])
);

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
	const req = indexedDB.open(DB, 1);
	req.onupgradeneeded = () => {
		if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: '__key' });
	};
	req.onsuccess = () => resolve(req.result);
	req.onerror = () => reject(req.error);
});

const inStore = async (fn: (store: IDBObjectStore) => void) => {
	const db = await openDb();
	await new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, 'readwrite');
		fn(tx.objectStore(STORE));
		tx.oncomplete = resolve;
		tx.onerror = () => reject(tx.error);
	});
	db.close();
};

export const writeCachedCards = (cards: Record<string, unknown>[]) => inStore((store) => {
	for (const card of cards) store.put({ ...unpad(card), __key: card.user_hash });
});

export const clearCachedCards = () => inStore((store) => store.clear());

export const cachedCardKeys = async () => {
	const dbs = await indexedDB.databases();
	if (!dbs.some((d) => d.name === DB)) return [];
	const db = await openDb();
	const keys = await new Promise<string[]>((resolve) => {
		const r = db.transaction(STORE).objectStore(STORE).getAllKeys();
		r.onsuccess = () => resolve(r.result.map(String));
	});
	db.close();
	return keys.sort();
};

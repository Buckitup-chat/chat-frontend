const MAIN_DB = 'user-synced-cache';
const BINARY = ['sign_pkey', 'crypt_pkey', 'crypt_cert', 'contact_pkey', 'contact_cert', 'sign_b64'];

export const unpad = (card: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
	Object.entries(card).map(([k, v]) => [k, BINARY.includes(k) ? String(v).replace(/=+$/, '') : v])
);

export const openMainDb = () => new Promise<IDBDatabase>((resolve, reject) => {
	const req = indexedDB.open(MAIN_DB, 1);
	req.onupgradeneeded = () => {
		for (const name of ['user_cards', 'user_storage']) {
			if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: '__key' });
		}
	};
	req.onsuccess = () => resolve(req.result);
	req.onerror = () => reject(req.error);
});

const inStore = async (fn: (store: IDBObjectStore) => void) => {
	const db = await openMainDb();
	await new Promise((resolve, reject) => {
		const tx = db.transaction('user_cards', 'readwrite');
		fn(tx.objectStore('user_cards'));
		tx.oncomplete = resolve;
		tx.onerror = () => reject(tx.error);
	});
	db.close();
};

export const writeAsMain = (cards: Record<string, unknown>[]) => inStore((store) => {
	for (const card of cards) {
		store.put({ ...unpad(card), owner_timestamp: BigInt(card.owner_timestamp as number), __key: card.user_hash });
	}
});

export const clearMainCache = () => inStore((store) => store.clear());

export const mainStoreKeys = async () => {
	const dbs = await indexedDB.databases();
	if (!dbs.some((d) => d.name === MAIN_DB)) return [];
	const db = await openMainDb();
	const keys = await new Promise<string[]>((resolve) => {
		const r = db.transaction('user_cards').objectStore('user_cards').getAllKeys();
		r.onsuccess = () => resolve(r.result.map(String));
	});
	db.close();
	return keys.sort();
};

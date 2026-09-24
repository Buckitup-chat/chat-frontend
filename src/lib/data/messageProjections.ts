import { createSecureStore, DecryptFailedError, type StringStore } from './secureStore';

const DB_NAME = 'buckitup-message-projections';
const DB_VERSION = 1;
const STORE = 'transactions';

export interface MessageProjection {
	messageId: string;
	owner: string;
	relation: 'dialog_messages';
	dialogHash: string;
	peerHash: string;
	ownerTimestamp: number;
	createdAt: number;
	text: string;
	signHash?: string | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;
const openDb = (): Promise<IDBDatabase> => {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			reject(new Error('[projections] IndexedDB is not available'));
			return;
		}
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	dbPromise.catch(() => { dbPromise = null; });
	return dbPromise;
};

const request = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
	openDb().then((db) => new Promise<T>((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		const req = fn(tx.objectStore(STORE));
		tx.oncomplete = () => resolve(req.result);
		tx.onerror = () => reject(tx.error ?? req.error);
		tx.onabort = () => reject(tx.error ?? new Error('[projections] transaction aborted'));
	}));

const strictStore: StringStore = {
	get: async (key) => ((await request<string | undefined>('readonly', (s) => s.get(key))) ?? null),
	set: async (key, value) => { await request('readwrite', (s) => s.put(value, key)); },
	delete: async (key) => { await request('readwrite', (s) => s.delete(key)); },
	keys: async () => (await request<IDBValidKey[]>('readonly', (s) => s.getAllKeys())).map(String),
	clear: async () => { await request('readwrite', (s) => s.clear()); },
};

let storeFor = (owner: string): StringStore => createSecureStore(strictStore, {
	getKey: async () => (await import('./localCrypto')).getLocalStorageKeyFor(owner),
});
let rawStore: StringStore = strictStore;

export function _setProjectionStorageForTests(adapter: StringStore): void {
	storeFor = () => adapter;
	rawStore = adapter;
}

const keyOf = (messageId: string) => `projection:${messageId}`;

export async function saveProjection(p: MessageProjection): Promise<void> {
	await storeFor(p.owner).set(keyOf(p.messageId), JSON.stringify(p));
}

export async function updateProjection(owner: string, messageId: string, patch: Partial<MessageProjection>): Promise<void> {
	const store = storeFor(owner);
	const raw = await store.get(keyOf(messageId));
	if (raw === null) return;
	const current = JSON.parse(raw) as MessageProjection;
	if (current.owner !== owner) return;
	await store.set(keyOf(messageId), JSON.stringify({ ...current, ...patch, owner, messageId }));
}

export async function removeProjection(messageId: string): Promise<void> {
	await rawStore.delete(keyOf(messageId));
}

export interface ProjectionScan {
	projections: MessageProjection[];
	foreign: number;
	corrupt: number;
}

export async function projectionsOf(owner: string): Promise<ProjectionScan> {
	const store = storeFor(owner);
	const keys = (await rawStore.keys()).filter((k) => k.startsWith('projection:'));
	const out: ProjectionScan = { projections: [], foreign: 0, corrupt: 0 };
	for (const key of keys) {
		let raw: string | null;
		try {
			raw = await store.get(key);
		} catch (e) {
			if (e instanceof DecryptFailedError) { out.foreign++; continue; }
			throw e;
		}
		if (raw === null) continue;
		try {
			const p = JSON.parse(raw) as MessageProjection;
			if (p.owner === owner) out.projections.push(p);
			else out.foreign++;
		} catch {
			out.corrupt++;
		}
	}
	out.projections.sort((a, b) => a.ownerTimestamp - b.ownerTimestamp || a.createdAt - b.createdAt);
	return out;
}

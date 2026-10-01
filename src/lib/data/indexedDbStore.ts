import type { StringStore } from './secureStore';

const DB_VERSION = 1;
const DEFAULT_STORE_NAME = 'transactions';

export class StorageReadError extends Error {
	readonly operation: 'get' | 'keys';

	constructor(operation: 'get' | 'keys', options: { cause: unknown }) {
		super(`[indexedDbStore] ${operation} did not complete: nothing is known about the stored records`, options);
		this.name = 'StorageReadError';
		this.operation = operation;
	}
}

export class IndexedDbStore implements StringStore {
	readonly #dbName: string;
	readonly #storeName: string;
	#db: Promise<IDBDatabase> | null = null;

	constructor(dbName: string, storeName = DEFAULT_STORE_NAME) {
		this.#dbName = dbName;
		this.#storeName = storeName;
	}

	async get(key: string): Promise<string | null> {
		let value: unknown;
		try {
			value = await this.#run('readonly', (store) => store.get(key));
		} catch (e) {
			throw new StorageReadError('get', { cause: e });
		}
		return value === undefined ? null : (value as string);
	}

	async keys(): Promise<string[]> {
		try {
			return (await this.#run('readonly', (store) => store.getAllKeys())) as string[];
		} catch (e) {
			throw new StorageReadError('keys', { cause: e });
		}
	}

	async set(key: string, value: string): Promise<void> {
		await this.#run('readwrite', (store) => store.put(value, key));
	}

	async delete(key: string): Promise<void> {
		await this.#run('readwrite', (store) => store.delete(key));
	}

	async clear(): Promise<void> {
		await this.#run('readwrite', (store) => store.clear());
	}

	async #run<T>(mode: 'readonly' | 'readwrite', request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		const db = await this.#open();
		return new Promise<T>((resolve, reject) => {
			const tx = db.transaction(this.#storeName, mode);
			const pending = request(tx.objectStore(this.#storeName));
			tx.oncomplete = () => resolve(pending.result);
			tx.onerror = () => reject(pending.error ?? tx.error ?? new Error('IndexedDB request failed'));
			tx.onabort = () => reject(tx.error ?? pending.error ?? new Error('IndexedDB transaction aborted'));
		});
	}

	#open(): Promise<IDBDatabase> {
		if (this.#db) return this.#db;
		const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
			const request = indexedDB.open(this.#dbName, DB_VERSION);
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(this.#storeName)) request.result.createObjectStore(this.#storeName);
			};
			request.onsuccess = () => {
				const db = request.result;
				db.onversionchange = () => { db.close(); this.#forget(opening); };
				db.onclose = () => this.#forget(opening);
				resolve(db);
			};
			request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
		});
		this.#db = opening;
		opening.catch(() => this.#forget(opening));
		return opening;
	}

	#forget(opening: Promise<IDBDatabase>): void {
		if (this.#db === opening) this.#db = null;
	}
}

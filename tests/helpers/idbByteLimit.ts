type Rec = { key: string; size: number };
type Put = (this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest;
type Del = (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) => IDBRequest;
type CursorUpdate = (this: IDBCursor, value: unknown) => IDBRequest;
type CursorDelete = (this: IDBCursor) => IDBRequest;

const abortWithQuota = (tx: IDBTransaction) => (tx as unknown as { _abort: (name: string) => void })._abort('QuotaExceededError');

export const limitChunkStore = (storeName = 'chunks') => {
	let limitBytes = Infinity;
	const sizes = new Map<string, number>();
	const used = () => [...sizes.values()].reduce((a, b) => a + b, 0);
	const store = (globalThis as unknown as { IDBObjectStore: { prototype: { put: Put; delete: Del } } }).IDBObjectStore.prototype;
	const cursor = (globalThis as unknown as { IDBCursor: { prototype: { update: CursorUpdate; delete: CursorDelete } } }).IDBCursor.prototype;
	const original = { put: store.put, delete: store.delete, update: cursor.update, cursorDelete: cursor.delete };

	const write = (tx: IDBTransaction, value: unknown, run: () => IDBRequest): IDBRequest => {
		const rec = value as Rec;
		const next = used() - (sizes.get(rec.key) ?? 0) + rec.size;
		const request = run();
		if (next > limitBytes) abortWithQuota(tx);
		else sizes.set(rec.key, rec.size);
		return request;
	};

	store.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
		if (this.name !== storeName) return original.put.call(this, value, key);
		return write(this.transaction, value, () => original.put.call(this, value, key));
	};
	store.delete = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
		if (this.name === storeName) sizes.delete(String(key));
		return original.delete.call(this, key);
	};
	cursor.update = function (this: IDBCursor, value: unknown) {
		const source = this.source as IDBObjectStore | IDBIndex;
		const owner = 'objectStore' in source ? source.objectStore : source;
		if (owner.name !== storeName) return original.update.call(this, value);
		return write(owner.transaction, value, () => original.update.call(this, value));
	};
	cursor.delete = function (this: IDBCursor) {
		const source = this.source as IDBObjectStore | IDBIndex;
		const owner = 'objectStore' in source ? source.objectStore : source;
		if (owner.name === storeName) sizes.delete(String(this.primaryKey));
		return original.cursorDelete.call(this);
	};

	return {
		used,
		setLimit: (bytes: number) => { limitBytes = bytes; },
		restore: () => {
			store.put = original.put;
			store.delete = original.delete;
			cursor.update = original.update;
			cursor.delete = original.cursorDelete;
		},
	};
};

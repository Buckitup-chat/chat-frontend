// A full disk, as a browser reports it to IndexedDB: the write is not stored,
// and its transaction aborts with a QuotaExceededError on `transaction.error`
// (the pending request itself fails with AbortError). Works on the
// fake-indexeddb globals; `_abort(name)` is how fake-indexeddb aborts a
// transaction with a given error, the same path it takes for its own
// constraint errors.
type Put = (this: IDBObjectStore, value: unknown, key?: unknown) => IDBRequest;

export const failWritesWithQuota = (when: (value: unknown) => boolean): (() => void) => {
	const proto = (globalThis as { IDBObjectStore: { prototype: { put: Put } } }).IDBObjectStore.prototype;
	const original = proto.put;
	proto.put = function (this: IDBObjectStore, value: unknown, key?: unknown) {
		const request = original.call(this, value, key as never);
		if (when(value)) (this.transaction as unknown as { _abort: (name: string) => void })._abort('QuotaExceededError');
		return request;
	};
	return () => { proto.put = original; };
};

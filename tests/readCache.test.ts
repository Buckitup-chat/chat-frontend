// IndexedDB read-cache fallback (§3.13) + hydration race guard (§3.4).
import { describe, it, expect, beforeEach } from 'vitest';
import {
	setCachedRow, deleteCachedRow, getCachedRow, getCachedRows,
	markTouched, isTouched, mirrorInto, clearReadCache,
	_setReadCacheStorageForTests, _resetTouchedForTests,
} from '@/lib/data/readCache';

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
	storage = makeStorage();
	_setReadCacheStorageForTests(storage);
	_resetTouchedForTests();
});

describe('read cache: basic mirror', () => {
	it('round-trips a cached row', async () => {
		await setCachedRow('dialog_messages', 'dmsg_1', { message_id: 'dmsg_1', content_b64: 'x' });
		expect(await getCachedRow('dialog_messages', 'dmsg_1')).toEqual({ message_id: 'dmsg_1', content_b64: 'x' });
	});

	it('delete removes it durably', async () => {
		await setCachedRow('dialog_messages', 'dmsg_1', { message_id: 'dmsg_1' });
		await deleteCachedRow('dialog_messages', 'dmsg_1');
		expect(await getCachedRow('dialog_messages', 'dmsg_1')).toBeNull();
	});

	it('getCachedRows narrows by table and predicate', async () => {
		await setCachedRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1' });
		await setCachedRow('dialog_messages', 'b', { message_id: 'b', dialog_hash: 'd2' });
		await setCachedRow('user_cards', 'u1', { user_hash: 'u1' });

		const forD1 = await getCachedRows('dialog_messages', (r) => r.dialog_hash === 'd1');
		expect(forD1).toEqual([{ message_id: 'a', dialog_hash: 'd1' }]);

		const allMessages = await getCachedRows('dialog_messages');
		expect(allMessages).toHaveLength(2);
	});
});

describe('hydration race guard (§3.4 — a disk read must never overwrite live data)', () => {
	it('a key touched by live data is excluded from a cached read, even if the disk copy exists', async () => {
		await setCachedRow('dialog_messages', 'dmsg_1', { message_id: 'dmsg_1', content_b64: 'stale' });

		// The exact race: disk write happened first (an earlier session), then
		// — before anyone reads the cache — live data arrives for the same key.
		markTouched('dialog_messages', 'dmsg_1');

		expect(await getCachedRow('dialog_messages', 'dmsg_1')).toBeNull();
		expect(await getCachedRows('dialog_messages')).toEqual([]);
	});

	it('an untouched key is still served from cache normally', async () => {
		await setCachedRow('dialog_messages', 'dmsg_2', { message_id: 'dmsg_2' });
		expect(isTouched('dialog_messages', 'dmsg_2')).toBe(false);
		expect(await getCachedRow('dialog_messages', 'dmsg_2')).toEqual({ message_id: 'dmsg_2' });
	});

	it('touching one key never excludes a different key of the same table', async () => {
		await setCachedRow('dialog_messages', 'a', { message_id: 'a' });
		await setCachedRow('dialog_messages', 'b', { message_id: 'b' });
		markTouched('dialog_messages', 'a');

		expect(await getCachedRow('dialog_messages', 'a')).toBeNull();
		expect(await getCachedRow('dialog_messages', 'b')).toEqual({ message_id: 'b' });
	});
});

describe('mirrorInto: keeps the cache current from a collection\'s own changes', () => {
	const fakeCollection = (initial: Array<{ key: string; value: Record<string, unknown> }>) => {
		let listener: ((changes: any[]) => void) | null = null;
		return {
			emit(changes: any[]) { listener?.(changes); },
			subscribeChanges(cb: (changes: any[]) => void, opts?: { includeInitialState?: boolean }) {
				listener = cb;
				if (opts?.includeInitialState) {
					cb(initial.map((r) => ({ key: r.key, value: r.value, type: 'insert' })));
				}
				return { unsubscribe: () => { listener = null; } };
			},
		};
	};

	it('mirrors initial state into the cache and marks it touched (a warm SQLite start is not stale)', async () => {
		const coll = fakeCollection([{ key: 'dmsg_1', value: { message_id: 'dmsg_1', content_b64: 'seen' } }]);
		mirrorInto(coll, 'dialog_messages');
		await Promise.resolve(); // let the async set() inside the callback settle

		expect(isTouched('dialog_messages', 'dmsg_1')).toBe(true);
		// Touched, so getCachedRow correctly refuses to hand it back as a
		// "fallback" — the caller should read it straight from the live
		// collection instead, which is exactly the point of touching it.
		expect(await getCachedRow('dialog_messages', 'dmsg_1')).toBeNull();
	});

	it('a later delete from the collection removes the mirrored row', async () => {
		const coll = fakeCollection([{ key: 'dmsg_1', value: { message_id: 'dmsg_1' } }]);
		mirrorInto(coll, 'dialog_messages');
		await Promise.resolve();

		coll.emit([{ key: 'dmsg_1', type: 'delete' }]);
		await Promise.resolve();

		// Bypass the touched-guard to inspect the raw store directly — this
		// proves the delete really happened, not just that isTouched masks it.
		expect(storage.map.has('dialog_messages:dmsg_1')).toBe(false);
	});

	// A dialog evicted from the LRU warm set gets a brand-new, cold collection
	// if reopened later — but only if its keys are not still marked touched
	// from before. Without this, the fallback would silently stop helping for
	// exactly the "reopen a previously-seen dialog offline" case it exists for.
	it('unsubscribe un-touches exactly the keys this subscription touched, so a reopened dialog can use the fallback again', async () => {
		const coll = fakeCollection([{ key: 'dmsg_1', value: { message_id: 'dmsg_1', content_b64: 'seen' } }]);
		const unsubscribe = mirrorInto(coll, 'dialog_messages');
		await Promise.resolve();
		expect(isTouched('dialog_messages', 'dmsg_1')).toBe(true);

		unsubscribe();

		expect(isTouched('dialog_messages', 'dmsg_1')).toBe(false);
		// The row is still on disk (unsubscribe is not a delete) — now usable
		// as a fallback again, e.g. while the reopened dialog's fresh
		// collection is still cold.
		expect(await getCachedRow('dialog_messages', 'dmsg_1')).toEqual({ message_id: 'dmsg_1', content_b64: 'seen' });
	});

	it('unsubscribe never un-touches a key it did not itself touch (a different dialog\'s key survives)', async () => {
		const collA = fakeCollection([{ key: 'a', value: { message_id: 'a' } }]);
		const unsubscribeA = mirrorInto(collA, 'dialog_messages');
		await Promise.resolve();

		const collB = fakeCollection([{ key: 'b', value: { message_id: 'b' } }]);
		mirrorInto(collB, 'dialog_messages');
		await Promise.resolve();

		unsubscribeA();

		expect(isTouched('dialog_messages', 'a')).toBe(false);
		expect(isTouched('dialog_messages', 'b')).toBe(true); // untouched by A's teardown
	});

	it('unsubscribe stops future mirroring', async () => {
		const coll = fakeCollection([]);
		const unsub = mirrorInto(coll, 'dialog_messages');
		unsub();

		coll.emit([{ key: 'later', value: { message_id: 'later' }, type: 'insert' }]);
		await Promise.resolve();

		expect(storage.map.has('dialog_messages:later')).toBe(false);
	});
});

describe('clearReadCache (§3.11 discipline — logout/account switch)', () => {
	it('wipes both the storage and the touched-keys guard', async () => {
		await setCachedRow('dialog_messages', 'a', { message_id: 'a' });
		markTouched('dialog_messages', 'b');

		await clearReadCache();

		expect(await getCachedRow('dialog_messages', 'a')).toBeNull();
		expect(isTouched('dialog_messages', 'b')).toBe(false);
	});
});

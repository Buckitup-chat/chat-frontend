import { describe, it, expect, beforeEach } from 'vitest';
import {
	setCachedRow, deleteCachedRow, getCachedRow, getCachedRows,
	markTouched, isTouched, mirrorInto, clearReadCache, reconcileWithCache,
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
		await Promise.resolve();

		expect(isTouched('dialog_messages', 'dmsg_1')).toBe(true);
		expect(await getCachedRow('dialog_messages', 'dmsg_1')).toBeNull();
	});

	it('a later delete from the collection removes the mirrored row', async () => {
		const coll = fakeCollection([{ key: 'dmsg_1', value: { message_id: 'dmsg_1' } }]);
		mirrorInto(coll, 'dialog_messages');
		await Promise.resolve();

		coll.emit([{ key: 'dmsg_1', type: 'delete' }]);
		await Promise.resolve();

		expect(storage.map.has('dialog_messages:dmsg_1')).toBe(false);
	});

	it('unsubscribe un-touches exactly the keys this subscription touched, so a reopened dialog can use the fallback again', async () => {
		const coll = fakeCollection([{ key: 'dmsg_1', value: { message_id: 'dmsg_1', content_b64: 'seen' } }]);
		const unsubscribe = mirrorInto(coll, 'dialog_messages');
		await Promise.resolve();
		expect(isTouched('dialog_messages', 'dmsg_1')).toBe(true);

		unsubscribe();

		expect(isTouched('dialog_messages', 'dmsg_1')).toBe(false);
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
		expect(isTouched('dialog_messages', 'b')).toBe(true);
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

describe('reconcileWithCache: the IndexedDB read-cache fallback boundary (v3 "IndexedDB read cache")', () => {
	const byMessageId = (r: { message_id: string }) => r.message_id;

	it('fills in previously mirrored rows of the requested dialog when the live set is empty (offline reload)', async () => {
		await setCachedRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1' });
		await setCachedRow('dialog_messages', 'b', { message_id: 'b', dialog_hash: 'd1' });

		const merged = await reconcileWithCache('dialog_messages', [], byMessageId, (r) => r.dialog_hash === 'd1');

		expect(merged.map(byMessageId).sort()).toEqual(['a', 'b']);
	});

	it('never mixes in a cached row of a different dialog_hash', async () => {
		await setCachedRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1' });
		await setCachedRow('dialog_messages', 'other', { message_id: 'other', dialog_hash: 'd2' });

		const merged = await reconcileWithCache('dialog_messages', [], byMessageId, (r) => r.dialog_hash === 'd1');

		expect(merged.map(byMessageId)).toEqual(['a']);
	});

	it('a live row always wins over a stale cached row with the same key (canonical priority)', async () => {
		await setCachedRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1', content_b64: 'stale' });
		const live = [{ message_id: 'a', dialog_hash: 'd1', content_b64: 'fresh' }];

		const merged = await reconcileWithCache('dialog_messages', live, byMessageId, (r) => r.dialog_hash === 'd1');

		expect(merged).toEqual([{ message_id: 'a', dialog_hash: 'd1', content_b64: 'fresh' }]);
	});

	it('a key touched (updated or deleted) by this session never resurrects from the disk cache', async () => {
		await setCachedRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1' });
		markTouched('dialog_messages', 'a');

		const merged = await reconcileWithCache('dialog_messages', [], byMessageId, (r) => r.dialog_hash === 'd1');

		expect(merged).toEqual([]);
	});

	it('with no predicate, merges every untouched cached row of the table', async () => {
		await setCachedRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1' });
		await setCachedRow('dialog_messages', 'b', { message_id: 'b', dialog_hash: 'd2' });

		const merged = await reconcileWithCache('dialog_messages', [], byMessageId);

		expect(merged.map(byMessageId).sort()).toEqual(['a', 'b']);
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, effectScope, type EffectScope } from 'vue';
import { useCollectionRows } from '@/lib/data/useCollection';
import { setCachedRow, markTouched, _setReadCacheStorageForTests, _resetTouchedForTests } from '@/lib/data/readCache';
import { memoryDialogCacheStore } from './helpers/mainDialogCache';
import { _setDialogCacheStoreForTests } from '@/lib/data/dialogCache';

let dialogCache: ReturnType<typeof memoryDialogCacheStore>;
const setDialogCacheRow = (table: string, _key: string, row: Record<string, unknown>) => dialogCache.seed(table, row);

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const flushAsync = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

const byMessageId = (r: { message_id: string }) => r.message_id;

type Row = { message_id: string; dialog_hash: string; content_b64?: string };

const makeFlakyCollection = (rejectPreload: { value: boolean }) => {
	const rows = new Map<string, Row>();
	let sub: (() => void) | null = null;
	return {
		rows,
		preload: vi.fn(() => (rejectPreload.value ? Promise.reject(new Error('offline')) : Promise.resolve())),
		get toArray() { return [...rows.values()]; },
		subscribeChanges: (cb: () => void) => { sub = cb; return { unsubscribe: () => { sub = null; } }; },
		deliver(row: Row) { rows.set(row.message_id, row); sub?.(); },
	};
};

let activeScope: EffectScope | null = null;
const withScope = <T>(fn: () => T): T => {
	activeScope = effectScope();
	return activeScope.run(fn) as T;
};

beforeEach(async () => {
	dialogCache = memoryDialogCacheStore();
	_setDialogCacheStoreForTests(dialogCache as never);
	_setReadCacheStorageForTests(makeStorage());
	_resetTouchedForTests();
});

afterEach(() => {
	activeScope?.stop();
	activeScope = null;
	vi.useRealTimers();
});

describe('useCollectionRows: IndexedDB read-cache fallback', () => {
	it('surfaces previously mirrored rows of this scope once a preload attempt fails and persistence is unavailable', async () => {
		await setDialogCacheRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1' });
		const coll = makeFlakyCollection({ value: true });

		const result = withScope(() =>
			useCollectionRows(ref(coll), { readCache: { table: 'dialog_messages', dialogHash: () => 'd1', getRowKey: byMessageId } })
		);
		await flushAsync();

		expect(result.rows.value.map(byMessageId)).toEqual(['a']);
		expect(result.ready.value).toBe(true);
	});

	it('never mixes in a cached row from a different dialog_hash', async () => {
		await setDialogCacheRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1' });
		await setDialogCacheRow('dialog_messages', 'other', { message_id: 'other', dialog_hash: 'd2' });
		const coll = makeFlakyCollection({ value: true });

		const result = withScope(() =>
			useCollectionRows(ref(coll), { readCache: { table: 'dialog_messages', dialogHash: () => 'd1', getRowKey: byMessageId } })
		);
		await flushAsync();

		expect(result.rows.value.map(byMessageId)).toEqual(['a']);
	});

	it('a touched (already updated/deleted this session) cached row never resurrects', async () => {
		await setDialogCacheRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1' });
		markTouched('dialog_messages', 'a');
		const coll = makeFlakyCollection({ value: true });

		const result = withScope(() =>
			useCollectionRows(ref(coll), { readCache: { table: 'dialog_messages', dialogHash: () => 'd1', getRowKey: byMessageId } })
		);
		await flushAsync();

		expect(result.rows.value).toEqual([]);
	});

	it('once the collection actually attaches, canonical live rows replace the cached fallback entirely', async () => {
		vi.useFakeTimers();
		await setDialogCacheRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1', content_b64: 'stale' });
		const rejectPreload = { value: true };
		const coll = makeFlakyCollection(rejectPreload);

		const result = withScope(() =>
			useCollectionRows(ref(coll), { readCache: { table: 'dialog_messages', dialogHash: () => 'd1', getRowKey: byMessageId } })
		);
		await flushAsync();
		expect(result.rows.value.map(byMessageId)).toEqual(['a']);

		coll.deliver({ message_id: 'a', dialog_hash: 'd1', content_b64: 'fresh' });
		rejectPreload.value = false;
		await vi.advanceTimersByTimeAsync(1000);
		await flushAsync();

		expect(result.rows.value).toEqual([{ message_id: 'a', dialog_hash: 'd1', content_b64: 'fresh' }]);
	});

	it('a cached row disappears for good once a successful retry loads the canonical set without it', async () => {
		vi.useFakeTimers();
		await setDialogCacheRow('dialog_messages', 'gone', { message_id: 'gone', dialog_hash: 'd1', content_b64: 'stale' });
		const rejectPreload = { value: true };
		const coll = makeFlakyCollection(rejectPreload);

		const result = withScope(() =>
			useCollectionRows(ref(coll), { readCache: { table: 'dialog_messages', dialogHash: () => 'd1', getRowKey: byMessageId } })
		);
		await flushAsync();
		expect(result.rows.value.map(byMessageId)).toEqual(['gone']);

		rejectPreload.value = false;
		await vi.advanceTimersByTimeAsync(1000);
		await flushAsync();

		expect(result.rows.value).toEqual([]);

		coll.deliver({ message_id: 'unrelated', dialog_hash: 'd1' });
		await flushAsync();
		expect(result.rows.value.map(byMessageId)).toEqual(['unrelated']);
	});

	it('a preload failure never hides a live row the collection already has from warm persistence', async () => {
		await setDialogCacheRow('dialog_messages', 'a', { message_id: 'a', dialog_hash: 'd1', content_b64: 'stale-old' });
		const coll = makeFlakyCollection({ value: true });
		coll.rows.set('a', { message_id: 'a', dialog_hash: 'd1', content_b64: 'fresh-live' });

		const result = withScope(() =>
			useCollectionRows(ref(coll), { readCache: { table: 'dialog_messages', dialogHash: () => 'd1', getRowKey: byMessageId } })
		);
		await flushAsync();

		expect(result.rows.value).toEqual([{ message_id: 'a', dialog_hash: 'd1', content_b64: 'fresh-live' }]);
	});

	it('a preload failure still fills in a cache-only row alongside whatever the collection already has live', async () => {
		await setDialogCacheRow('dialog_messages', 'cache-only', { message_id: 'cache-only', dialog_hash: 'd1' });
		const coll = makeFlakyCollection({ value: true });
		coll.rows.set('warm', { message_id: 'warm', dialog_hash: 'd1', content_b64: 'already-live' });

		const result = withScope(() =>
			useCollectionRows(ref(coll), { readCache: { table: 'dialog_messages', dialogHash: () => 'd1', getRowKey: byMessageId } })
		);
		await flushAsync();

		expect(result.rows.value.map(byMessageId).sort()).toEqual(['cache-only', 'warm']);
	});

	it('when preload succeeds normally (primary persistence working), rows come from the live collection only — the fallback changes nothing', async () => {
		await setDialogCacheRow('dialog_messages', 'stale-unrelated', { message_id: 'stale-unrelated', dialog_hash: 'd1' });
		const coll = makeFlakyCollection({ value: false });
		coll.rows.set('a', { message_id: 'a', dialog_hash: 'd1', content_b64: 'live' });

		const result = withScope(() =>
			useCollectionRows(ref(coll), { readCache: { table: 'dialog_messages', dialogHash: () => 'd1', getRowKey: byMessageId } })
		);
		await flushAsync();

		expect(result.rows.value).toEqual([{ message_id: 'a', dialog_hash: 'd1', content_b64: 'live' }]);
	});

	it('without the readCache option, behaves exactly as before (no fallback, e.g. user_cards)', async () => {
		await setCachedRow('user_cards', 'u1', { user_hash: 'u1' });
		const coll = makeFlakyCollection({ value: true });

		const result = withScope(() => useCollectionRows(ref(coll)));
		await flushAsync();

		expect(result.rows.value).toEqual([]);
	});
});

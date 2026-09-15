import { describe, it, expect, beforeEach, vi } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32);

let online = false;
const sent: unknown[][] = [];

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: unknown[]) => {
			if (!online) throw new TypeError('Failed to fetch');
			sent.push(mutations);
			return {
				status: 200,
				json: async () => ({
					results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })),
				}),
			} as unknown as Response;
		},
	},
}));

const awaitShapeVisibility = vi.fn(async (_collection: unknown, _txids: number[], _label?: string) => true);
vi.mock('@/lib/data/barrier', () => ({
	awaitShapeVisibility: (collection: unknown, txids: number[], label?: string) =>
		awaitShapeVisibility(collection, txids, label),
	collectionForRelation: () => null,
	scopeForRelation: (relation: string) => relation,
}));

const { sendMutationsAndAwaitShape, drainPendingWrites } = await import('@/lib/data/ingest');
const { pendingEntries, stopDrainLoop, _setStorageForTests } = await import('@/lib/data/outbox');

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

const message = (text: string) => ({
	type: 'insert',
	modified: { message_id: `dmsg_${text}`, sender_hash: MY_HASH, content_b64: text },
	syncMetadata: { relation: 'dialog_messages' },
});

beforeEach(() => {
	online = false;
	sent.length = 0;
	awaitShapeVisibility.mockClear();
	_setStorageForTests(makeStorage());
});

describe('sender-coordinator: one dispatch path for live-send, retry and replay', () => {
	it('awaits shape visibility on a background retry, not only on the first attempt', async () => {
		vi.useFakeTimers();
		try {
			await sendMutationsAndAwaitShape([message('a')], SKEY, { retries: 0 }).catch(() => {});
			expect(awaitShapeVisibility).not.toHaveBeenCalled();

			online = true;
			await vi.advanceTimersByTimeAsync(60_000);

			expect(sent).toHaveLength(1);
			expect(await pendingEntries(MY_HASH)).toHaveLength(0);
			expect(awaitShapeVisibility).toHaveBeenCalledTimes(1);
		} finally {
			stopDrainLoop();
			vi.useRealTimers();
		}
	});

	it('awaits shape visibility when replaying after a reload', async () => {
		await sendMutationsAndAwaitShape([message('b')], SKEY, { retries: 0 }).catch(() => {});
		expect(awaitShapeVisibility).not.toHaveBeenCalled();

		online = true;
		drainPendingWrites(MY_HASH, SKEY);
		await vi.waitFor(async () => expect(await pendingEntries(MY_HASH)).toHaveLength(0));

		expect(sent).toHaveLength(1);
		expect(awaitShapeVisibility).toHaveBeenCalledTimes(1);
		stopDrainLoop();
	});
});

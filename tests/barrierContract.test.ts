// The barrier obeys the operation's contract: an 'accepted' write returns on
// server confirmation, a 'visible' write awaits its shape echo. Holding a
// receipt for 30s of replication lag bought nothing — nothing ever reads a
// receipt back as a write base.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const awaitShapeVisibility = vi.fn(async () => true);

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: unknown[]) => ({
			status: 200,
			json: async () => ({
				results: mutations.map((_, index) => ({ index, status: 'ok', txid: 7 + index })),
			}),
		}),
	},
}));
vi.mock('@/lib/data/barrier', () => ({
	awaitShapeVisibility,
	collectionForRelation: () => ({}),
	scopeForRelation: (relation: string) => relation,
}));

const { sendMutationsAndAwaitShape } = await import('@/lib/data/ingest');
const { _setStorageForTests, _setLeaderForTests } = await import('@/lib/data/outbox');

const MY = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32);

const mutation = (relation: string, type: string) =>
	[{ type, syncMetadata: { relation }, modified: { sender_hash: MY, peer_hash: MY } }];

beforeEach(() => {
	awaitShapeVisibility.mockClear();
	const map = new Map<string, string>();
	_setStorageForTests({
		async get(k) { return map.get(k) ?? null; },
		async set(k, v) { map.set(k, v); },
		async delete(k) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	});
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
});

describe('contract-driven barrier', () => {
	it('an accepted-level write does not wait for the shape', async () => {
		await sendMutationsAndAwaitShape(mutation('dialog_message_receipts', 'insert'), SKEY, { retries: 0 });
		expect(awaitShapeVisibility).not.toHaveBeenCalled();
	});

	it('an unknown relation falls back to awaiting — weaker guarantees are opt-in', async () => {
		// an unknown relation also has no owner mapping — durable enqueue is
		// impossible, which is its own guarantee; best-effort isolates the barrier
		await sendMutationsAndAwaitShape(mutation('future_relation', 'insert'), SKEY, { retries: 0, durability: 'best-effort' });
		expect(awaitShapeVisibility).toHaveBeenCalledTimes(1);
	});
});

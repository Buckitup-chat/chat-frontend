import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32);

const sent: unknown[][] = [];

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: unknown[]) => {
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

const { sendMutationsAndAwaitShape } = await import('@/lib/data/ingest');
const { enqueue, pendingEntries, stopDrainLoop, _setStorageForTests, _setLeaderForTests } = await import('@/lib/data/outbox');

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

// user_cards/update: chained like the old user_storage fixture, but at
// 'accepted' level — user_storage is back on shape visibility until its
// accepted-base lifecycle exists, which would make this harness (with no
// collection wired) wait for an echo that cannot come.
const chainedUpdate = () => ([{
	type: 'update',
	modified: { user_hash: MY_HASH, name: 'v2' },
	syncMetadata: { relation: 'user_cards' },
}]);

beforeEach(() => {
	sent.length = 0;
	_setStorageForTests(makeStorage());
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
});

describe('sendMutationsAndAwaitShape: leader still waits its turn behind an unresolved chained predecessor (§4.2/§7.1)', () => {
	it('does not reach the network for a chained write while an older write of the same entity is still pending', async () => {
		await enqueue(chainedUpdate(), MY_HASH);

		const handle = await sendMutationsAndAwaitShape(chainedUpdate(), SKEY, { retries: 0 });

		expect(sent).toHaveLength(0);
		expect(handle.phase).toBe('queued');
		expect(handle.outboxId).toBeTruthy();
		expect(handle.result).toBeUndefined();
		const pending = await pendingEntries(MY_HASH);
		expect(pending).toHaveLength(2);
	});

	it('still dispatches immediately when there is no unresolved predecessor', async () => {
		const handle = await sendMutationsAndAwaitShape(chainedUpdate(), SKEY, { retries: 0 });

		expect(sent).toHaveLength(1);
		expect(handle.phase).toBe('accepted');
		expect(handle.result?.txids).toEqual([100]);
		await expect(handle.acceptance).resolves.toEqual({ kind: 'accepted' });
	});
});

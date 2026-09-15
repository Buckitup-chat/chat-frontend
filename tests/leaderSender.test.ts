import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32);

let online = true;
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

const { sendMutationsAndAwaitShape, drainPendingWrites } = await import('@/lib/data/ingest');
const { enqueue, onOutboxWake, pendingEntries, stopDrainLoop, _setStorageForTests, _setLeaderForTests } = await import('@/lib/data/outbox');

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
	online = true;
	sent.length = 0;
	_setStorageForTests(makeStorage());
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
});

describe('sendMutationsAndAwaitShape: non-leader tabs durably enqueue but never send (§5.1)', () => {
	it('does not reach the network when this tab is not the leader', async () => {
		_setLeaderForTests(false);

		const result = await sendMutationsAndAwaitShape([message('a')], SKEY, { retries: 0 });

		expect(sent).toHaveLength(0);
		expect(result).toEqual({ txids: [], results: [] });
		const pending = await pendingEntries(MY_HASH);
		expect(pending).toHaveLength(1);
		expect(pending[0].relation).toBe('dialog_messages');
	});

	it('sends normally when this tab is the leader', async () => {
		_setLeaderForTests(true);

		await sendMutationsAndAwaitShape([message('b')], SKEY, { retries: 0 });

		expect(sent).toHaveLength(1);
		expect(await pendingEntries(MY_HASH)).toHaveLength(0);
	});

	it('the leader tab drains a non-leader tab\'s durable write once it becomes leader', async () => {
		_setLeaderForTests(false);
		await sendMutationsAndAwaitShape([message('c')], SKEY, { retries: 0 });
		expect(sent).toHaveLength(0);
		expect(await pendingEntries(MY_HASH)).toHaveLength(1);

		_setLeaderForTests(true);
		drainPendingWrites(MY_HASH, SKEY);
		await vi.waitFor(async () => expect(await pendingEntries(MY_HASH)).toHaveLength(0));

		expect(sent).toHaveLength(1);
	});
});

describe('onOutboxWake: a durable enqueue notifies other tabs (§5.1)', () => {
	it('wakes another tab\'s listener with the enqueuing entry\'s userHash', async () => {
		const otherTab = new BroadcastChannel('buckitup-outbox-wake');
		const woken: string[] = [];
		otherTab.addEventListener('message', (ev: MessageEvent<{ userHash: string }>) => woken.push(ev.data.userHash));
		try {
			await enqueue([message('wake')], MY_HASH);
			await vi.waitFor(() => expect(woken).toContain(MY_HASH));
		} finally {
			otherTab.close();
		}
	});

	it('this tab\'s own onOutboxWake subscription can be added and removed without error', () => {
		const unsubscribe = onOutboxWake(() => {});
		expect(() => unsubscribe()).not.toThrow();
	});
});

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

const { sendMutationsAndAwaitShape, drainPendingWrites, IngestError } = await import('@/lib/data/ingest');
const {
	enqueue, onOutboxWake, pendingEntries, quarantinedEntries, requeueEntry, recordFailure,
	stopDrainLoop, _setStorageForTests, _setLeaderForTests,
} = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

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
	_setAcceptedSnapshotStorageForTests(makeStorage());
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
});

describe('sendMutationsAndAwaitShape: non-leader tabs durably enqueue but never send (§5.1)', () => {
	it('does not reach the network when this tab is not the leader', async () => {
		_setLeaderForTests(false);

		const handle = await sendMutationsAndAwaitShape([message('a')], SKEY, { retries: 0 });

		expect(sent).toHaveLength(0);
		expect(handle.phase).toBe('queued');
		expect(handle.result).toBeUndefined();
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

describe('onOutboxWake: destination semantics (§5.1, §L17-08 follow-up)', () => {
	it('a fresh enqueue wakes another tab\'s listener with the enqueuing entry\'s userHash', async () => {
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

	it('a fresh enqueue does NOT wake this tab\'s own onOutboxWake subscriber', async () => {
		const woken: string[] = [];
		const unsubscribe = onOutboxWake((userHash) => woken.push(userHash));
		try {
			await enqueue([message('no-local-wake-on-enqueue')], MY_HASH);
			expect(woken).toEqual([]);
		} finally {
			unsubscribe();
		}
	});

	it('this tab\'s own onOutboxWake subscription can be added and removed without error', () => {
		const unsubscribe = onOutboxWake(() => {});
		expect(() => unsubscribe()).not.toThrow();
	});

	it('an explicit requeue wakes THIS tab\'s own onOutboxWake subscriber exactly once, not just other tabs', async () => {
		const outboxId = await enqueue([message('local-wake')], MY_HASH);
		await recordFailure(outboxId, new IngestError('rejected', { permanent: true }));

		const woken: string[] = [];
		const unsubscribe = onOutboxWake((userHash) => woken.push(userHash));
		try {
			await requeueEntry(outboxId as string);

			expect(woken).toEqual([MY_HASH]);
		} finally {
			unsubscribe();
		}
	});

	it('an explicit requeue also notifies other tabs', async () => {
		const outboxId = await enqueue([message('quarantined')], MY_HASH);
		await recordFailure(outboxId, new IngestError('rejected', { permanent: true }));
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);

		const otherTab = new BroadcastChannel('buckitup-outbox-wake');
		const woken: string[] = [];
		otherTab.addEventListener('message', (ev: MessageEvent<{ userHash: string }>) => woken.push(ev.data.userHash));
		try {
			await requeueEntry(outboxId as string);
			await vi.waitFor(() => expect(woken).toContain(MY_HASH));
		} finally {
			otherTab.close();
		}
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(0);
		expect(await pendingEntries(MY_HASH)).toHaveLength(1);
	});

	it('sole-tab Retry actually resumes sending — a real drain, not just a message', async () => {
		_setLeaderForTests(true);
		const unsubscribe = onOutboxWake((userHash) => {
			if (userHash === MY_HASH) drainPendingWrites(MY_HASH, SKEY);
		});
		try {
			online = false;
			const outboxId = await enqueue([message('sole-tab-retry')], MY_HASH);
			await recordFailure(outboxId, new IngestError('rejected', { permanent: true }));
			expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);
			expect(sent).toHaveLength(0); // offline: nothing could have been sent yet

			online = true;
			await requeueEntry(outboxId as string);

			await vi.waitFor(() => expect(sent).toHaveLength(1));
			expect(await pendingEntries(MY_HASH)).toHaveLength(0);
		} finally {
			unsubscribe();
		}
	});

	it('an unsubscribed handler is not called by a later requeue', async () => {
		const woken: string[] = [];
		const unsubscribe = onOutboxWake((userHash) => woken.push(userHash));
		unsubscribe();

		const outboxId = await enqueue([message('unsubscribed')], MY_HASH);
		await recordFailure(outboxId, new IngestError('rejected', { permanent: true }));
		await requeueEntry(outboxId as string);

		expect(woken).toEqual([]);
	});

	it('an unsubscribed handler is not called by another tab\'s wake either', async () => {
		const otherTab = new BroadcastChannel('buckitup-outbox-wake');
		const woken: string[] = [];
		const unsubscribe = onOutboxWake((userHash) => woken.push(userHash));
		unsubscribe();
		try {
			otherTab.postMessage({ userHash: MY_HASH });
			await new Promise((r) => setTimeout(r, 20));
			expect(woken).toEqual([]);
		} finally {
			otherTab.close();
		}
	});

	it('one requeue wakes a local subscriber exactly once — no wake loop', async () => {
		let calls = 0;
		const unsubscribe = onOutboxWake(() => { calls++; });
		try {
			const outboxId = await enqueue([message('once')], MY_HASH);
			await recordFailure(outboxId, new IngestError('rejected', { permanent: true }));
			calls = 0; // only count the requeue's own wake

			await requeueEntry(outboxId as string);
			await new Promise((r) => setTimeout(r, 20));

			expect(calls).toBe(1);
		} finally {
			unsubscribe();
		}
	});

	it('requeueEntry preserves attempts and lastError — only status/quarantinedAt change', async () => {
		const outboxId = await enqueue([message('history')], MY_HASH);
		await recordFailure(outboxId, new IngestError('rejected', { permanent: true }));
		const before = (await quarantinedEntries(MY_HASH))[0];
		expect(before.attempts).toBe(1);
		expect(before.lastError).toBe('rejected');
		expect(before.quarantinedAt).toBeTypeOf('number');

		await requeueEntry(outboxId as string);

		const after = (await pendingEntries(MY_HASH))[0];
		expect(after.attempts).toBe(before.attempts);
		expect(after.lastError).toBe(before.lastError);
		expect(after.status).toBe('pending');
		expect(after.quarantinedAt).toBeUndefined();
	});
});

describe('onOutboxWake: local listener isolation', () => {
	it('one throwing local listener does not stop the next listener from running', async () => {
		const calls: string[] = [];
		const unsubBad = onOutboxWake(() => { calls.push('bad'); throw new Error('boom'); });
		const unsubGood = onOutboxWake(() => { calls.push('good'); });
		try {
			const outboxId = await enqueue([message('isolation-order')], MY_HASH);
			await recordFailure(outboxId, new IngestError('rejected', { permanent: true }));
			calls.length = 0;

			await requeueEntry(outboxId as string);

			expect(calls).toContain('bad');
			expect(calls).toContain('good');
		} finally {
			unsubBad();
			unsubGood();
		}
	});

	it('a throwing local listener does not fail requeueEntry, and cross-tab notification still happens', async () => {
		const otherTab = new BroadcastChannel('buckitup-outbox-wake');
		const woken: string[] = [];
		otherTab.addEventListener('message', (ev: MessageEvent<{ userHash: string }>) => woken.push(ev.data.userHash));
		const unsubscribe = onOutboxWake(() => { throw new Error('boom'); });
		try {
			const outboxId = await enqueue([message('isolation-durability')], MY_HASH);
			await recordFailure(outboxId, new IngestError('rejected', { permanent: true }));

			await expect(requeueEntry(outboxId as string)).resolves.toBeUndefined();

			const [entry] = await pendingEntries(MY_HASH);
			expect(entry.status).toBe('pending');
			await vi.waitFor(() => expect(woken).toContain(MY_HASH));
		} finally {
			unsubscribe();
			otherTab.close();
		}
	});
});

describe('no duplicate live transport from the local-wake race (§L17-08 follow-up)', () => {
	it('a fresh leader live write reaches transport exactly once — no local-wake replay race', async () => {
		_setLeaderForTests(true);
		const unsubscribe = onOutboxWake((userHash) => {
			if (userHash === MY_HASH) drainPendingWrites(MY_HASH, SKEY);
		});
		try {
			await sendMutationsAndAwaitShape([message('no-duplicate-live')], SKEY, { retries: 0 });
			await new Promise((r) => setTimeout(r, 100));

			expect(sent).toHaveLength(1);
			expect(await pendingEntries(MY_HASH)).toHaveLength(0);
		} finally {
			unsubscribe();
		}
	});

	it('retrying the same entry after quarantine also dispatches exactly once', async () => {
		_setLeaderForTests(true);
		const unsubscribe = onOutboxWake((userHash) => {
			if (userHash === MY_HASH) drainPendingWrites(MY_HASH, SKEY);
		});
		try {
			online = false;
			const outboxId = await enqueue([message('retry-once')], MY_HASH);
			await recordFailure(outboxId, new IngestError('rejected', { permanent: true }));
			online = true;

			await requeueEntry(outboxId as string);
			await vi.waitFor(() => expect(sent).toHaveLength(1));
			await new Promise((r) => setTimeout(r, 100));

			expect(sent).toHaveLength(1);
			expect(await pendingEntries(MY_HASH)).toHaveLength(0);
		} finally {
			unsubscribe();
		}
	});
});

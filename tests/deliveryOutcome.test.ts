import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);
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
	enqueue, recordFailure, discardEntry, resolveEntry, awaitEntryOutcome,
	quarantinedEntries, pendingEntries,
	stopDrainLoop, _setStorageForTests, _setLeaderForTests,
	startLeaderElection, stopLeaderElection,
} = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

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

const message = (text: string, userHash = MY_HASH) => ([{
	type: 'insert',
	modified: { message_id: `dmsg_${text}`, sender_hash: userHash, content_b64: text },
	syncMetadata: { relation: 'dialog_messages' },
}]);

const editMessage = (messageId: string, text: string) => ([{
	type: 'update',
	modified: { message_id: messageId, sender_hash: MY_HASH, content_b64: text, dialog_hash: 'dh1', parent_sign_hash: null, owner_timestamp: 1 },
	syncMetadata: { relation: 'dialog_messages' },
}]);

beforeEach(() => {
	online = true;
	sent.length = 0;
	_setStorageForTests(makeStorage());
	_setAcceptedSnapshotStorageForTests(makeStorage());
});

afterEach(() => {
	_setLeaderForTests(null);
	stopLeaderElection();
	stopDrainLoop();
});

describe('DeliveryHandle: leader with no dependency', () => {
	it('1. direct transport; acceptance settles on exact success; exactly one transport call', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});

		const handle = await sendMutationsAndAwaitShape(message('leader-direct'), SKEY, { retries: 0 });

		expect(handle.phase).toBe('accepted');
		expect(sent).toHaveLength(1);
		await expect(handle.acceptance).resolves.toEqual({ kind: 'accepted' });
		expect(sent).toHaveLength(1); // acceptance itself triggers no further transport
	});
});

describe('DeliveryHandle: follower', () => {
	it('2. durable enqueue completes with phase:queued; acceptance stays pending until the leader drain actually accepts it', async () => {
		_setLeaderForTests(false);
		startLeaderElection(MY_HASH, () => {});

		const handle = await sendMutationsAndAwaitShape(message('follower'), SKEY, { retries: 0 });
		expect(handle.phase).toBe('queued');
		expect(handle.result).toBeUndefined();
		expect(sent).toHaveLength(0);

		let settled = false;
		void handle.acceptance.then(() => { settled = true; });
		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false); // not accepted just because enqueue resolved

		_setLeaderForTests(true);
		drainPendingWrites(MY_HASH, SKEY);

		await expect(handle.acceptance).resolves.toEqual({ kind: 'accepted' });
		expect(sent).toHaveLength(1);
	});
});

describe('DeliveryHandle: dependency', () => {
	it('3. B queued behind A: acceptance does not settle until A resolves and B is drained', async () => {
		_setLeaderForTests(true);
		startLeaderElection(MY_HASH, () => {});
		const aId = await enqueue(editMessage('msg_dep', 'a'), MY_HASH);

		const bHandle = await sendMutationsAndAwaitShape(editMessage('msg_dep', 'b'), SKEY, { retries: 0 });
		expect(bHandle.phase).toBe('queued'); // durably queued, not yet known — B never jumps its own recorded dependency
		expect(sent).toHaveLength(0);

		await expect(bHandle.acceptance).resolves.toEqual({ kind: 'accepted' });

		expect(sent).toHaveLength(2); // A (the prerequisite), then B — never B first
		expect((sent[0][0] as { modified: { content_b64: string } }).modified.content_b64).toBe('a');
		expect((sent[1][0] as { modified: { content_b64: string } }).modified.content_b64).toBe('b');
		void aId;
	});
});

describe('DeliveryHandle: a quarantined or discarded prerequisite', () => {
	it('4a. A quarantined: B\'s acceptance never settles as success, B stays blocked', async () => {
		_setLeaderForTests(true);
		const aId = await enqueue(editMessage('msg_dep2', 'a'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));

		const bHandle = await sendMutationsAndAwaitShape(editMessage('msg_dep2', 'b'), SKEY, { retries: 0 });
		expect(bHandle.phase).toBe('queued');

		drainPendingWrites(MY_HASH, SKEY);
		await new Promise((r) => setTimeout(r, 30));

		expect(sent).toHaveLength(0); // B never sent — A blocks it, quarantined or not
		expect((await pendingEntries(MY_HASH)).some((e) => e.id === bHandle.outboxId)).toBe(true);
	});

	it('4b. A discarded AFTER B already depends on it: B stays blocked, acceptance never settles as success', async () => {
		_setLeaderForTests(true);
		const aId = await enqueue(editMessage('msg_dep3', 'a'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));

		const bHandle = await sendMutationsAndAwaitShape(editMessage('msg_dep3', 'b'), SKEY, { retries: 0 });
		expect(bHandle.phase).toBe('queued');

		await discardEntry(aId as string);

		drainPendingWrites(MY_HASH, SKEY);
		await new Promise((r) => setTimeout(r, 30));

		expect(sent).toHaveLength(0);
		expect((await pendingEntries(MY_HASH)).some((e) => e.id === bHandle.outboxId)).toBe(true);
	});
});

describe('DeliveryHandle: permanent rejection of the entry itself', () => {
	it('5. acceptance settles a typed failure, the entry is quarantined, and the caller never sees a fake success', async () => {
		_setLeaderForTests(false); // queued — the eventual (permanent) verdict is decided later, by a drain
		const handle = await sendMutationsAndAwaitShape(message('permanent-b'), SKEY, { retries: 0 });
		expect(handle.phase).toBe('queued');

		await recordFailure(handle.outboxId, new IngestError('validation_failed', { permanent: true }));

		await expect(handle.acceptance).resolves.toEqual({ kind: 'rejected', error: 'validation_failed' });
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);
	});
});

describe('DeliveryHandle: explicit Discard', () => {
	it('6. acceptance settles a non-accepted terminal outcome — never success', async () => {
		_setLeaderForTests(false);
		const handle = await sendMutationsAndAwaitShape(message('discard-b'), SKEY, { retries: 0 });
		expect(handle.phase).toBe('queued');

		await discardEntry(handle.outboxId as string);

		await expect(handle.acceptance).resolves.toEqual({ kind: 'discarded' });
	});
});

describe('awaitEntryOutcome: races and durability', () => {
	it('7. an entry resolved BEFORE any waiter registers is still seen as accepted (no pre-registration race)', async () => {
		const id = await enqueue(message('race'), MY_HASH);
		await resolveEntry(id);

		const outcome = await awaitEntryOutcome(id as string, MY_HASH);

		expect(outcome).toEqual({ kind: 'accepted' });
	});

	it('8. a missed cross-tab notification is still caught by the fail-safe durable recheck', async () => {
		vi.useFakeTimers();
		try {
			const backing = makeStorage();
			_setStorageForTests(backing);
			const id = await enqueue(message('missed'), MY_HASH);

			const outcomePromise = awaitEntryOutcome(id as string, MY_HASH);

			const raw = JSON.parse(backing.map.get(id as string) as string);
			raw.status = 'quarantined';
			raw.lastError = 'missed-event';
			backing.map.set(id as string, JSON.stringify(raw));

			await vi.advanceTimersByTimeAsync(5_000); // the fail-safe interval, not the primary path
			const outcome = await outcomePromise;

			expect(outcome).toEqual({ kind: 'rejected', error: 'missed-event' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('9. an outcome change for one account does not settle a waiter on a different account\'s own entry', async () => {
		const mineId = await enqueue(message('mine', MY_HASH), MY_HASH);
		const theirsId = await enqueue(message('theirs', OTHER_HASH), OTHER_HASH);

		let theirsSettled = false;
		const theirsWaiter = awaitEntryOutcome(theirsId as string, OTHER_HASH);
		void theirsWaiter.then(() => { theirsSettled = true; });

		await resolveEntry(mineId); // resolves MY_HASH's own entry only
		await new Promise((r) => setTimeout(r, 20));
		expect(theirsSettled).toBe(false); // unaffected by another account's outcome

		await resolveEntry(theirsId);
		await expect(theirsWaiter).resolves.toEqual({ kind: 'accepted' });
	});

	it('13. reload boundary: an in-flight waiter is not itself durable, but the mutation is never lost — a fresh awaitEntryOutcome() after "reload" still learns the real outcome', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);
		_setLeaderForTests(false);
		startLeaderElection(MY_HASH, () => {});

		const handle = await sendMutationsAndAwaitShape(message('reload-boundary'), SKEY, { retries: 0 });
		expect(handle.phase).toBe('queued');
		_setStorageForTests({ ...backing });
		const freshWaiter = awaitEntryOutcome(handle.outboxId as string, MY_HASH);

		_setLeaderForTests(true);
		drainPendingWrites(MY_HASH, SKEY);

		await expect(freshWaiter).resolves.toEqual({ kind: 'accepted' });
		expect(sent).toHaveLength(1); // the mutation itself was replayed exactly once, never lost or duplicated
	});
});

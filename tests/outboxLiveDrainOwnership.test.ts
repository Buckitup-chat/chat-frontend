import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32).fill(7);

interface Gate {
	promise: Promise<void>;
	resolve: () => void;
}
const deferred = (): Gate => {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => { resolve = res; });
	return { promise, resolve };
};

let callCount = 0;
let gates: Gate[] = [];
let mode: 'gate' | 'succeed' | 'fail-permanent' | 'fail-transient' = 'gate';

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: unknown[]) => {
			callCount++;
			if (mode === 'fail-transient') throw new TypeError('Failed to fetch');
			if (mode === 'fail-permanent') {
				return {
					status: 422,
					json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed', details: {} })) }),
				} as unknown as Response;
			}
			if (mode === 'gate') {
				const gate = deferred();
				gates.push(gate);
				await gate.promise;
			}
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		},
	},
}));

const { sendMutationsAndAwaitShape, sendMutationsWithRetry } = await import('@/lib/data/ingest');
const { dispatchMutations, AlreadyDispatchingError } = await import('@/lib/data/coordinator');
const {
	enqueue, drainOutbox, pendingEntries, quarantinedEntries,
	tryClaimOutboxEntry, releaseOutboxEntry,
	startLeaderElection, stopLeaderElection, stopDrainLoop,
	_setStorageForTests, _setLeaderForTests, _clearInFlightForTests,
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
let storage: ReturnType<typeof makeStorage>;

const message = (id: string, text: string) => ([{
	type: 'insert',
	modified: {
		message_id: id, sender_hash: MY_HASH, content_b64: text,
		dialog_hash: 'dh1', deleted_flag: false, owner_timestamp: 1, parent_sign_hash: null,
	},
	syncMetadata: { relation: 'dialog_messages' },
}]);

const drainSend = (mutations: unknown[]) => sendMutationsWithRetry(mutations, SKEY, { retries: 1 });

const forceEntryDue = async (id: string) => {
	const raw = storage.map.get(id);
	if (!raw) throw new Error(`no such entry ${id}`);
	const parsed = JSON.parse(raw);
	parsed.nextAttemptAt = Date.now() - 1;
	storage.map.set(id, JSON.stringify(parsed));
};

beforeEach(() => {
	callCount = 0;
	gates = [];
	mode = 'gate';
	storage = makeStorage();
	_setStorageForTests(storage);
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setLeaderForTests(true);
	startLeaderElection(MY_HASH, () => {});
	_clearInFlightForTests();
});

afterEach(() => {
	_setLeaderForTests(null);
	stopLeaderElection();
	stopDrainLoop();
	_clearInFlightForTests();
});

describe('live send owns the entry first', () => {
	it('a concurrently woken drain does not send it again', async () => {
		const handlePromise = sendMutationsAndAwaitShape(message('m1', 'hello'), SKEY, { retries: 0 });
		await vi.waitFor(() => expect(callCount).toBe(1));

		const drainResult = await drainOutbox(MY_HASH, drainSend);
		expect(callCount).toBe(1);
		expect(drainResult.sent).toBe(0);

		gates[0].resolve();
		const handle = await handlePromise;
		expect(handle.phase).toBe('accepted');
		await expect(handle.acceptance).resolves.toEqual({ kind: 'accepted' });
		expect(callCount).toBe(1);
	});
});

describe('drain owns the entry first', () => {
	it('the live path falls back to the queued/observed semantic instead of a duplicate send or a thrown surprise', async () => {
		let drainPromise: ReturnType<typeof drainOutbox> | null = null;

		const handlePromise = sendMutationsAndAwaitShape(message('m2', 'hello'), SKEY, {
			retries: 0,
			onDurable: async () => {
				drainPromise = drainOutbox(MY_HASH, drainSend);
				await vi.waitFor(() => expect(callCount).toBe(1));
			},
		});

		const handle = await handlePromise;
		expect(handle.phase).toBe('queued');
		expect(callCount).toBe(1);

		gates[0].resolve();
		await drainPromise!;
		await expect(handle.acceptance).resolves.toEqual({ kind: 'accepted' });
	});
});

describe('ownership releases on failure', () => {
	it('a transient live-dispatch failure releases the claim; the entry can be claimed and sent again next time', async () => {
		mode = 'fail-transient';
		await expect(sendMutationsAndAwaitShape(message('m3', 'x'), SKEY, { retries: 0 })).rejects.toThrow();
		expect(callCount).toBe(1);

		const [entry] = await pendingEntries(MY_HASH);
		await forceEntryDue(entry.id);
		mode = 'succeed';
		const result = await drainOutbox(MY_HASH, drainSend);

		expect(result.sent).toBe(1);
		expect(callCount).toBe(2);
	});

	it('a permanent live-dispatch rejection releases the claim; the entry is quarantined, not stuck claimed', async () => {
		mode = 'fail-permanent';
		await expect(sendMutationsAndAwaitShape(message('m3b', 'x'), SKEY, { retries: 0 })).rejects.toThrow();

		const [entry] = await quarantinedEntries(MY_HASH);
		expect(entry).toBeTruthy();
		expect(tryClaimOutboxEntry(entry.id)).toBe(true);
		releaseOutboxEntry(entry.id);
	});
});

describe('dispatchMutations: the claim/release mechanism itself', () => {
	it('releases the claim even when send throws before any normal completion handling', async () => {
		const id = 'unit-test-entry-throw';
		const boom = new Error('boom');
		await expect(dispatchMutations([], async () => { throw boom; }, id)).rejects.toThrow('boom');
		expect(tryClaimOutboxEntry(id)).toBe(true);
		releaseOutboxEntry(id);
	});

	it('throws AlreadyDispatchingError, without calling send, when the id is already claimed', async () => {
		const id = 'unit-test-entry-claimed';
		expect(tryClaimOutboxEntry(id)).toBe(true);
		const sendSpy = vi.fn();
		await expect(dispatchMutations([], sendSpy, id)).rejects.toBeInstanceOf(AlreadyDispatchingError);
		expect(sendSpy).not.toHaveBeenCalled();
		releaseOutboxEntry(id);
	});

	it('never claims (and never blocks) when outboxId is null — best-effort durability has nothing to own', async () => {
		const sendSpy = vi.fn(async () => ({ txids: [], results: [] }));
		await expect(dispatchMutations([], sendSpy, null)).resolves.toEqual({ txids: [], results: [] });
		expect(sendSpy).toHaveBeenCalledTimes(1);
	});
});

describe('ownership is per-entry, not global', () => {
	it('a live send for A and a drained send for independent B overlap', async () => {
		await enqueue(message('B', 'b-text'), MY_HASH);

		const handleA = sendMutationsAndAwaitShape(message('A', 'a-text'), SKEY, { retries: 0 });
		await vi.waitFor(() => expect(callCount).toBe(1));

		const drainPromise = drainOutbox(MY_HASH, drainSend);
		await vi.waitFor(() => expect(callCount).toBe(2));

		gates[0].resolve();
		gates[1].resolve();
		await handleA;
		await drainPromise;
	});
});

describe('no leaked ownership after a coordinator restart', () => {
	it('a claim taken before stop/restart still releases when its send completes normally', async () => {
		await enqueue(message('A', 'x'), MY_HASH);
		const drainPromise = drainOutbox(MY_HASH, drainSend);
		await vi.waitFor(() => expect(callCount).toBe(1));

		stopDrainLoop();
		stopLeaderElection();
		startLeaderElection(MY_HASH, () => {});
		_setLeaderForTests(true);

		gates[0].resolve();
		await drainPromise;

		const result = await drainOutbox(MY_HASH, drainSend);
		expect(result.sent).toBe(0);
		expect(callCount).toBe(1);
	});
});

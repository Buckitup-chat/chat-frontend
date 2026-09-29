// The outbox after a lost connection, under the real send lock.
//
// Other outbox tests pin leadership with _setLeaderForTests, which skips the
// send lock entirely; these run the leader election and the lock the way a
// browser does (exclusive Web Locks, `ifAvailable` honoured), because the
// failures they pin only exist where two writes meet a held lock.
//
// What a person saw before: two phones wrote while offline; when the network
// came back each delivered its newer message first, the older one minutes
// later, and the peer showed the newer one as "waiting for earlier messages"
// all that time.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeLocks {
	private held = new Set<string>();
	private waiters = new Map<string, Array<() => void>>();
	async request(name: string, a: unknown, b?: unknown): Promise<unknown> {
		const opts = (typeof a === 'function' ? {} : a) as { ifAvailable?: boolean };
		const cb = (typeof a === 'function' ? a : b) as (lock: unknown) => unknown;
		if (this.held.has(name)) {
			if (opts.ifAvailable) return cb(null);
			await new Promise<void>((resolve) => {
				const q = this.waiters.get(name) ?? [];
				q.push(resolve);
				this.waiters.set(name, q);
			});
		}
		this.held.add(name);
		try {
			return await cb({ name, mode: 'exclusive' });
		} finally {
			const next = this.waiters.get(name)?.shift();
			if (next) next();
			else this.held.delete(name);
		}
	}
}
Object.defineProperty(globalThis, 'navigator', {
	value: { locks: new FakeLocks(), onLine: true },
	configurable: true,
	writable: true,
});

const MY_HASH = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32);
const ROUND_TRIP_MS = 400;

let online = true;
let attempts = 0;
const delivered: Array<{ at: number; id: string }> = [];
let t0 = 0;

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: Array<{ modified: { message_id: string } }>) => {
			attempts++;
			await new Promise((r) => setTimeout(r, ROUND_TRIP_MS));
			if (!online) throw new TypeError('Failed to fetch');
			for (const m of mutations) delivered.push({ at: Date.now() - t0, id: m.modified.message_id });
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		},
	},
}));

const { sendMutationsAndAwaitShape, drainPendingWrites } = await import('@/lib/data/ingest');
const {
	startLeaderElection, stopLeaderElection, stopDrainLoop, isLeader, _setStorageForTests, pendingEntries,
} = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { _setOwnObservedTailsStorageForTests, recordOwnObservedTails } = await import('@/lib/data/ownObservedTails');

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

const message = (id: string) => ({
	type: 'insert',
	modified: { message_id: id, sender_hash: MY_HASH, dialog_hash: 'di_x', content_b64: id, sign_hash: `dms_${id}` },
	syncMetadata: { relation: 'dialog_messages' },
});

/** Compose `id` the way captureMessageIntent does: its refs cite `parents`. */
const compose = async (id: string, parents: string[] = []) => {
	await recordOwnObservedTails(id, Object.fromEntries(parents.map((p) => [p, `dms_${p}`])), MY_HASH);
	return message(id);
};

const at = (id: string) => delivered.find((d) => d.id === id)?.at;

beforeEach(async () => {
	vi.useFakeTimers();
	// A send a test leaves unfinished must not hold the lock into the next one.
	(globalThis.navigator as unknown as { locks: FakeLocks }).locks = new FakeLocks();
	online = true;
	attempts = 0;
	delivered.length = 0;
	_setStorageForTests(makeStorage());
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setOwnObservedTailsStorageForTests(makeStorage());
	startLeaderElection(MY_HASH, () => {});
	await vi.advanceTimersByTimeAsync(10);
	expect(isLeader()).toBe(true);
	t0 = Date.now();
});

afterEach(() => {
	stopDrainLoop();
	stopLeaderElection();
	vi.useRealTimers();
});

describe('one tab under the real send lock', () => {
	it('sends a write issued while another is in flight right after it, not a poll interval later', async () => {
		void sendMutationsAndAwaitShape([await compose('A')], SKEY, { retries: 0 });
		await vi.advanceTimersByTimeAsync(50);
		const b = await sendMutationsAndAwaitShape([await compose('B')], SKEY, { retries: 0 });
		expect(b.phase).toBe('queued');

		await vi.advanceTimersByTimeAsync(3_000);
		expect(at('A')).toBeDefined();
		expect(at('B')).toBeLessThan(2 * ROUND_TRIP_MS + 500);
	});

	it('retries a missing connection once inside a live send that is already in the outbox, then leaves it to the outbox', async () => {
		online = false;
		let outcome = 'pending';
		void sendMutationsAndAwaitShape([await compose('A')], SKEY).then(() => { outcome = 'sent'; }, () => { outcome = 'failed'; });
		await vi.advanceTimersByTimeAsync(2 * ROUND_TRIP_MS + 1_300);
		// One quick retry covers a lost response; after that the outbox owns
		// the retry, and the lock is free for the next write instead of held
		// through seconds of in-process retries.
		expect(outcome).toBe('failed');
		expect(attempts).toBe(2);
		expect((await pendingEntries(MY_HASH)).map((e) => e.lastErrorNetwork)).toEqual([true]);
	});
});

describe('after a lost connection', () => {
	it('delivers a message only after the queued message its refs cite, with no online event', async () => {
		online = false;
		void sendMutationsAndAwaitShape([await compose('A')], SKEY).catch(() => {});
		await vi.advanceTimersByTimeAsync(6_000);
		void sendMutationsAndAwaitShape([await compose('B', ['A'])], SKEY).catch(() => {});
		// The connection comes back without an `online` event (an always-on VPN
		// keeps navigator.onLine true throughout).
		await vi.advanceTimersByTimeAsync(34_000);
		online = true;
		await vi.advanceTimersByTimeAsync(120_000);

		expect(at('A')).toBeDefined();
		expect(at('B')).toBeGreaterThan(at('A')!);
		// Found by the capped connection probe, not by a minutes-long backoff.
		expect(at('A')).toBeLessThan(40_000 + 32_000);
	});

	it('drains at once on the online event even while a live write holds the lock', async () => {
		online = false;
		void sendMutationsAndAwaitShape([await compose('A')], SKEY).catch(() => {});
		await vi.advanceTimersByTimeAsync(6_000);
		void sendMutationsAndAwaitShape([await compose('B', ['A'])], SKEY).catch(() => {});
		await vi.advanceTimersByTimeAsync(34_000);
		online = true;
		drainPendingWrites(MY_HASH, SKEY);
		// A delivered receipt goes out live in the same instant.
		void sendMutationsAndAwaitShape([await compose('R')], SKEY, { retries: 0 }).catch(() => {});
		await vi.advanceTimersByTimeAsync(10_000);

		expect(at('A')).toBeLessThan(40_000 + 3_000);
		expect(at('B')).toBeGreaterThan(at('A')!);
		expect(at('R')).toBeLessThan(40_000 + 3_000);
	});

	it('sends the backlog as soon as any write is answered', async () => {
		online = false;
		void sendMutationsAndAwaitShape([await compose('A')], SKEY).catch(() => {});
		await vi.advanceTimersByTimeAsync(1_000);
		void sendMutationsAndAwaitShape([await compose('B', ['A'])], SKEY).catch(() => {});
		// Long enough offline that A's next attempt is far away.
		await vi.advanceTimersByTimeAsync(60_000);
		online = true;
		const now = Date.now() - t0;
		// A write in another dialog is answered: the connection is proven.
		const other = { ...message('X'), modified: { ...message('X').modified, dialog_hash: 'di_y' } };
		const answered = sendMutationsAndAwaitShape([other], SKEY, { retries: 0 });
		await vi.advanceTimersByTimeAsync(3_000);
		await answered;

		expect(at('X')).toBeLessThan(now + ROUND_TRIP_MS + 100);
		expect(at('A')).toBeLessThan(now + 3_000);
		expect(at('B')).toBeGreaterThan(at('A')!);
	});
});

describe('what a message does not cite, it does not wait for (ADR §7.2)', () => {
	it('lets a message that cites nothing queued go before an older queued one', async () => {
		online = false;
		void sendMutationsAndAwaitShape([await compose('A')], SKEY).catch(() => {});
		// A's live send has given up and left A to the outbox's schedule.
		await vi.advanceTimersByTimeAsync(3_000);
		online = true;
		// B observed the same tails as A (a fork): it does not cite A.
		const b = sendMutationsAndAwaitShape([await compose('B')], SKEY, { retries: 0 });
		await vi.advanceTimersByTimeAsync(ROUND_TRIP_MS + 100);
		expect((await b).phase).toBe('accepted');
		expect(at('B')).toBeDefined();
		expect(at('A')).toBeUndefined();
	});
});

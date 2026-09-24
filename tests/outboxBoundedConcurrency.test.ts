import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	enqueue, drainOutbox, pendingEntries, quarantinedEntries,
	startLeaderElection, stopLeaderElection, stopDrainLoop,
	_setStorageForTests, _setLeaderForTests, _clearInFlightForTests,
	DRAIN_CONCURRENCY,
} from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';

const MY = 'u_' + 'a'.repeat(128);

const makeMemoryStore = () => {
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

const mutation = (text: string) => ({
	type: 'insert',
	modified: { text },
	syncMetadata: { relation: 'dialog_messages' },
});
const textOf = (m: unknown[]) => (m[0] as { modified: { text: string } }).modified.text;

interface Deferred<T = void> {
	promise: Promise<T>;
	resolve: (v: T) => void;
}
const deferred = <T = void>(): Deferred<T> => {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
};

beforeEach(() => {
	_setStorageForTests(makeMemoryStore());
	_setLeaderForTests(true);
	_clearInFlightForTests();
});

afterEach(() => {
	_setLeaderForTests(null);
	stopLeaderElection();
	stopDrainLoop();
	_clearInFlightForTests();
});

describe('bounded concurrency: independent ready entries overlap', () => {
	it('B starts before A resolves', async () => {
		await enqueue([mutation('A')], MY);
		await enqueue([mutation('B')], MY);

		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		const send = async (m: unknown[]) => {
			const text = textOf(m);
			started.push(text);
			const gate = deferred();
			gates.set(text, gate);
			await gate.promise;
		};

		const drainPromise = drainOutbox(MY, send);
		await vi.waitFor(() => expect(started.sort()).toEqual(['A', 'B']));
		expect(gates.size).toBe(2);

		gates.get('A')!.resolve();
		gates.get('B')!.resolve();
		await drainPromise;
	});
});

describe('bounded concurrency: the limit is enforced', () => {
	it('never runs more than DRAIN_CONCURRENCY sends at once, even with more ready entries than the limit', async () => {
		const total = DRAIN_CONCURRENCY + 2;
		for (let i = 0; i < total; i++) await enqueue([mutation(`M${i}`)], MY);

		let active = 0;
		let maxActive = 0;
		let releasers: Array<() => void> = [];
		const send = async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => releasers.push(() => { active--; resolve(); }));
		};

		const drainPromise = drainOutbox(MY, send);
		await vi.waitFor(() => expect(releasers.length).toBe(DRAIN_CONCURRENCY));
		await new Promise((r) => setTimeout(r, 5));
		expect(releasers.length).toBe(DRAIN_CONCURRENCY);

		const firstBatch = releasers;
		releasers = [];
		firstBatch.forEach((release) => release());

		await vi.waitFor(() => expect(releasers.length).toBe(total - DRAIN_CONCURRENCY));
		releasers.forEach((release) => release());

		await drainPromise;
		expect(maxActive).toBe(DRAIN_CONCURRENCY);
	});
});

describe('bounded concurrency: dependent writes remain sequential', () => {
	it('B (depends on A) does not start until A completes', async () => {
		const aId = await enqueue([mutation('A')], MY);
		await enqueue([mutation('B')], MY, { dependsOn: [aId!] });

		const started: string[] = [];
		const aGate = deferred();
		const send = async (m: unknown[]) => {
			const text = textOf(m);
			started.push(text);
			if (text === 'A') await aGate.promise;
		};

		const drainPromise = drainOutbox(MY, send);
		await vi.waitFor(() => expect(started).toContain('A'));
		await new Promise((r) => setTimeout(r, 10));
		expect(started).toEqual(['A']);

		aGate.resolve();
		await drainPromise;
		expect(started).toEqual(['A', 'B']);
	});
});

describe('bounded concurrency: independent dependency chains overlap', () => {
	it('A1/B1 run concurrently; A2 waits only for A1; B2 waits only for B1', async () => {
		const a1 = await enqueue([mutation('A1')], MY);
		await enqueue([mutation('A2')], MY, { dependsOn: [a1!] });
		const b1 = await enqueue([mutation('B1')], MY);
		await enqueue([mutation('B2')], MY, { dependsOn: [b1!] });

		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		const send = async (m: unknown[]) => {
			const text = textOf(m);
			started.push(text);
			const gate = deferred();
			gates.set(text, gate);
			await gate.promise;
		};

		const drainPromise = drainOutbox(MY, send);
		await vi.waitFor(() => expect(started.filter((t) => t === 'A1' || t === 'B1').sort()).toEqual(['A1', 'B1']));
		expect(started).not.toContain('A2');
		expect(started).not.toContain('B2');

		gates.get('A1')!.resolve();
		await vi.waitFor(() => expect(started).toContain('A2'));
		expect(started).not.toContain('B2');

		gates.get('B1')!.resolve();
		await vi.waitFor(() => expect(started).toContain('B2'));

		gates.get('A2')!.resolve();
		gates.get('B2')!.resolve();
		await drainPromise;

		expect(started.indexOf('A1')).toBeLessThan(started.indexOf('A2'));
		expect(started.indexOf('B1')).toBeLessThan(started.indexOf('B2'));
	});
});

describe('bounded concurrency: failure isolation', () => {
	it('A permanently failing does not cancel or block independent B; B still completes and persists', async () => {
		await enqueue([mutation('A')], MY);
		await enqueue([mutation('B')], MY);

		const send = async (m: unknown[]) => {
			if (textOf(m) === 'A') throw new IngestError('rejected', { permanent: true });
		};

		const result = await drainOutbox(MY, send);
		expect(result.sent).toBe(1);
		expect(result.dropped).toBe(1);
		expect((await quarantinedEntries(MY)).map((e) => textOf(e.mutations))).toEqual(['A']);
		expect(await pendingEntries(MY)).toHaveLength(0);
	});
});

describe('bounded concurrency: retry schedule is respected', () => {
	it('a backoff-delayed entry does not consume a worker slot before its due time', async () => {
		await enqueue([mutation('A')], MY);
		await enqueue([mutation('B')], MY);

		const round1: string[] = [];
		await drainOutbox(MY, async (m) => {
			const text = textOf(m);
			if (text === 'A') throw new IngestError('network down', { permanent: false });
			round1.push(text);
		});
		expect(round1).toEqual(['B']);
		const [aEntry] = await pendingEntries(MY);
		expect(aEntry.nextAttemptAt).toBeGreaterThan(Date.now());

		const round2: string[] = [];
		const result = await drainOutbox(MY, async (m) => { round2.push(textOf(m)); });
		expect(round2).toEqual([]);
		expect(result.sent).toBe(0);
		expect(result.remaining).toBe(1);
	});
});

describe('bounded concurrency: no duplicate dispatch', () => {
	it('triggering drain again while an entry is still in flight never starts a second concurrent request for it', async () => {
		await enqueue([mutation('A')], MY);

		let callCount = 0;
		const gate = deferred();
		const send = async (m: unknown[]) => {
			if (textOf(m) === 'A') {
				callCount++;
				await gate.promise;
			}
		};

		const first = drainOutbox(MY, send);
		await vi.waitFor(() => expect(callCount).toBe(1));

		const second = await drainOutbox(MY, send);
		expect(callCount).toBe(1);
		expect(second.sent).toBe(0);

		gate.resolve();
		await first;
		expect(callCount).toBe(1);
	});
});

describe('bounded concurrency: leader/follower safety', () => {
	it('a follower never dispatches — no concurrent path bypasses the leadership model', async () => {
		await enqueue([mutation('A')], MY);
		await enqueue([mutation('B')], MY);
		_setLeaderForTests(false);

		const started: string[] = [];
		const result = await drainOutbox(MY, async (m) => { started.push(textOf(m)); });

		expect(started).toEqual([]);
		expect(result.wasLeader).toBe(false);
		expect(await pendingEntries(MY)).toHaveLength(2);
	});

	it('leader takeover after a follower pass applies the same bounded scheduling', async () => {
		await enqueue([mutation('A')], MY);
		await enqueue([mutation('B')], MY);
		_setLeaderForTests(false);
		await drainOutbox(MY, async () => {});
		expect(await pendingEntries(MY)).toHaveLength(2);

		stopLeaderElection();
		startLeaderElection(MY, () => {});
		_setLeaderForTests(true);

		const started: string[] = [];
		const result = await drainOutbox(MY, async (m) => { started.push(textOf(m)); });
		expect(started.sort()).toEqual(['A', 'B']);
		expect(result.sent).toBe(2);
	});
});

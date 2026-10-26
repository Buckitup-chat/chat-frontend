// The pacing of intent recovery (src/lib/data/intentRetry.ts): a pass that
// leaves intents waiting brings the next one itself, a server answer brings
// it at once, and nothing runs after sign-out.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRecoveryScheduler, type RecoveryPassResult } from '@/lib/data/intentRetry';

// No jitter: the pauses are then exact.
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A recovery pass whose outcome the test sets, counting its runs. */
const pass = (outcomes: number[]) => {
	const calls = { n: 0 };
	const run = vi.fn(async (): Promise<RecoveryPassResult> => {
		calls.n++;
		return { waiting: outcomes.shift() ?? 0 };
	});
	return { run, calls };
};

describe('intent recovery pacing', () => {
	it('retries on its own while intents wait, with growing pauses, and stops once none is left', async () => {
		const { run, calls } = pass([1, 1, 0]);
		const s = createRecoveryScheduler(run, { baseMs: 1_000, maxMs: 10_000 });
		s.trigger();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.n).toBe(1);
		await vi.advanceTimersByTimeAsync(1_000); // the first pause: 1 s
		expect(calls.n).toBe(2);
		await vi.advanceTimersByTimeAsync(1_900); // the pause has doubled: not yet
		expect(calls.n).toBe(2);
		await vi.advanceTimersByTimeAsync(100);
		expect(calls.n).toBe(3);
		await vi.advanceTimersByTimeAsync(60_000); // nothing waits: no more passes
		expect(calls.n).toBe(3);
	});

	it('caps the pause', async () => {
		const { run, calls } = pass(Array(20).fill(1));
		const s = createRecoveryScheduler(run, { baseMs: 1_000, maxMs: 4_000 });
		s.trigger();
		await vi.advanceTimersByTimeAsync(1_600 + 2_600 + 4_600);
		const before = calls.n;
		await vi.advanceTimersByTimeAsync(4_600);
		expect(calls.n).toBe(before + 1);
		s.stop();
	});

	it('runs at once when the server answers and intents wait, and not when none does', async () => {
		const { run, calls } = pass([1, 0]);
		const s = createRecoveryScheduler(run, { baseMs: 30_000 });
		s.serverAnswered(); // nothing known to wait yet
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.n).toBe(0);
		s.trigger();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.n).toBe(1); // left one waiting; the next timed pass is 30 s away
		s.serverAnswered();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.n).toBe(2);
		s.serverAnswered(); // nothing waits now
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls.n).toBe(2);
	});

	it('folds triggers during a pass into one more pass after it', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		let n = 0;
		const s = createRecoveryScheduler(async () => {
			n++;
			if (n === 1) await gate;
			return { waiting: 0 };
		});
		s.trigger();
		s.trigger();
		s.trigger();
		await vi.advanceTimersByTimeAsync(0);
		expect(n).toBe(1);
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(n).toBe(2);
	});

	it('treats a pass that throws as one that left intents waiting', async () => {
		let n = 0;
		const s = createRecoveryScheduler(async () => {
			n++;
			if (n === 1) throw new Error('storage unreadable');
			return { waiting: 0 };
		}, { baseMs: 1_000 });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		s.trigger();
		await vi.advanceTimersByTimeAsync(1_600);
		expect(n).toBe(2);
		warn.mockRestore();
	});

	it('retries after a pause when an intent is left for recovery outside a pass, and a server answer brings it at once', async () => {
		const { run, calls } = pass([0, 0]);
		const s = createRecoveryScheduler(run, { baseMs: 1_000 });
		s.intentWaiting(); // the send path left one: no pass now, it just failed
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.n).toBe(0);
		await vi.advanceTimersByTimeAsync(1_600);
		expect(calls.n).toBe(1);
		s.intentWaiting();
		s.serverAnswered();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.n).toBe(2);
		await vi.advanceTimersByTimeAsync(60_000); // the pass found nothing left
		expect(calls.n).toBe(2);
	});

	it('keeps an intent left during a pass waiting, whatever that pass counted', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		let n = 0;
		const s = createRecoveryScheduler(async () => {
			n++;
			if (n === 1) await gate;
			return { waiting: 0 };
		}, { baseMs: 1_000 });
		s.trigger();
		await vi.advanceTimersByTimeAsync(0);
		s.intentWaiting();
		release();
		await vi.advanceTimersByTimeAsync(1_600);
		expect(n).toBe(2);
	});

	it('runs nothing after stop', async () => {
		const { run, calls } = pass([1, 1, 1]);
		const s = createRecoveryScheduler(run, { baseMs: 1_000 });
		s.trigger();
		await vi.advanceTimersByTimeAsync(0);
		s.stop();
		s.trigger();
		s.serverAnswered();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls.n).toBe(1);
	});
});

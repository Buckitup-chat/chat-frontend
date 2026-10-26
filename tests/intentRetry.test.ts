// The pacing of intent recovery (src/lib/data/intentRetry.ts): a pass that
// leaves intents waiting brings the next one itself, a server answer brings
// it at once, and nothing runs after sign-out.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRecoveryScheduler, onIntentWaiting, type RecoveryPassResult } from '@/lib/data/intentRetry';

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

	it('runs ahead of the timer on the first server answer after an intent was left waiting, and only then', async () => {
		const { run, calls } = pass([1, 1, 0]);
		const s = createRecoveryScheduler(run, { baseMs: 10_000 });
		s.serverAnswered(); // nothing was left waiting
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.n).toBe(0);
		s.intentWaiting(); // the send path left one, offline
		s.serverAnswered(); // the server is back
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.n).toBe(1);
		s.serverAnswered(); // more answers: the pass kept it waiting, so it is the timer's now
		s.serverAnswered();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls.n).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls.n).toBe(2);
	});

	it('keeps growing the pause for an intent the server answers cannot help', async () => {
		const { run, calls } = pass(Array(10).fill(1));
		const s = createRecoveryScheduler(run, { baseMs: 1_000, maxMs: 8_000 });
		s.trigger();
		for (let t = 0; t < 15_000; t += 500) {
			s.serverAnswered(); // a busy chat: an answer every half second
			await vi.advanceTimersByTimeAsync(500);
		}
		// passes at 0, 1 s, 3 s, 7 s, 15 s: the answers added none
		expect(calls.n).toBe(5);
		s.stop();
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

	it('hears an intent left waiting in another tab', async () => {
		vi.useRealTimers();
		const heard: string[] = [];
		const off = onIntentWaiting((userHash) => heard.push(userHash));
		const otherTab = new BroadcastChannel('buckitup-intent-waiting');
		otherTab.postMessage({ userHash: 'u_other_tab' });
		await vi.waitFor(() => expect(heard).toEqual(['u_other_tab']));
		otherTab.close();
		off();
	});
});

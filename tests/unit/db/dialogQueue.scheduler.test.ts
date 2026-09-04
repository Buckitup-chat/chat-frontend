import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFlushScheduler } from '@/utils/db/tanstack/dialogQueue';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createFlushScheduler — no lost wakeups (Test C)', () => {
	it('a trigger that arrives while a flush is already running causes another flush once it finishes', async () => {
		const calls: number[] = [];
		let resolveFirstRun: ((value?: undefined) => void) | undefined;
		const runOnce = (): Promise<undefined> | undefined => {
			calls.push(Date.now());
			if (calls.length === 1) {
				return new Promise((resolve) => {
					resolveFirstRun = resolve;
				});
			}
			return undefined;
		};
		const scheduler = createFlushScheduler(runOnce);

		scheduler.trigger();
		await vi.advanceTimersByTimeAsync(100);
		expect(scheduler.isRunning()).toBe(true);
		expect(calls).toHaveLength(1);

		scheduler.trigger();
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toHaveLength(1);
		expect(scheduler.isRunning()).toBe(true);

		resolveFirstRun?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(calls).toHaveLength(2);
		expect(scheduler.isRunning()).toBe(false);
	});

	it('multiple trigger calls while idle collapse into a single attempt (debounce), not concurrent flushes', async () => {
		let callCount = 0;
		const runOnce = () => {
			callCount++;
			return undefined;
		};
		const scheduler = createFlushScheduler(runOnce);

		scheduler.trigger();
		scheduler.trigger();
		scheduler.trigger();
		await vi.advanceTimersByTimeAsync(100);

		expect(callCount).toBe(1);
	});
});

describe('createFlushScheduler — no duplicate concurrent flush (Test D)', () => {
	it('the guaranteed rerun still never overlaps two runOnce() calls, even with a burst of triggers during an in-flight run', async () => {
		let runCount = 0;
		let concurrentRuns = 0;
		let maxConcurrentRuns = 0;
		let resolveRun: (() => void) | undefined;
		const runOnce = async () => {
			runCount++;
			concurrentRuns++;
			maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
			await new Promise<void>((resolve) => {
				resolveRun = resolve;
			});
			concurrentRuns--;
			return undefined;
		};
		const scheduler = createFlushScheduler(runOnce);

		scheduler.trigger();
		await vi.advanceTimersByTimeAsync(100);
		expect(runCount).toBe(1);

		scheduler.trigger();
		scheduler.trigger();
		scheduler.trigger();
		await vi.advanceTimersByTimeAsync(100);

		resolveRun?.();
		await vi.advanceTimersByTimeAsync(0);
		resolveRun?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(runCount).toBe(2);
		expect(maxConcurrentRuns).toBe(1);
		expect(scheduler.isRunning()).toBe(false);
	});
});

describe('createFlushScheduler — retry backoff (unchanged by the rerun fix)', () => {
	it('a trigger arriving mid-backoff does not bypass it early', async () => {
		const calls: number[] = [];
		const runOnce = () => {
			calls.push(Date.now());
			return calls.length === 1 ? { retryAfterMs: 5000 } : undefined;
		};
		const scheduler = createFlushScheduler(runOnce);

		scheduler.trigger();
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toEqual([100]);

		scheduler.trigger();
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toHaveLength(1);
	});
});

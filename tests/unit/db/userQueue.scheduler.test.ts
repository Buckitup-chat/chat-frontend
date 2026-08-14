import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFlushScheduler } from '@/utils/db/tanstack/userQueue';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createFlushScheduler — no lost wakeups', () => {
	it('a write that arrives while a flush is already running triggers another flush once it finishes', async () => {
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

describe('createFlushScheduler — retry backoff', () => {
	it('schedules its own wakeup for when backoff expires, without any external event', async () => {
		const calls: number[] = [];
		const runOnce = () => {
			calls.push(Date.now());
			return calls.length === 1 ? { retryAfterMs: 5000 } : undefined;
		};
		const scheduler = createFlushScheduler(runOnce);

		scheduler.trigger();
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toEqual([100]);

		await vi.advanceTimersByTimeAsync(4999);
		expect(calls).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toEqual([100, 5100]);
	});

	it('a trigger arriving mid-backoff does not bypass it early', async () => {
		const calls: number[] = [];
		const runOnce = () => {
			calls.push(Date.now());
			return calls.length === 1 ? { retryAfterMs: 5000 } : undefined;
		};
		const scheduler = createFlushScheduler(runOnce);

		scheduler.trigger();
		await vi.advanceTimersByTimeAsync(100);

		scheduler.trigger();
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(5100 - 200);
		expect(calls).toEqual([100, 5100]);
	});
});

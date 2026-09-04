import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCoalescingRunScheduler } from '@/composables/useCoalescingRunScheduler';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createCoalescingRunScheduler — Test A: continuous burst does not starve', () => {
	it('a run actually fires during a sustained burst of schedule() calls spaced under the coalescing window', async () => {
		let runCount = 0;
		const scheduler = createCoalescingRunScheduler(() => {
			runCount++;
		});

		for (let i = 0; i < 8; i++) {
			scheduler.schedule();
			await vi.advanceTimersByTimeAsync(100);
		}

		expect(runCount).toBeGreaterThan(0);
	});
});

describe('createCoalescingRunScheduler — Test B: trigger during active run causes exactly one rerun', () => {
	it('schedule() calls that arrive while a run is in flight produce exactly one follow-up run', async () => {
		const calls: number[] = [];
		let resolveRunA: (() => void) | undefined;
		const runOnce = () => {
			calls.push(calls.length);
			if (calls.length === 1) {
				return new Promise<void>((resolve) => {
					resolveRunA = resolve;
				});
			}
			return undefined;
		};
		const scheduler = createCoalescingRunScheduler(runOnce);

		scheduler.schedule();
		await vi.advanceTimersByTimeAsync(200);
		expect(scheduler.isRunning()).toBe(true);
		expect(calls).toHaveLength(1);

		scheduler.schedule();
		scheduler.schedule();
		scheduler.schedule();
		await vi.advanceTimersByTimeAsync(200);
		expect(calls).toHaveLength(1);

		resolveRunA?.();
		await vi.advanceTimersByTimeAsync(200);

		expect(calls).toHaveLength(2);
		expect(scheduler.isRunning()).toBe(false);
	});
});

describe('createCoalescingRunScheduler — Test C: no concurrent decrypt runs', () => {
	it('a burst of 10 schedule() calls during an active run never produces more than one concurrent run, and coalesces into a single rerun', async () => {
		let runCount = 0;
		let concurrentRuns = 0;
		let maxConcurrentRuns = 0;
		let resolveRun: (() => void) | undefined;
		const scheduler = createCoalescingRunScheduler(async () => {
			runCount++;
			concurrentRuns++;
			maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
			await new Promise<void>((resolve) => {
				resolveRun = resolve;
			});
			concurrentRuns--;
		});

		scheduler.schedule();
		await vi.advanceTimersByTimeAsync(200);
		expect(runCount).toBe(1);

		for (let i = 0; i < 10; i++) scheduler.schedule();
		await vi.advanceTimersByTimeAsync(200);
		expect(runCount).toBe(1);

		resolveRun?.();
		await vi.advanceTimersByTimeAsync(200);
		resolveRun?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(runCount).toBe(2);
		expect(maxConcurrentRuns).toBe(1);
	});
});

describe('createCoalescingRunScheduler — Test D: no lost final state', () => {
	it('state that changes while a run is active is picked up by the guaranteed rerun, not dropped', async () => {
		let state = [1];
		const observedByRun: number[][] = [];
		let resolveRunA: (() => void) | undefined;
		let runIndex = 0;
		const scheduler = createCoalescingRunScheduler(() => {
			runIndex++;
			if (runIndex === 1) {
				return new Promise<void>((resolve) => {
					resolveRunA = resolve;
				}).then(() => {
					observedByRun.push([1]);
				});
			}
			observedByRun.push([...state]);
			return undefined;
		});

		scheduler.schedule();
		await vi.advanceTimersByTimeAsync(200);

		state = [1, 2];
		scheduler.schedule();

		resolveRunA?.();
		await vi.advanceTimersByTimeAsync(200);

		expect(observedByRun).toEqual([[1], [1, 2]]);
		expect(observedByRun[observedByRun.length - 1]).toContain(2);
	});
});

describe('createCoalescingRunScheduler — Test E: a context-guard pattern rejects a stale run\'s commit after context switches', () => {
	it('a run started for context A does not overwrite display state after the context has switched to B, when the runOnce guards on it', async () => {
		let currentContext = 'dialog-A';
		let committedContext: string | null = null;
		let resolveRunA: (() => void) | undefined;
		let started = 0;

		const scheduler = createCoalescingRunScheduler(async () => {
			started++;
			const runContext = currentContext;
			if (started === 1) {
				await new Promise<void>((resolve) => {
					resolveRunA = resolve;
				});
			}
			if (runContext !== currentContext) return;
			committedContext = runContext;
		});

		scheduler.schedule();
		await vi.advanceTimersByTimeAsync(200);
		expect(scheduler.isRunning()).toBe(true);

		currentContext = 'dialog-B';
		resolveRunA?.();
		await vi.advanceTimersByTimeAsync(0);

		expect(committedContext).not.toBe('dialog-A');
	});
});

// tryNamedLock: a lock that is free is taken and `fn` runs; a lock held or
// waited for — in this tab, or under the Web Lock of that name in another —
// is left alone and `fn` does not run.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeFakeLockManager } from './helpers/fakeWebLocks';
import { tryNamedLock, withNamedLock } from '@/lib/data/serialized';

const held = () => {
	let release!: () => void;
	const until = new Promise<void>((resolve) => { release = resolve; });
	return { until, release };
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('tryNamedLock', () => {
	it('runs fn under a free lock, and holds it meanwhile', async () => {
		const inside = held();
		const ran = tryNamedLock('free', () => inside.until);
		let second = false;
		const waiting = withNamedLock('free', async () => { second = true; });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(second).toBe(false);
		inside.release();
		expect(await ran).toBe(true);
		await waiting;
		expect(second).toBe(true);
	});

	it('passes over a lock this tab holds or waits for', async () => {
		const inside = held();
		const holding = withNamedLock('busy', () => inside.until);
		const fn = vi.fn(async () => {});
		expect(await tryNamedLock('busy', fn)).toBe(false);
		inside.release();
		await holding;
		expect(fn).not.toHaveBeenCalled();
		expect(await tryNamedLock('busy', fn)).toBe(true);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('passes over a lock another tab holds', async () => {
		const locks = makeFakeLockManager();
		vi.stubGlobal('navigator', { locks });
		const inside = held();
		const otherTab = locks.request('cross-tab', () => inside.until);
		const fn = vi.fn(async () => {});
		expect(await tryNamedLock('cross-tab', fn)).toBe(false);
		expect(fn).not.toHaveBeenCalled();
		inside.release();
		await otherTab;
		expect(await tryNamedLock('cross-tab', fn)).toBe(true);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('rejects as fn does, and lets the lock go', async () => {
		await expect(tryNamedLock('failing', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
		expect(await tryNamedLock('failing', async () => {})).toBe(true);
	});
});

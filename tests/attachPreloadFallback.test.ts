import { describe, it, expect, vi } from 'vitest';
import { preloadWithRetry } from '@/lib/data/attach';

describe('preloadWithRetry: onAttemptFailed fires once per failed attempt', () => {
	it('fires with the error on a rejected attempt, then not again once preload succeeds', async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const coll = { preload: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined) };
			const onAttemptFailed = vi.fn(() => { calls++; });

			const attachedPromise = preloadWithRetry(coll, () => false, 'test', onAttemptFailed);
			await vi.advanceTimersByTimeAsync(1000);

			expect(await attachedPromise).toBe(true);
			expect(calls).toBe(1);
			expect(onAttemptFailed).toHaveBeenCalledWith(0, expect.any(Error));
		} finally {
			vi.useRealTimers();
		}
	});

	it('never fires when the very first attempt already succeeds', async () => {
		const coll = { preload: vi.fn().mockResolvedValueOnce(undefined) };
		const onAttemptFailed = vi.fn();

		await preloadWithRetry(coll, () => false, 'test', onAttemptFailed);

		expect(onAttemptFailed).not.toHaveBeenCalled();
	});

	it('is optional — omitting it changes nothing about the existing retry behavior', async () => {
		const coll = { preload: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined) };

		const attached = await preloadWithRetry(coll, () => false);

		expect(attached).toBe(true);
	});
});

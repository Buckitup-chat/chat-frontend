import { describe, it, expect } from 'vitest';
import { createShapeLink } from '@/lib/data/shapeLink';

describe('shapeLink: a stream failure is sticky', () => {
	it('a subscriber that arrives after the failure is still told, once', async () => {
		const link = createShapeLink();
		link.report();
		let calls = 0;
		link.onStreamError(() => { calls++; });
		await Promise.resolve();
		expect(link.hasFailed()).toBe(true);
		expect(calls).toBe(1);
	});

	it('an unsubscribed late subscriber is not called', async () => {
		const link = createShapeLink();
		link.report();
		let calls = 0;
		const stop = link.onStreamError(() => { calls++; });
		stop();
		await Promise.resolve();
		expect(calls).toBe(0);
	});
});

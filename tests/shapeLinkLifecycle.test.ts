import { describe, it, expect, vi, afterEach } from 'vitest';
import { createShapeLink, registerShapeLink, settled, whenLive } from '@/lib/data/shapeLink';

const UP_TO_DATE = { headers: { control: 'up-to-date' } };

const makeCollection = () => {
	const matchers = new Set<{ fn: (m: unknown) => boolean; resolve: (v: boolean) => void }>();
	const link = createShapeLink();
	const coll = {
		preload: async () => {},
		utils: { awaitMatch: (fn: (m: unknown) => boolean) => new Promise<boolean>((resolve) => matchers.add({ fn, resolve })) },
	};
	registerShapeLink(coll, link);
	const deliverUpToDate = (settle = true) => {
		const seen = [...matchers].filter((m) => m.fn(UP_TO_DATE));
		for (const m of seen) matchers.delete(m);
		const resolve = () => seen.forEach((m) => m.resolve(true));
		if (settle) resolve();
		return resolve;
	};
	return { coll, link, matchers, deliverUpToDate };
};

const drainMicrotasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const settledNow = async (coll: Parameters<typeof settled>[0]) => {
	let result: Awaited<ReturnType<typeof settled>> | 'pending' = 'pending';
	void settled(coll).then((r) => { result = r; });
	await drainMicrotasks();
	return result === 'pending' ? 'pending' : (result as Awaited<ReturnType<typeof settled>>).state;
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('shapeLink lifecycle generations', () => {
	it('never live: settled waits, and a stream error answers failed', async () => {
		const { coll, link } = makeCollection();
		expect(await settledNow(coll)).toBe('pending');
		link.report();
		expect(await settledNow(coll)).toBe('failed');
	});

	it('unknown → live → failed → live', async () => {
		const { coll, link, deliverUpToDate } = makeCollection();
		expect(await settledNow(coll)).toBe('pending');

		deliverUpToDate();
		await whenLive(coll);
		expect(await settledNow(coll)).toBe('live');

		link.report();
		expect(await settledNow(coll)).toBe('failed');
		let liveAgain = false;
		void whenLive(coll).then(() => { liveAgain = true; });
		await drainMicrotasks();
		expect(liveAgain).toBe(false);

		deliverUpToDate();
		await whenLive(coll);
		expect(liveAgain).toBe(true);
		expect(await settledNow(coll)).toBe('live');
	});

	it('an up-to-date that arrived before the error, settling after it, does not mark the new generation live', async () => {
		const { coll, link, matchers, deliverUpToDate } = makeCollection();
		deliverUpToDate();
		await whenLive(coll);
		link.report();
		await vi.waitFor(() => expect(matchers.size).toBe(1));

		const settleOld = deliverUpToDate(false);
		link.report();
		settleOld();
		expect(await settledNow(coll)).toBe('failed');

		await vi.waitFor(() => expect(matchers.size).toBe(1));
		deliverUpToDate();
		await whenLive(coll);
		expect(await settledNow(coll)).toBe('live');
	});

	it('a match awaited before an error but seeing an up-to-date after it is that newer generation\'s proof', async () => {
		const { coll, link, deliverUpToDate } = makeCollection();
		link.report();
		expect(await settledNow(coll)).toBe('failed');
		deliverUpToDate();
		await whenLive(coll);
		expect(await settledNow(coll)).toBe('live');
	});

	it('a live collection holds no pending match; an error starts one again', async () => {
		const { coll, link, matchers, deliverUpToDate } = makeCollection();
		deliverUpToDate();
		await whenLive(coll);
		expect(matchers.size).toBe(0);
		link.report();
		expect(matchers.size).toBe(1);
	});

	it('dialog wiring: a fetch failure through the link after live is reported as failed, not live', async () => {
		const { coll, link, deliverUpToDate } = makeCollection();
		deliverUpToDate();
		await whenLive(coll);
		expect(await settledNow(coll)).toBe('live');

		vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
		await expect(link.fetchClient('https://example.test/shapes')).rejects.toThrow('Failed to fetch');
		expect(await settledNow(coll)).toBe('failed');
	});
});

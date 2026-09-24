import { isControlMessage } from '@tanstack/electric-db-collection';

export interface ShapeLink {
	fetchClient: typeof fetch;
	onError: () => Record<string, never>;
	report(): void;
	onStreamError(handler: () => void): () => void;
	hasFailed(): boolean;
}

export function createShapeLink(): ShapeLink {
	const listeners = new Set<() => void>();
	let failed = false;
	const report = () => {
		failed = true;
		for (const handler of listeners) {
			try {
				handler();
			} catch (e) {
				console.warn('[shapeLink] stream error subscriber threw:', e);
			}
		}
	};
	return {
		fetchClient: async (input, init) => {
			let response: Response;
			try {
				response = await fetch(input, init);
			} catch (e) {
				if (!init?.signal?.aborted) report();
				throw e;
			}
			if (!response.ok && response.status !== 409) report();
			return response;
		},
		onError: () => {
			report();
			return {};
		},
		report,
		onStreamError(handler) {
			listeners.add(handler);
			if (failed) queueMicrotask(() => { if (listeners.has(handler)) handler(); });
			return () => {
				listeners.delete(handler);
			};
		},
		hasFailed: () => failed,
	};
}

const MAX_TIMER_MS = 2 ** 31 - 1;

interface UpToDateAwaitable {
	utils?: { awaitMatch?: (matchFn: (message: unknown) => boolean, timeout?: number) => Promise<boolean> };
}

const isUpToDate = (message: unknown): boolean =>
	isControlMessage(message as never) && (message as { headers: { control?: string } }).headers.control === 'up-to-date';

async function awaitUpToDate(coll: UpToDateAwaitable): Promise<void> {
	const awaitMatch = coll.utils?.awaitMatch;
	if (!awaitMatch) return new Promise<void>(() => {});
	for (;;) {
		try {
			await awaitMatch(isUpToDate, MAX_TIMER_MS);
			return;
		} catch (e) {
			const name = (e as Error)?.name;
			if (name !== 'TimeoutWaitingForMatchError' && name !== 'StreamAbortedError') {
				console.warn('[shapeLink] cannot observe up-to-date; live stays unconfirmed:', e);
				return new Promise<void>(() => {});
			}
		}
	}
}

const liveByCollection = new WeakMap<object, Promise<void>>();
const confirmedLive = new WeakSet<object>();
const linkByCollection = new WeakMap<object, ShapeLink>();

export function whenLive(coll: UpToDateAwaitable & object): Promise<void> {
	let live = liveByCollection.get(coll);
	if (!live) {
		live = awaitUpToDate(coll).then(() => { confirmedLive.add(coll); });
		liveByCollection.set(coll, live);
	}
	return live;
}

export function registerShapeLink(coll: UpToDateAwaitable & object, link: ShapeLink): void {
	linkByCollection.set(coll, link);
	void whenLive(coll);
}

export function shapeLinkOf(coll: object | null | undefined): ShapeLink | null {
	return coll ? linkByCollection.get(coll) ?? null : null;
}

interface Preloadable {
	preload(): Promise<unknown>;
}

export async function settled(
	coll: Preloadable & UpToDateAwaitable & object
): Promise<{ state: 'live' | 'failed'; error?: unknown }> {
	const link = shapeLinkOf(coll);
	if (!link) {
		try {
			await coll.preload();
			return { state: 'live' };
		} catch (error) {
			return { state: 'failed', error };
		}
	}
	const streamFailed = { state: 'failed' as const, error: new Error('shape stream failed and live is not confirmed') };
	if (confirmedLive.has(coll)) return { state: 'live' };
	if (link.hasFailed()) return streamFailed;
	void coll.preload().catch(() => {});
	return new Promise((resolve) => {
		const stop = link.onStreamError(() => {
			stop();
			resolve(streamFailed);
		});
		void whenLive(coll).then(() => {
			stop();
			resolve({ state: 'live' });
		});
	});
}

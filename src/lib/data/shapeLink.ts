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

interface Lifecycle {
	generation: number;
	live: boolean;
	failed: boolean;
	watching: boolean;
	listeners: Set<() => void>;
}

const lifecycles = new WeakMap<object, Lifecycle>();
const linkByCollection = new WeakMap<object, ShapeLink>();

function lifecycleOf(coll: UpToDateAwaitable & object): Lifecycle {
	let state = lifecycles.get(coll);
	if (!state) {
		state = { generation: 0, live: false, failed: false, watching: false, listeners: new Set() };
		lifecycles.set(coll, state);
		watchForLive(coll, state);
	}
	return state;
}

function notify(state: Lifecycle): void {
	for (const listener of [...state.listeners]) listener();
}

function markFailed(coll: UpToDateAwaitable & object, state: Lifecycle): void {
	state.generation += 1;
	state.live = false;
	state.failed = true;
	watchForLive(coll, state);
	notify(state);
}

function watchForLive(coll: UpToDateAwaitable & object, state: Lifecycle): void {
	const awaitMatch = coll.utils?.awaitMatch;
	if (state.watching || !awaitMatch) return;
	state.watching = true;
	void (async () => {
		for (;;) {
			let arrivedIn = -1;
			try {
				await awaitMatch((message) => {
					if (!isUpToDate(message)) return false;
					arrivedIn = state.generation;
					return true;
				}, MAX_TIMER_MS);
			} catch (e) {
				const name = (e as Error)?.name;
				if (name === 'TimeoutWaitingForMatchError' || name === 'StreamAbortedError') continue;
				console.warn('[shapeLink] cannot observe up-to-date; live stays unconfirmed:', e);
				state.watching = false;
				return;
			}
			if (arrivedIn !== state.generation) continue;
			state.watching = false;
			state.live = true;
			state.failed = false;
			notify(state);
			return;
		}
	})();
}

export function whenLive(coll: UpToDateAwaitable & object): Promise<void> {
	const state = lifecycleOf(coll);
	if (state.live) return Promise.resolve();
	return new Promise((resolve) => {
		const listener = () => {
			if (!state.live) return;
			state.listeners.delete(listener);
			resolve();
		};
		state.listeners.add(listener);
	});
}

export function registerShapeLink(coll: UpToDateAwaitable & object, link: ShapeLink): void {
	linkByCollection.set(coll, link);
	const state = lifecycleOf(coll);
	link.onStreamError(() => markFailed(coll, state));
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
	const state = lifecycleOf(coll);
	if (state.live) return { state: 'live' };
	if (state.failed) return streamFailed;
	void coll.preload().catch(() => {});
	return new Promise((resolve) => {
		const listener = () => {
			if (!state.live && !state.failed) return;
			state.listeners.delete(listener);
			resolve(state.live ? { state: 'live' } : streamFailed);
		};
		state.listeners.add(listener);
	});
}

export function isLiveNow(coll: UpToDateAwaitable & object): boolean {
	return !!shapeLinkOf(coll) && lifecycleOf(coll).live;
}

// The app's service worker (src/sw.js) under node: a stubbed `self` whose
// listeners the test drives by hand. A test file using it mocks
// workbox-precaching and workbox-routing itself — vi.mock is hoisted per file.
import { vi } from 'vitest';

type Listener = (event: any) => void;

export const loadWorker = async () => {
	const listeners: Record<string, Listener[]> = {};
	const clients: Array<{ postMessage: (m: any) => void }> = [];
	vi.stubGlobal('self', {
		addEventListener: (type: string, fn: Listener) => (listeners[type] ??= []).push(fn),
		skipWaiting: () => {},
		clients: { claim: async () => {}, matchAll: async () => clients },
		__WB_MANIFEST: [],
	});
	vi.resetModules();
	await import('@/sw.js');
	const dispatch = (type: string, event: any) => listeners[type]?.forEach((fn) => fn(event));
	return {
		/** The pages the worker sees; push one to receive what it posts. */
		clients,
		postToWorker: (data: any) => dispatch('message', { data }),
		/** Fires a fetch event at the worker and returns what it responded with. */
		request: (path: string, range?: string): Promise<Response> => {
			let responded: Promise<Response> | null = null;
			dispatch('fetch', {
				request: new Request(`https://app.test${path}`, { headers: range ? { range } : {} }),
				respondWith: (p: Promise<Response>) => { responded = p; },
			});
			if (!responded) throw new Error('worker did not handle the request');
			return responded;
		},
	};
};

export type TestWorker = Awaited<ReturnType<typeof loadWorker>>;

/** The Range header for chunk `index` of `chunkSize`-byte chunks. */
export const rangeOf = (index: number, chunkSize: number) => `bytes=${index * chunkSize}-${index * chunkSize + chunkSize - 1}`;

/** A response's body, or the error its stream ended with. */
export const bodyOf = (res: Response) => res.arrayBuffer().then(
	(b) => ({ ok: true as const, bytes: new Uint8Array(b) }),
	(e: Error) => ({ ok: false as const, error: e.message }),
);

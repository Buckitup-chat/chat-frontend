// The video worker serves a chunk only if its bytes hash to what the page
// verified for that index: GCM alone would play any of the file's chunks at
// any position. Driven through the real src/sw.js, as swTokenRefresh is.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { chunkDataHash } from '@/lib/pq/fileCrypto';

vi.mock('workbox-precaching', () => ({
	precacheAndRoute: () => {},
	createHandlerBoundToURL: () => () => {},
	cleanupOutdatedCaches: () => {},
}));
vi.mock('workbox-routing', () => ({
	NavigationRoute: class {},
	registerRoute: () => {},
}));

type Listener = (event: any) => void;

const CHUNK = 16;
const PLAINS = [new TextEncoder().encode('0123456789abcdef'), new TextEncoder().encode('ghijklmnopqrstuv')];
const SESSION_ID = 'video-session-v';
const FILE_ID = 'file-v';

let fetched: number[];
let pageInbox: any[];

const loadWorker = async () => {
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
		clients,
		postToWorker: (data: any) => dispatch('message', { data }),
		request: (path: string, range: string): Promise<Response> => {
			let responded: Promise<Response> | null = null;
			dispatch('fetch', {
				request: new Request(`https://app.test${path}`, { headers: { range } }),
				respondWith: (p: Promise<Response>) => { responded = p; },
			});
			if (!responded) throw new Error('worker did not handle the request');
			return responded;
		},
	};
};

const encrypt = async (secret: Uint8Array, plain: Uint8Array) => {
	const key = await webcrypto.subtle.importKey('raw', secret, { name: 'AES-GCM' }, false, ['encrypt']);
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
	const blob = new Uint8Array(12 + ct.length);
	blob.set(iv);
	blob.set(ct, 12);
	return blob;
};

/** A backend that serves `served[i]` for index i, with a valid token. */
const installBackend = (served: Uint8Array[]) => {
	vi.stubGlobal('fetch', async (input: string) => {
		const index = Number(/\/file_chunk\/[^/]+\/(\d+)$/.exec(String(input))?.[1]);
		fetched.push(index);
		return new Response(served[index] as Uint8Array<ArrayBuffer>, { status: 200 });
	});
};

const register = (worker: Awaited<ReturnType<typeof loadWorker>>, secret: Uint8Array, chunkHashes: Array<string | null | false>) =>
	worker.postToWorker({
		type: 'register', sessionId: SESSION_ID, fileId: FILE_ID, encSecret: secret, chunkSize: CHUNK,
		totalSize: CHUNK * PLAINS.length, mimeType: 'video/mp4', baseUrl: 'https://api.test', token: 'fresh-token', chunkHashes,
	});

const rangeOf = (index: number) => `bytes=${index * CHUNK}-${index * CHUNK + CHUNK - 1}`;
const body = (res: Response) => res.arrayBuffer().then(
	(b) => ({ ok: true as const, bytes: new Uint8Array(b) }),
	(e: Error) => ({ ok: false as const, error: e.message }),
);

beforeEach(() => {
	fetched = [];
	pageInbox = [];
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the video worker holds each chunk to its verified hash', () => {
	it('serves a chunk whose bytes are the signed ones', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		const blobs = await Promise.all(PLAINS.map((p) => encrypt(secret, p)));
		installBackend(blobs);
		register(worker, secret, blobs.map(chunkDataHash));
		expect(await body(await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(1)))).toEqual({ ok: true, bytes: PLAINS[1] });
	});

	it('refuses chunk 1\'s bytes served for index 0, though they decrypt', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		const blobs = await Promise.all(PLAINS.map((p) => encrypt(secret, p)));
		installBackend([blobs[1], blobs[1]]);
		register(worker, secret, blobs.map(chunkDataHash));
		const res = await body(await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0)));
		expect(res.ok).toBe(false);
		expect(res).toMatchObject({ error: expect.stringContaining('chunk 0: could not be verified') });
	});

	it('does not fetch a chunk whose row the page refused', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		const blobs = await Promise.all(PLAINS.map((p) => encrypt(secret, p)));
		installBackend(blobs);
		register(worker, secret, [false, chunkDataHash(blobs[1])]);
		expect((await body(await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0)))).ok).toBe(false);
		expect(fetched).toEqual([]);
	});

	it('asks the page once for a hash that was not there at registration, and plays with its answer', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		const blobs = await Promise.all(PLAINS.map((p) => encrypt(secret, p)));
		installBackend(blobs);
		worker.clients.push({
			postMessage: (msg) => {
				pageInbox.push(msg);
				if (msg.type === 'need-chunk-hashes') {
					setTimeout(() => worker.postToWorker({ type: 'chunk-hashes', sessionId: msg.sessionId, chunkHashes: blobs.map(chunkDataHash) }), 50);
				}
			},
		});
		register(worker, secret, [chunkDataHash(blobs[0]), null]);
		expect(await body(await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(1)))).toEqual({ ok: true, bytes: PLAINS[1] });
		expect(pageInbox).toEqual([{ type: 'need-chunk-hashes', sessionId: SESSION_ID }]);
	});
});

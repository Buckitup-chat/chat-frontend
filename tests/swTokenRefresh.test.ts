import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';

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

const PLAIN = new TextEncoder().encode('0123456789abcdef'); // one 16-byte chunk
const SESSION_ID = 'video-session-1';
const FILE_ID = 'file-1';

let timeline: string[];
let fetches: Array<{ url: string; authorization: string | null }>;

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

const encryptChunk = async (secret: Uint8Array) => {
	const key = await webcrypto.subtle.importKey('raw', secret, { name: 'AES-GCM' }, false, ['encrypt']);
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, PLAIN));
	const blob = new Uint8Array(12 + ct.length);
	blob.set(iv);
	blob.set(ct, 12);
	return blob;
};

const installBackend = (ciphertext: Uint8Array<ArrayBuffer>) => {
	vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
		const url = String(input);
		const authorization = new Headers(init?.headers).get('authorization');
		fetches.push({ url, authorization });
		timeline.push(`fetch ${authorization}`);
		if (!url.includes(`/file_chunk/${FILE_ID}/0`)) throw new Error(`unexpected fetch ${url}`);
		if (authorization === 'Bearer fresh-token') return new Response(ciphertext, { status: 200 });
		return new Response(JSON.stringify({ error: 'read_session_required', shape: 'file_chunk' }), { status: 401 });
	});
};

beforeEach(() => {
	timeline = [];
	fetches = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('service worker refreshes an expired file_chunk token', () => {
	it('waits for the page\'s need-token answer and retries with fresh-token, not expired-token', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		installBackend(await encryptChunk(secret));

		const pageInbox: any[] = [];
		worker.clients.push({
			postMessage: (msg) => {
				pageInbox.push(msg);
				timeline.push(`page got ${msg.type}`);
				if (msg.type === 'need-token') {
					setTimeout(() => {
						timeline.push('page sends fresh-token');
						worker.postToWorker({ type: 'token', sessionId: msg.sessionId, token: 'fresh-token' });
					}, 150);
				}
			},
		});

		worker.postToWorker({
			type: 'register',
			sessionId: SESSION_ID,
			fileId: FILE_ID,
			encSecret: secret,
			chunkSize: PLAIN.length,
			totalSize: PLAIN.length,
			mimeType: 'video/mp4',
			baseUrl: 'https://api.test',
			token: 'expired-token',
		});

		const res = await worker.request(`/encrypted-video/${SESSION_ID}`, `bytes=0-${PLAIN.length - 1}`);
		expect(res.status).toBe(206);
		const body = await res.arrayBuffer().then(
			(b) => ({ ok: true as const, bytes: new Uint8Array(b) }),
			(e: Error) => ({ ok: false as const, error: e.message }),
		);
		// Let a late page answer land so the timeline shows where it fell.
		await new Promise((r) => setTimeout(r, 200));

		expect(pageInbox).toEqual([{ type: 'need-token', sessionId: SESSION_ID }]);
		expect(fetches).toHaveLength(2);
		expect(fetches[0].authorization).toBe('Bearer expired-token');
		expect(fetches[1].authorization).toBe('Bearer fresh-token');
		expect(timeline.indexOf('page sends fresh-token')).toBeLessThan(timeline.lastIndexOf('fetch Bearer fresh-token'));
		expect(body).toEqual({ ok: true, bytes: PLAIN });
	});

	it('control: a session registered without a token waits for the page and succeeds', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		installBackend(await encryptChunk(secret));
		worker.clients.push({
			postMessage: (msg) => {
				if (msg.type !== 'need-token') return;
				setTimeout(() => worker.postToWorker({ type: 'token', sessionId: msg.sessionId, token: 'fresh-token' }), 150);
			},
		});
		worker.postToWorker({
			type: 'register', sessionId: SESSION_ID, fileId: FILE_ID, encSecret: secret,
			chunkSize: PLAIN.length, totalSize: PLAIN.length, mimeType: 'video/mp4',
			baseUrl: 'https://api.test', token: '',
		});

		const res = await worker.request(`/encrypted-video/${SESSION_ID}`, `bytes=0-${PLAIN.length - 1}`);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PLAIN);
		expect(fetches.map((f) => f.authorization)).toEqual([null, 'Bearer fresh-token']);
	});
});

describe('page answers need-token only for its own video session', () => {
	const pageSetup = async () => {
		vi.resetModules();
		vi.doMock('@/lib/data/readSession', () => ({
			bearerFor: () => 'Bearer expired-token',
			openSession: async () => 'fresh-token',
		}));
		vi.doMock('@/lib/data/fileTransfer', () => ({ downloadFile: async () => { throw new Error('fallback not expected'); } }));
		vi.doMock('@/lib/data/mediaCache', () => ({ getCachedMedia: async () => null, putCachedMedia: async () => {} }));

		const swListeners: Record<string, Listener[]> = {};
		const toWorker: any[] = [];
		vi.stubGlobal('window', { isSecureContext: true });
		vi.stubGlobal('navigator', {
			serviceWorker: {
				controller: { postMessage: (m: any) => toWorker.push(m) },
				ready: Promise.resolve(),
				getRegistration: async () => ({}),
				addEventListener: (type: string, fn: Listener) => (swListeners[type] ??= []).push(fn),
			},
		});
		const { openVideo } = await import('@/lib/data/videoStream');
		const fromWorker = (data: any) => swListeners.message?.forEach((fn) => fn({ data }));
		return { openVideo, toWorker, fromWorker };
	};

	const settle = () => new Promise((r) => setTimeout(r, 50));
	const video = { fileId: FILE_ID, encSecretB64: 'AAAA', size: 16, mimeType: 'video/mp4' };

	afterEach(() => {
		vi.doUnmock('@/lib/data/readSession');
		vi.doUnmock('@/lib/data/fileTransfer');
		vi.doUnmock('@/lib/data/mediaCache');
	});

	it('control: the owning tab answers need-token with its token', async () => {
		const tab = await pageSetup();
		const source = await tab.openVideo(video);
		expect(source.streaming).toBe(true);
		const sessionId = source.url.split('/').pop();

		tab.fromWorker({ type: 'need-token', sessionId });
		await settle();

		expect(tab.toWorker.filter((m) => m.type === 'token')).toEqual([{ type: 'token', sessionId, token: 'fresh-token' }]);
	});

	it('a tab that does not own the session stays silent on need-token', async () => {
		const tab = await pageSetup();
		await tab.openVideo(video);

		tab.fromWorker({ type: 'need-token', sessionId: 'session-of-another-tab' });
		await settle();

		const answers = tab.toWorker.filter((m) => m.type === 'token');
		expect(answers).toEqual([]);
	});
});

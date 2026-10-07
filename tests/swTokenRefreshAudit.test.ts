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

const CHUNK = 16;
const PLAINS = [new TextEncoder().encode('0123456789abcdef'), new TextEncoder().encode('ghijklmnopqrstuv')];
const SESSION_ID = 'video-session-1';
const FILE_ID = 'file-1';

let fetches: Array<{ url: string; authorization: string | null; index: number }>;
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

const encrypt = async (secret: Uint8Array, plain: Uint8Array) => {
	const key = await webcrypto.subtle.importKey('raw', secret, { name: 'AES-GCM' }, false, ['encrypt']);
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
	const blob = new Uint8Array(12 + ct.length);
	blob.set(iv);
	blob.set(ct, 12);
	return blob;
};

type ChunkReply = (index: number, authorization: string | null) => Response | Promise<Response>;

const installBackend = async (secret: Uint8Array, reply?: ChunkReply) => {
	const blobs = await Promise.all(PLAINS.map((p) => encrypt(secret, p)));
	const accept: ChunkReply = (index, authorization) =>
		authorization === 'Bearer fresh-token'
			? new Response(blobs[index], { status: 200 })
			: new Response(JSON.stringify({ error: 'read_session_required', shape: 'file_chunk' }), { status: 401 });
	vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
		const url = String(input);
		const m = /\/file_chunk\/([^/]+)\/(\d+)$/.exec(url);
		if (!m || m[1] !== FILE_ID) throw new Error(`unexpected fetch ${url}`);
		const index = Number(m[2]);
		const authorization = new Headers(init?.headers).get('authorization');
		fetches.push({ url, authorization, index });
		return (reply ?? accept)(index, authorization) ?? accept(index, authorization);
	});
	return accept;
};

const addPage = (worker: Awaited<ReturnType<typeof loadWorker>>, token: string, { delayMs = 50, answers = Infinity } = {}) => {
	let left = answers;
	worker.clients.push({
		postMessage: (msg) => {
			pageInbox.push(msg);
			if (msg.type !== 'need-token' || left-- <= 0) return;
			setTimeout(() => worker.postToWorker({ type: 'token', sessionId: msg.sessionId, token }), delayMs);
		},
	});
};

const register = (worker: Awaited<ReturnType<typeof loadWorker>>, secret: Uint8Array, token: string, sessionId = SESSION_ID) =>
	worker.postToWorker({
		type: 'register', sessionId, fileId: FILE_ID, encSecret: secret, chunkSize: CHUNK,
		totalSize: CHUNK * PLAINS.length, mimeType: 'video/mp4', baseUrl: 'https://api.test', token,
	});

const rangeOf = (index: number) => `bytes=${index * CHUNK}-${index * CHUNK + CHUNK - 1}`;
const body = (res: Response) => res.arrayBuffer().then(
	(b) => ({ ok: true as const, bytes: new Uint8Array(b) }),
	(e: Error) => ({ ok: false as const, error: e.message }),
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const needTokens = () => pageInbox.filter((m) => m.type === 'need-token');

beforeEach(() => {
	fetches = [];
	pageInbox = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('D. Service Worker token refresh (real src/sw.js)', () => {
	it('D1 no replacement token: the wait is bounded, there is one retry, and the range fails', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		await installBackend(secret);
		addPage(worker, 'fresh-token', { answers: 0 }); // page never answers
		register(worker, secret, 'expired-token');

		const started = Date.now();
		const res = await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0));
		const result = await body(res);
		const elapsed = Date.now() - started;
		await sleep(300);

		expect(result).toEqual({ ok: false, error: 'chunk 0: HTTP 401' });
		expect(fetches.map((f) => f.authorization)).toEqual(['Bearer expired-token', null]);
		expect(needTokens()).toHaveLength(1);
		expect(elapsed).toBeGreaterThanOrEqual(1_900);
		expect(elapsed).toBeLessThan(4_000);
	});

	it('D2 a retry that also gets 401 fails the range without a third request', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		await installBackend(secret);
		addPage(worker, 'also-rejected-token');
		register(worker, secret, 'expired-token');

		const result = await body(await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0)));
		await sleep(300);

		expect(result).toEqual({ ok: false, error: 'chunk 0: HTTP 401' });
		expect(fetches.map((f) => f.authorization)).toEqual(['Bearer expired-token', 'Bearer also-rejected-token']);
		expect(needTokens()).toHaveLength(1);
	});

	it.each([500, 403, 404])('D3 a non-401 backend error (%i) does not ask for a token', async (status) => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		await installBackend(secret, () => new Response('err', { status }));
		addPage(worker, 'fresh-token');
		register(worker, secret, 'fresh-token');

		const result = await body(await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0)));

		expect(result).toEqual({ ok: false, error: `chunk 0: HTTP ${status}` });
		expect(fetches).toHaveLength(1);
		expect(needTokens()).toEqual([]);
	});

	it('D4 a token message for an unknown sessionId is ignored', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		await installBackend(secret);
		addPage(worker, 'fresh-token');
		register(worker, secret, 'expired-token');

		worker.postToWorker({ type: 'token', sessionId: 'someone-elses-session', token: 'fresh-token' });
		worker.postToWorker({ type: 'token', token: 'fresh-token' }); // no sessionId at all
		const result = await body(await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0)));

		expect(fetches[0].authorization).toBe('Bearer expired-token');
		expect(result).toEqual({ ok: true, bytes: PLAINS[0] });
		const stray = await worker.request('/encrypted-video/someone-elses-session', rangeOf(0));
		expect(stray.status).toBe(404);
		expect(fetches).toHaveLength(2);
	});

	it('D5 a token refreshed by one request survives another request\'s late stale 401', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		let releaseChunk1!: () => void;
		const chunk1Gate = new Promise<void>((r) => { releaseChunk1 = r; });
		const accept = await installBackend(secret, async (index, authorization) => {
			if (index === 1 && authorization === 'Bearer expired-token') await chunk1Gate;
			return accept(index, authorization);
		});
		addPage(worker, 'fresh-token', { answers: 1 }); // one answer only: a cleared token would not come back
		register(worker, secret, 'expired-token');

		const r1 = worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(1)).then(body);
		await sleep(10);
		const r0 = await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0)).then(body);
		expect(r0).toEqual({ ok: true, bytes: PLAINS[0] });

		releaseChunk1();
		const started = Date.now();
		const result1 = await r1;

		expect(result1).toEqual({ ok: true, bytes: PLAINS[1] });
		expect(fetches.filter((f) => f.index === 1).map((f) => f.authorization)).toEqual(['Bearer expired-token', 'Bearer fresh-token']);
		expect(Date.now() - started).toBeLessThan(500); // did not sit out the 2 s wait
	});

	it('D6 two simultaneous 401s: both retry with the fresh token, the rejected token is never restored', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		await installBackend(secret);
		addPage(worker, 'fresh-token', { answers: 1 });
		register(worker, secret, 'expired-token');

		const [a, b] = await Promise.all([
			worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0)).then(body),
			worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(1)).then(body),
		]);

		expect(a).toEqual({ ok: true, bytes: PLAINS[0] });
		expect(b).toEqual({ ok: true, bytes: PLAINS[1] });
		expect(fetches.filter((f) => f.authorization === 'Bearer expired-token')).toHaveLength(2);
		expect(fetches.slice(2).map((f) => f.authorization)).toEqual(['Bearer fresh-token', 'Bearer fresh-token']);
	});

	it('D7 the token travels only in the Authorization header, never in the URL', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		await installBackend(secret);
		addPage(worker, 'fresh-token');
		register(worker, secret, 'expired-token');

		await body(await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0)));

		expect(fetches).toHaveLength(2);
		for (const f of fetches) {
			expect(f.url).toBe(`https://api.test/file_chunk/${FILE_ID}/0`);
			expect(f.url).not.toMatch(/token/);
		}
		expect(fetches.map((f) => f.authorization)).toEqual(['Bearer expired-token', 'Bearer fresh-token']);
	});

	it('D8 a cached decrypted chunk needs no network request and no token refresh', async () => {
		const worker = await loadWorker();
		const secret = webcrypto.getRandomValues(new Uint8Array(32));
		await installBackend(secret);
		addPage(worker, 'fresh-token');
		register(worker, secret, 'expired-token');

		expect(await body(await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0)))).toEqual({ ok: true, bytes: PLAINS[0] });
		const before = { fetches: fetches.length, needs: needTokens().length };
		expect(await body(await worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0)))).toEqual({ ok: true, bytes: PLAINS[0] });

		expect(fetches).toHaveLength(before.fetches);
		expect(needTokens()).toHaveLength(before.needs);
	});
});


describe('E. multi-tab ownership of need-token (real videoStream.ts)', () => {
	const openSessionSpy = vi.fn(async (_shape: string) => 'fresh-token');

	const pageSetup = async () => {
		vi.resetModules();
		openSessionSpy.mockClear();
		vi.doMock('@/lib/data/readSession', () => ({
			bearerFor: () => 'Bearer expired-token',
			openSession: openSessionSpy,
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
		const tokens = () => toWorker.filter((m) => m.type === 'token');
		return { openVideo, toWorker, fromWorker, tokens };
	};

	const settle = () => new Promise((r) => setTimeout(r, 50));
	const video = { fileId: FILE_ID, encSecretB64: 'AAAA', size: 16, mimeType: 'video/mp4' };
	const idOf = (source: { url: string }) => source.url.split('/').pop()!;

	afterEach(() => {
		vi.doUnmock('@/lib/data/readSession');
		vi.doUnmock('@/lib/data/fileTransfer');
		vi.doUnmock('@/lib/data/mediaCache');
	});

	it('E1 the owning tab answers with the requested sessionId, and only it opens a file_chunk session', async () => {
		const tab = await pageSetup();
		const first = await tab.openVideo(video);
		const second = await tab.openVideo(video);

		tab.fromWorker({ type: 'need-token', sessionId: idOf(second) });
		await settle();

		expect(tab.tokens()).toEqual([{ type: 'token', sessionId: idOf(second), token: 'fresh-token' }]);
		expect(openSessionSpy.mock.calls).toEqual([['file_chunk']]);
		expect(idOf(first)).not.toBe(idOf(second));
	});

	it('E2 a non-owning tab stays silent and opens no session', async () => {
		const tab = await pageSetup();
		await tab.openVideo(video);

		tab.fromWorker({ type: 'need-token', sessionId: 'session-of-another-tab' });
		await settle();

		expect(tab.tokens()).toEqual([]);
		expect(openSessionSpy).not.toHaveBeenCalled();
	});

	it('E3 a tab stays silent after releasing its video session', async () => {
		const tab = await pageSetup();
		const source = await tab.openVideo(video);
		source.release();
		expect(tab.toWorker.at(-1)).toEqual({ type: 'unregister', sessionId: idOf(source) });

		tab.fromWorker({ type: 'need-token', sessionId: idOf(source) });
		tab.fromWorker({ type: 'need-session', sessionId: idOf(source) });
		await settle();

		expect(tab.tokens()).toEqual([]);
		expect(tab.toWorker.filter((m) => m.type === 'register')).toHaveLength(1); // the original only
		expect(openSessionSpy).not.toHaveBeenCalled();
	});

	it.each([
		['missing sessionId', { type: 'need-token' }],
		['empty sessionId', { type: 'need-token', sessionId: '' }],
		['unknown sessionId', { type: 'need-token', sessionId: 'nope' }],
		['no message body', null],
	])('E4 need-token with %s is ignored', async (_name, msg) => {
		const tab = await pageSetup();
		await tab.openVideo(video);

		tab.fromWorker(msg);
		await settle();

		expect(tab.tokens()).toEqual([]);
		expect(openSessionSpy).not.toHaveBeenCalled();
	});

	it('E5 need-session ownership is unchanged: the owner re-registers, others stay silent', async () => {
		const tab = await pageSetup();
		const source = await tab.openVideo(video);
		const registration = tab.toWorker.find((m) => m.type === 'register');
		const before = tab.toWorker.length;

		tab.fromWorker({ type: 'need-session', sessionId: 'session-of-another-tab' });
		tab.fromWorker({ type: 'need-session' });
		await settle();
		expect(tab.toWorker).toHaveLength(before);

		tab.fromWorker({ type: 'need-session', sessionId: idOf(source) });
		await settle();
		expect(tab.toWorker.slice(before)).toEqual([registration]);
		expect(openSessionSpy).not.toHaveBeenCalled();
	});
});

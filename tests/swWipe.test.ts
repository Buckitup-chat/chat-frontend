// "Wipe all" reaches the service worker: it holds each playing video's key and
// decrypted chunks in memory, and reloading the pages does not stop it. Driven
// through the real src/sw.js and requestWipe.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { chunkDataHash, encryptChunk } from '@buckitup/pq-client/fileCrypto';
import { requestWipe } from '@/lib/wipeDevice';
import { bodyOf, loadWorker, rangeOf } from './helpers/swHarness';

vi.mock('workbox-precaching', () => ({
	precacheAndRoute: () => {},
	createHandlerBoundToURL: () => () => {},
	cleanupOutdatedCaches: () => {},
}));
vi.mock('workbox-routing', () => ({
	NavigationRoute: class {},
	registerRoute: () => {},
}));

const CHUNK = 16;
const PLAIN = new TextEncoder().encode('0123456789abcdef');
const SESSION_ID = 'video-session-w';

const memoryStorage = () => {
	const map = new Map<string, string>();
	return { setItem: (k: string, v: string) => void map.set(k, v), getItem: (k: string) => map.get(k) ?? null } as unknown as Storage;
};

afterEach(() => vi.unstubAllGlobals());

describe('the video worker on a wipe', () => {
	it('forgets every video it plays', async () => {
		const worker = await loadWorker();
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const blob = await encryptChunk(secret, PLAIN);
		vi.stubGlobal('fetch', async () => new Response(blob as Uint8Array<ArrayBuffer>, { status: 200 }));
		worker.postToWorker({
			type: 'register', sessionId: SESSION_ID, fileId: 'file-w', encSecret: secret, chunkSize: CHUNK,
			totalSize: CHUNK, mimeType: 'video/mp4', baseUrl: 'https://api.test', token: 't', chunkHashes: { 0: chunkDataHash(blob) },
		});
		const play = () => worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(0, CHUNK));
		expect(await bodyOf(await play())).toEqual({ ok: true, bytes: PLAIN });

		requestWipe({ localStorage: memoryStorage(), serviceWorker: { controller: { postMessage: worker.postToWorker } } as unknown as ServiceWorkerContainer });

		// The session is gone: the worker asks the pages for it, and no page answers.
		const inbox: unknown[] = [];
		worker.clients.push({ postMessage: (m) => inbox.push(m) });
		expect((await play()).status).toBe(404);
		expect(inbox).toEqual([{ type: 'need-session', sessionId: SESSION_ID }]);
	});
});

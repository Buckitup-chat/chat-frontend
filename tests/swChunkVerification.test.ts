// The video worker serves a chunk only if its bytes hash to what the page
// verified for that index: GCM alone would play any of the file's chunks at
// any position. Driven through the real src/sw.js and videoStream.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chunkDataHash, encryptChunk } from '@/lib/pq/fileCrypto';
import { bodyOf, loadWorker, rangeOf, type TestWorker } from './helpers/swHarness';

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
const PLAINS = [new TextEncoder().encode('0123456789abcdef'), new TextEncoder().encode('ghijklmnopqrstuv')];
const SESSION_ID = 'video-session-v';
const FILE_ID = 'file-v';

let fetched: number[];
let pageInbox: any[];

/** A backend that serves `served[i]` for index i. */
const installBackend = (served: Uint8Array[]) => {
	vi.stubGlobal('fetch', async (input: string) => {
		const index = Number(/\/file_chunk\/[^/]+\/(\d+)$/.exec(String(input))?.[1]);
		fetched.push(index);
		return new Response(served[index] as Uint8Array<ArrayBuffer>, { status: 200 });
	});
};

/** A page that answers need-chunk-hash with `answer(index)` — a hash, or null for a row it refused. */
const addPage = (worker: TestWorker, answer: (index: number) => string | null) => {
	worker.clients.push({
		postMessage: (msg) => {
			pageInbox.push(msg);
			if (msg.type === 'need-chunk-hash') {
				setTimeout(() => worker.postToWorker({ type: 'chunk-hash', sessionId: msg.sessionId, index: msg.index, hash: answer(msg.index) }), 20);
			}
		},
	});
};

const register = (worker: TestWorker, secret: Uint8Array, chunkHashes: Record<number, string>) =>
	worker.postToWorker({
		type: 'register', sessionId: SESSION_ID, fileId: FILE_ID, encSecret: secret, chunkSize: CHUNK,
		totalSize: CHUNK * PLAINS.length, mimeType: 'video/mp4', baseUrl: 'https://api.test', token: 'fresh-token', chunkHashes,
	});

const play = (worker: TestWorker, index: number) => worker.request(`/encrypted-video/${SESSION_ID}`, rangeOf(index, CHUNK)).then(bodyOf);

const setup = async () => {
	const worker = await loadWorker();
	const secret = crypto.getRandomValues(new Uint8Array(32));
	const blobs = await Promise.all(PLAINS.map((p) => encryptChunk(secret, p)));
	return { worker, secret, blobs, hashes: blobs.map(chunkDataHash) };
};

beforeEach(() => {
	fetched = [];
	pageInbox = [];
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the video worker holds each chunk to its verified hash', () => {
	it('serves a chunk whose bytes are the signed ones', async () => {
		const { worker, secret, blobs, hashes } = await setup();
		installBackend(blobs);
		register(worker, secret, { 0: hashes[0], 1: hashes[1] });
		expect(await play(worker, 1)).toEqual({ ok: true, bytes: PLAINS[1] });
	});

	it('refuses chunk 1\'s bytes served for index 0, though they decrypt, and tells the page', async () => {
		const { worker, secret, blobs, hashes } = await setup();
		installBackend([blobs[1], blobs[1]]);
		addPage(worker, (i) => hashes[i]);
		register(worker, secret, { 0: hashes[0], 1: hashes[1] });
		const res = await play(worker, 0);
		expect(res).toMatchObject({ ok: false, error: expect.stringContaining('chunk 0: could not be verified') });
		expect(pageInbox).toEqual([{ type: 'chunk-refused', sessionId: SESSION_ID, index: 0 }]);
	});

	it('asks the page for the hash of a chunk it was not given, and plays with the answer', async () => {
		const { worker, secret, blobs, hashes } = await setup();
		installBackend(blobs);
		addPage(worker, (i) => hashes[i]);
		register(worker, secret, { 0: hashes[0] });
		expect(await play(worker, 1)).toEqual({ ok: true, bytes: PLAINS[1] });
		expect(pageInbox).toEqual([{ type: 'need-chunk-hash', sessionId: SESSION_ID, index: 1 }]);
	});

	it('does not fetch a chunk the page has no hash for', async () => {
		const { worker, secret, blobs, hashes } = await setup();
		installBackend(blobs);
		addPage(worker, () => null);
		register(worker, secret, { 0: hashes[0] });
		expect((await play(worker, 1)).ok).toBe(false);
		expect(fetched).toEqual([]);
	});
});

describe('the page behind a video session', () => {
	const pageSetup = async (expected: (index: number) => Promise<string>) => {
		vi.resetModules();
		vi.doMock('@/lib/data/readSession', () => ({ bearerFor: () => 'Bearer t', openSession: async () => 't' }));
		vi.doMock('@/lib/data/fileTransfer', () => ({ downloadFile: async () => { throw new Error('fallback not expected'); } }));
		vi.doMock('@/lib/data/mediaCache', () => ({ getCachedMedia: () => null, putCachedMedia: () => '' }));
		vi.doMock('@/lib/data/fileIntegrity', async (importOriginal) => ({
			...(await importOriginal<typeof import('@/lib/data/fileIntegrity')>()),
			readVerifiedFile: async () => ({ manifest: { fileId: FILE_ID, chunkCount: 2, deleted: false }, hashes: { expected } }),
		}));
		const listeners: Record<string, Array<(e: any) => void>> = {};
		const toWorker: any[] = [];
		vi.stubGlobal('window', { isSecureContext: true });
		vi.stubGlobal('navigator', {
			serviceWorker: {
				controller: { postMessage: (m: any) => toWorker.push(m) },
				ready: Promise.resolve(),
				getRegistration: async () => ({}),
				addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] ??= []).push(fn),
			},
		});
		const { openVideo } = await import('@/lib/data/videoStream');
		const { FileVerificationError } = await import('@/lib/data/fileIntegrity');
		const fromWorker = (data: any) => listeners.message?.forEach((fn) => fn({ data }));
		return { openVideo, FileVerificationError, toWorker, fromWorker };
	};
	const video = { fileId: FILE_ID, uploaderHash: 'u_' + 'a'.repeat(128), encSecretB64: 'AAAA', size: 32, mimeType: 'video/mp4' };
	const settle = () => new Promise((r) => setTimeout(r, 20));

	afterEach(() => {
		for (const m of ['readSession', 'fileTransfer', 'mediaCache', 'fileIntegrity']) vi.doUnmock(`@/lib/data/${m}`);
	});

	it('registers with chunk 0 verified, answers a later index, and reports a refused one', async () => {
		let refusedBy: unknown = null;
		const tab = await pageSetup(async (i) => {
			if (i === 0) return 'fd_zero';
			if (i === 1) return 'fd_one';
			throw new tab.FileVerificationError(FILE_ID, 'invalid', 'forged row', i);
		});
		const source = await tab.openVideo(video, { onRefused: (e) => (refusedBy = e) });
		const sessionId = source.url.split('/').pop();
		expect(tab.toWorker[0]).toMatchObject({ type: 'register', sessionId, chunkHashes: { 0: 'fd_zero' } });

		tab.fromWorker({ type: 'need-chunk-hash', sessionId, index: 1 });
		tab.fromWorker({ type: 'need-chunk-hash', sessionId, index: 2 });
		await settle();
		expect(tab.toWorker.slice(1)).toEqual([
			{ type: 'chunk-hash', sessionId, index: 1, hash: 'fd_one' },
			{ type: 'chunk-hash', sessionId, index: 2, hash: null },
		]);
		expect(refusedBy).toBeInstanceOf(tab.FileVerificationError);
	});

	it('reports what the worker refused, and a chunk not verifiable yet as a failure to retry', async () => {
		const refused: unknown[] = [];
		const unavailable: unknown[] = [];
		const tab = await pageSetup(async (i) => {
			if (i === 0) return 'fd_zero';
			throw new tab.FileVerificationError(FILE_ID, 'unavailable', 'row not here', i);
		});
		const source = await tab.openVideo(video, { onRefused: (e) => refused.push(e), onUnavailable: (e) => unavailable.push(e) });
		const sessionId = source.url.split('/').pop();
		tab.fromWorker({ type: 'chunk-refused', sessionId, index: 0 });
		tab.fromWorker({ type: 'need-chunk-hash', sessionId, index: 1 });
		await settle();
		expect(refused).toEqual([expect.objectContaining({ kind: 'invalid', chunkIndex: 0 })]);
		expect(unavailable).toEqual([expect.objectContaining({ kind: 'unavailable', chunkIndex: 1 })]);
		expect(tab.toWorker.at(-1)).toEqual({ type: 'chunk-hash', sessionId, index: 1, hash: null });
	});

	it('refuses at open a file whose first chunk is refused, and registers nothing', async () => {
		const tab = await pageSetup(async (i) => {
			throw new tab.FileVerificationError(FILE_ID, 'invalid', 'forged row', i);
		});
		await expect(tab.openVideo(video)).rejects.toMatchObject({ kind: 'invalid', chunkIndex: 0 });
		expect(tab.toWorker).toEqual([]);
	});
});

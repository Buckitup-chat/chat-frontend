// Client side of progressive video playback (chat docs: reqs/pq_video_streaming.md).
//
// Registers a session with the Service Worker and hands back a URL a <video>
// element can play; the worker answers its range requests by fetching and
// decrypting chunks. Where no worker is available — unsupported browser, a
// context the browser does not trust, registration failure — playback falls
// back to downloading the whole file and playing a blob: the feature
// degrades in waiting time, not away.
//
// Sessions are re-announced, not fire-and-forget. The browser kills an idle
// worker and its in-memory session table dies with it while the page still
// holds a playing <video>; the worker then asks (need-session) and every
// controller change re-sends whatever is active, so playback survives both
// worker restarts and worker updates.

import { fromBase64 } from '@/lib/pq/signature';
import { CHUNK_SIZE } from '@/lib/pq/fileCrypto';
import { downloadFile, type DownloadProgress } from './fileTransfer';
import { isRefusedFile, readVerifiedFile, type ChunkHashes } from './fileIntegrity';
import { getCachedMedia, putCachedMedia } from './mediaCache';
import { bearerFor, openSession } from './readSession';

declare const ELECTRIC_API_URL: string;

export interface VideoRef {
	fileId: string;
	/** The sender of the message carrying the video: the manifest and chunks must be theirs. */
	uploaderHash: string;
	encSecretB64: string;
	size: number;
	mimeType: string;
}

export interface VideoSource {
	url: string;
	/** True when bytes stream on demand rather than downloading up front. */
	streaming: boolean;
	release: () => void;
}

interface Session {
	/** What the worker is sent, re-sent after a worker restart; its `chunkHashes` grow as chunks are verified. */
	registration: Record<string, unknown> & { chunkHashes: Record<number, string> };
	hashes: ChunkHashes;
	onRefused?: (e: unknown) => void;
}

/** Every live session, keyed by session id. */
const active = new Map<string, Session>();
let listenersInstalled = false;

const post = (message: unknown) => navigator.serviceWorker.controller?.postMessage(message);

const installListeners = () => {
	if (listenersInstalled) return;
	listenersInstalled = true;
	navigator.serviceWorker.addEventListener('message', (event) => {
		const msg = event.data as { type?: string; sessionId?: string; index?: number };
		const session = msg?.sessionId ? active.get(msg.sessionId) : undefined;
		if (msg?.type === 'need-session' && session) {
			post(session.registration);
		} else if (msg?.type === 'need-chunk-hash' && session && Number.isInteger(msg.index)) {
			// The worker plays a chunk only with the hash its signed row gives;
			// a refused row is the whole video refused.
			const { sessionId, index } = msg as { sessionId: string; index: number };
			session.hashes.expected(index).then(
				(hash) => {
					session.registration.chunkHashes[index] = hash;
					post({ type: 'chunk-hash', sessionId, index, hash });
				},
				(e) => {
					if (isRefusedFile(e)) session.onRefused?.(e);
					post({ type: 'chunk-hash', sessionId, index, hash: null });
				},
			);
		} else if (msg?.type === 'need-token' && session) {
			void openSession('file_chunk').then((token) => {
				post({ type: 'token', sessionId: msg.sessionId, token: token || '' });
			});
		}
	});
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		for (const session of active.values()) post(session.registration);
	});
};

let workerReady: Promise<boolean> | null = null;

/**
 * True once a worker controls this page. `ready` resolves on activation, but
 * on the very first load the page is only claimed a beat later — wait for
 * the controllerchange rather than treating the gap as "no worker".
 */
const ensureWorker = (): Promise<boolean> => {
	if (workerReady) return workerReady;
	workerReady = (async () => {
		if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
		try {
			// The app worker (src/sw.js, registered from main.js) hosts the video
			// streamer; when it is absent — dev stand, PWA disabled — this path
			// reports no worker and openVideo takes the download fallback.
			if (!(await navigator.serviceWorker.getRegistration())) return false;
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 3000);
					navigator.serviceWorker.addEventListener('controllerchange', () => {
						clearTimeout(timer);
						resolve();
					}, { once: true });
				});
			}
			if (!navigator.serviceWorker.controller) return false;
			installListeners();
			return true;
		} catch {
			return false;
		}
	})();
	return workerReady;
};

/**
 * A playable source for an encrypted video.
 *
 * `onProgress` fires only on the fallback path — while streaming, the
 * browser decides what to fetch and there is no whole-file progress.
 */
export const openVideo = async (
	video: VideoRef,
	opts: {
		onProgress?: (p: DownloadProgress) => void;
		/**
		 * Fallback path only: a playable URL over the prefix downloaded so
		 * far, delivered once after the first chunk. Faststart encodings play
		 * from it immediately; the rest keeps downloading behind the scenes,
		 * and the resolved full URL replaces it at the end.
		 */
		onPartial?: (url: string) => void;
		/** Streaming path: a chunk refused after playback started — the video could not be verified. */
		onRefused?: (e: unknown) => void;
		signal?: AbortSignal;
	} = {},
): Promise<VideoSource> => {
	if (await ensureWorker()) {
		// The worker decrypts what it fetches but does not verify signatures:
		// it holds each chunk to the hash verified here (fileIntegrity.ts),
		// asking for each as it plays. The manifest and the first chunk are
		// verified now, so a refused file is refused at open.
		const file = await readVerifiedFile(video.fileId, video.uploaderHash, { signal: opts.signal });
		if (!file) throw new Error('file manifest not found');
		if (file.manifest.deleted) throw new Error('file was deleted by its uploader');
		const first = await file.hashes.expected(0);
		const sessionId = crypto.randomUUID();
		const bearer = bearerFor('file_chunk');
		const registration = {
			type: 'register',
			sessionId,
			fileId: video.fileId,
			encSecret: fromBase64(video.encSecretB64),
			chunkSize: CHUNK_SIZE,
			totalSize: video.size,
			mimeType: video.mimeType,
			baseUrl: ELECTRIC_API_URL,
			token: bearer ? bearer.replace('Bearer ', '') : '',
			chunkHashes: { 0: first } as Record<number, string>,
		};
		active.set(sessionId, { registration, hashes: file.hashes, onRefused: opts.onRefused });
		post(registration);
		return {
			url: `/encrypted-video/${sessionId}`,
			streaming: true,
			release: () => {
				active.delete(sessionId);
				post({ type: 'unregister', sessionId });
			},
		};
	}

	// Chunks are immutable, so a downloaded video never goes stale — the
	// media cache keeps it across dialog switches, and re-entering the chat
	// replays without downloading again. The cache owns the URL; release is
	// a no-op on this path.
	const cached = getCachedMedia(video.fileId);
	if (cached) return { url: cached, streaming: false, release: () => {} };

	const prefix: Uint8Array[] = [];
	let partialUrl: string | null = null;
	const bytes = await downloadFile({
		fileId: video.fileId,
		uploaderHash: video.uploaderHash,
		encSecretB64: video.encSecretB64,
		onProgress: opts.onProgress,
		onChunk: (index, plain) => {
			prefix.push(plain);
			// One partial after the first chunk: replacing the src per chunk
			// would restart the element more than it plays.
			if (index === 0 && opts.onPartial) {
				partialUrl = URL.createObjectURL(new Blob(prefix as unknown as globalThis.BlobPart[], { type: video.mimeType || 'video/mp4' }));
				opts.onPartial(partialUrl);
			}
		},
		signal: opts.signal,
	});
	const url = putCachedMedia(video.fileId, bytes, video.mimeType || 'video/mp4');
	if (partialUrl) URL.revokeObjectURL(partialUrl);
	return { url, streaming: false, release: () => {} };
};

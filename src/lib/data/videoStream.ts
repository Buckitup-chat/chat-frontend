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
import { getCachedMedia, putCachedMedia } from './mediaCache';

declare const ELECTRIC_API_URL: string;

export interface VideoRef {
	fileId: string;
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

/** Registration payloads for every live session, keyed by session id. */
const active = new Map<string, Record<string, unknown>>();
let listenersInstalled = false;

const post = (message: unknown) => navigator.serviceWorker.controller?.postMessage(message);

const installListeners = () => {
	if (listenersInstalled) return;
	listenersInstalled = true;
	navigator.serviceWorker.addEventListener('message', (event) => {
		const msg = event.data as { type?: string; sessionId?: string };
		if (msg?.type === 'need-session' && msg.sessionId && active.has(msg.sessionId)) {
			post(active.get(msg.sessionId));
		}
	});
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		for (const registration of active.values()) post(registration);
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
			await navigator.serviceWorker.register('/video-sw.js');
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
		signal?: AbortSignal;
	} = {},
): Promise<VideoSource> => {
	if (await ensureWorker()) {
		const sessionId = crypto.randomUUID();
		const registration = {
			type: 'register',
			sessionId,
			fileId: video.fileId,
			encSecret: fromBase64(video.encSecretB64),
			chunkSize: CHUNK_SIZE,
			totalSize: video.size,
			mimeType: video.mimeType,
			baseUrl: ELECTRIC_API_URL,
		};
		active.set(sessionId, registration);
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

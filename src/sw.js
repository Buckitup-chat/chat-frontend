// The app's one service worker (a scope allows only one): the offline shell
// and the encrypted-video streamer live together here.
//
// Shell: every build asset is precached, navigations fall back to the cached
// index.html — the app opens and runs on a device with no reachable backend
// at all (offline-first: vault login, persisted shapes, chunk cache and the
// outbox are all local). `/api` is deliberately untouched: Electric
// long-polls and ingest must never be served from a cache.
//
// Video (chat docs: reqs/pq_video_streaming.md): the browser's <video> stack
// issues range requests against /encrypted-video/<session>; each range maps
// to chunks, fetched as ciphertext and decrypted here with AES-256-GCM. This
// file is bundled, so the range arithmetic is imported from videoRange.ts —
// the same code the unit tests pin.
import { precacheAndRoute, createHandlerBoundToURL, cleanupOutdatedCaches } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { parseRange, planChunks } from '@/lib/pq/videoRange';

self.skipWaiting();
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ---------- offline shell ----------

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), {
	denylist: [/\/encrypted-video\//, /\/api\//],
}));

// ---------- encrypted video streaming ----------

const sessions = new Map();
const MAX_CHUNKS_PER_RESPONSE = 4;
const CACHE_LIMIT = 8; // decrypted chunks; 8 × 4 MiB = 32 MiB ceiling

self.addEventListener('message', (event) => {
	const msg = event.data || {};
	if (msg.type === 'register') {
		sessions.set(msg.sessionId, {
			fileId: msg.fileId,
			encSecret: msg.encSecret, // raw bytes; never logged
			chunkSize: msg.chunkSize,
			totalSize: msg.totalSize,
			mimeType: msg.mimeType,
			baseUrl: msg.baseUrl,
			cache: new Map(),
			key: null,
		});
	} else if (msg.type === 'unregister') {
		sessions.delete(msg.sessionId);
	}
});

// The browser kills an idle worker and this map dies with it, while the page
// keeps a <video> pointed at the session URL. An unknown session is therefore
// a normal event, not a client bug: ask the pages to re-register and give
// them a moment before giving up.
const recoverSession = async (sessionId) => {
	const clients = await self.clients.matchAll({ type: 'window' });
	for (const c of clients) c.postMessage({ type: 'need-session', sessionId });
	for (let i = 0; i < 20 && !sessions.has(sessionId); i++) {
		await new Promise((r) => setTimeout(r, 100));
	}
	return sessions.get(sessionId);
};

const importKey = async (session) => {
	if (!session.key) {
		session.key = await crypto.subtle.importKey('raw', session.encSecret, { name: 'AES-GCM' }, false, ['decrypt']);
	}
	return session.key;
};

const getChunk = async (session, index) => {
	const hit = session.cache.get(index);
	if (hit) {
		// re-insert to refresh the LRU position
		session.cache.delete(index);
		session.cache.set(index, hit);
		return hit;
	}
	const r = await fetch(`${session.baseUrl}/file_chunk/${session.fileId}/${index}`);
	if (!r.ok) throw new Error(`chunk ${index}: HTTP ${r.status}`);
	const blob = new Uint8Array(await r.arrayBuffer());
	// nonce(12) || ciphertext || tag — GCM failing means the bytes are not
	// what the sender encrypted, and nothing unverified is ever served.
	const plain = new Uint8Array(await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: blob.slice(0, 12) },
		await importKey(session),
		blob.slice(12),
	));
	session.cache.set(index, plain);
	while (session.cache.size > CACHE_LIMIT) {
		session.cache.delete(session.cache.keys().next().value);
	}
	return plain;
};

/**
 * Streams a byte range chunk by chunk: the first slice reaches the media
 * stack while the next chunk is still downloading, instead of after the
 * whole span is buffered. Cancel (the browser aborts superseded range
 * requests constantly while seeking) just stops the pull loop.
 */
const streamRange = (session, start, end) => {
	let position = start;
	return new ReadableStream({
		async pull(controller) {
			if (position > end) {
				controller.close();
				return;
			}
			const index = Math.floor(position / session.chunkSize);
			const chunk = await getChunk(session, index);
			const offset = position - index * session.chunkSize;
			const take = Math.min(chunk.length - offset, end - position + 1);
			controller.enqueue(chunk.slice(offset, offset + take));
			position += take;
		},
	});
};

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	const match = /^\/encrypted-video\/([^/?#]+)$/.exec(url.pathname);
	if (!match) return;

	event.respondWith((async () => {
		const session = sessions.get(match[1]) ?? await recoverSession(match[1]);
		if (!session) return new Response('unknown video session', { status: 404 });

		try {
			const range = parseRange(event.request.headers.get('range'), session.totalSize);
			const headers = {
				'Content-Type': session.mimeType || 'video/mp4',
				'Accept-Ranges': 'bytes',
				'Cache-Control': 'no-store',
			};

			// No Range yet: the probe request. Stream the whole file with its
			// true length — the media stack typically aborts this once it sees
			// Accept-Ranges and switches to ranges, and a reader that does
			// keep pulling gets correct progressive delivery either way.
			// (A fixed-length body shorter than Content-Length would be a
			// truncated response, which players treat as a broken file.)
			if (!range) {
				return new Response(streamRange(session, 0, session.totalSize - 1), {
					status: 200,
					headers: { ...headers, 'Content-Length': String(session.totalSize) },
				});
			}

			// Serving less than asked is legal and deliberate: without the cap
			// an open-ended range would pull the entire file for one response.
			const plan = planChunks(range, session.chunkSize, session.totalSize, MAX_CHUNKS_PER_RESPONSE);
			return new Response(streamRange(session, plan.served.start, plan.served.end), {
				status: 206,
				headers: {
					...headers,
					'Content-Range': `bytes ${plan.served.start}-${plan.served.end}/${session.totalSize}`,
					'Content-Length': String(plan.served.end - plan.served.start + 1),
				},
			});
		} catch (e) {
			return new Response(`video stream error: ${e.message}`, { status: 500 });
		}
	})());
});

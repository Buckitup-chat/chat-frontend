// Progressive playback of encrypted video (chat docs: reqs/pq_video_streaming.md).
//
// The browser's own <video> stack drives everything: it issues range
// requests, this worker answers them. Each range maps to the chunks covering
// it; chunks are fetched from the device, decrypted here with AES-256-GCM,
// and the requested bytes are streamed back. The device only ever serves
// ciphertext, and seeking works because the media stack may ask for any
// range it likes.
//
// Standalone by necessity: a worker cannot import from the app bundle, so
// the range arithmetic mirrors src/lib/pq/videoRange.ts (tested there) and
// the decrypt mirrors the chunk format in src/lib/pq/fileCrypto.ts. Change
// one, change the other.

const sessions = new Map();
const MAX_CHUNKS_PER_RESPONSE = 4;
const CACHE_LIMIT = 8; // decrypted chunks; 8 × 4 MiB = 32 MiB ceiling

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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

// --- mirrors src/lib/pq/videoRange.ts ---
const parseRange = (header, totalSize) => {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return null;
	const [, rawStart, rawEnd] = m;
	if (rawStart === '' && rawEnd === '') return null;
	if (rawStart === '') {
		const len = Number(rawEnd);
		if (!len) return null;
		return { start: Math.max(0, totalSize - len), end: totalSize - 1 };
	}
	const start = Number(rawStart);
	if (start >= totalSize) return null;
	const end = rawEnd === '' ? totalSize - 1 : Math.min(Number(rawEnd), totalSize - 1);
	return end < start ? null : { start, end };
};

const planChunks = (range, chunkSize, totalSize, maxChunks) => {
	const firstChunk = Math.floor(range.start / chunkSize);
	const wantedLast = Math.floor(Math.min(range.end, totalSize - 1) / chunkSize);
	const lastChunk = Math.min(wantedLast, firstChunk + maxChunks - 1);
	const servedEnd = Math.min(range.end, (lastChunk + 1) * chunkSize - 1, totalSize - 1);
	return { firstChunk, lastChunk, offsetInFirst: range.start - firstChunk * chunkSize, served: { start: range.start, end: servedEnd } };
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

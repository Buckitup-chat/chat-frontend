// Byte-range → chunk mapping for progressive video (chat docs:
// reqs/pq_video_streaming.md §5.3).
//
// The browser's media stack drives playback with HTTP range requests. A
// range has to be turned into the chunks that cover it, decrypted, and
// sliced back to the exact bytes asked for. This module is that arithmetic
// on its own so it can be tested; the Service Worker carries the same logic
// inline, because a worker cannot import from the bundle.

export interface RangeSpec {
	start: number;
	end: number;
}

/** Parses "bytes=START-[END]"; open-ended ranges run to the last byte. */
export const parseRange = (header: string | null, totalSize: number): RangeSpec | null => {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return null;
	const [, rawStart, rawEnd] = m;
	if (rawStart === '' && rawEnd === '') return null;

	// A suffix range ("bytes=-500") means the last N bytes.
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

export interface ChunkPlan {
	firstChunk: number;
	lastChunk: number;
	/** Offset of `start` inside firstChunk's plaintext. */
	offsetInFirst: number;
	/** Byte range actually served, after the cap. */
	served: RangeSpec;
}

/**
 * Chunks covering a range, capped so one response cannot pull the whole file.
 *
 * Without the cap an open-ended range ("bytes=0-") would fetch and decrypt
 * every chunk before a single frame plays, which is the wait progressive
 * playback exists to avoid. Serving less than asked is legal: the browser
 * simply asks for the rest.
 */
export const planChunks = (
	range: RangeSpec,
	chunkSize: number,
	totalSize: number,
	maxChunks = 4,
): ChunkPlan => {
	const firstChunk = Math.floor(range.start / chunkSize);
	const wantedLast = Math.floor(Math.min(range.end, totalSize - 1) / chunkSize);
	const lastChunk = Math.min(wantedLast, firstChunk + maxChunks - 1);
	const servedEnd = Math.min(range.end, (lastChunk + 1) * chunkSize - 1, totalSize - 1);
	return {
		firstChunk,
		lastChunk,
		offsetInFirst: range.start - firstChunk * chunkSize,
		served: { start: range.start, end: servedEnd },
	};
};

/** Plaintext length of a chunk — the last one is short. */
export const chunkPlainSize = (index: number, chunkSize: number, totalSize: number): number => {
	const last = Math.floor((totalSize - 1) / chunkSize);
	return index >= last ? totalSize - last * chunkSize : chunkSize;
};

export const contentRange = (r: RangeSpec, totalSize: number): string =>
	`bytes ${r.start}-${r.end}/${totalSize}`;

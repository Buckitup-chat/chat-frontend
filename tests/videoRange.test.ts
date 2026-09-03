import { describe, it, expect } from 'vitest';
import { parseRange, planChunks, chunkPlainSize, contentRange } from '@/lib/pq/videoRange';

const MB = 4 * 1024 * 1024;
const TOTAL = 10 * MB + 1000; // 3 chunks: two full, one short

describe('parseRange', () => {
	it('parses a closed range', () => {
		expect(parseRange('bytes=100-199', TOTAL)).toEqual({ start: 100, end: 199 });
	});

	// The first request a media element makes is open-ended.
	it('runs an open-ended range to the last byte', () => {
		expect(parseRange('bytes=0-', TOTAL)).toEqual({ start: 0, end: TOTAL - 1 });
	});

	it('reads a suffix range as the last N bytes', () => {
		expect(parseRange('bytes=-500', TOTAL)).toEqual({ start: TOTAL - 500, end: TOTAL - 1 });
	});

	it('clamps an end past the file to the last byte', () => {
		expect(parseRange(`bytes=0-${TOTAL + 999}`, TOTAL)).toEqual({ start: 0, end: TOTAL - 1 });
	});

	it('rejects nonsense and out-of-range starts', () => {
		expect(parseRange(null, TOTAL)).toBe(null);
		expect(parseRange('items=0-1', TOTAL)).toBe(null);
		expect(parseRange('bytes=-', TOTAL)).toBe(null);
		expect(parseRange(`bytes=${TOTAL}-`, TOTAL)).toBe(null);
		expect(parseRange('bytes=500-100', TOTAL)).toBe(null);
	});
});

describe('planChunks', () => {
	it('maps a range inside one chunk', () => {
		const p = planChunks({ start: 10, end: 99 }, MB, TOTAL);
		expect(p).toMatchObject({ firstChunk: 0, lastChunk: 0, offsetInFirst: 10 });
		expect(p.served).toEqual({ start: 10, end: 99 });
	});

	it('spans chunks and keeps the offset into the first', () => {
		const p = planChunks({ start: MB + 5, end: 2 * MB + 10 }, MB, TOTAL);
		expect(p).toMatchObject({ firstChunk: 1, lastChunk: 2, offsetInFirst: 5 });
	});

	// Without the cap an open-ended range would decrypt the entire file
	// before playback could start — the wait this design exists to avoid.
	it('caps how much one response may pull, serving less than asked', () => {
		const p = planChunks({ start: 0, end: TOTAL - 1 }, MB, TOTAL, 4);
		expect(p.lastChunk).toBe(3);
		expect(p.served.end).toBe(4 * MB - 1);
		expect(p.served.end).toBeLessThan(TOTAL - 1);
	});

	it('never reaches past the end of the file', () => {
		const p = planChunks({ start: TOTAL - 10, end: TOTAL - 1 }, MB, TOTAL);
		expect(p.served.end).toBe(TOTAL - 1);
		expect(p.lastChunk).toBe(Math.floor((TOTAL - 1) / MB));
	});
});

describe('chunkPlainSize', () => {
	it('is the chunk size for full chunks and the remainder for the last', () => {
		expect(chunkPlainSize(0, MB, TOTAL)).toBe(MB);
		const last = Math.floor((TOTAL - 1) / MB);
		expect(chunkPlainSize(last, MB, TOTAL)).toBe(TOTAL - last * MB);
	});
});

describe('contentRange', () => {
	it('formats what the media stack expects', () => {
		expect(contentRange({ start: 0, end: 99 }, TOTAL)).toBe(`bytes 0-99/${TOTAL}`);
	});
});

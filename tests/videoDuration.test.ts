import { describe, it, expect } from 'vitest';
import { videoDurationSeconds } from '@/lib/data/imageMeta';
import { encodeContent } from '@/lib/pq/content';

describe('videoDurationSeconds', () => {
	it('rounds a 0.1–0.49 s clip up to 1, not down to unknown', () => {
		expect(videoDurationSeconds(0.1)).toBe(1);
		expect(videoDurationSeconds(0.49)).toBe(1);
	});

	it('rounds a normal duration to the nearest second', () => {
		expect(videoDurationSeconds(1.4)).toBe(1);
		expect(videoDurationSeconds(1.5)).toBe(2);
		expect(videoDurationSeconds(127.2)).toBe(127);
	});

	it('maps 0, negative, NaN and Infinity to 0 (unknown)', () => {
		expect(videoDurationSeconds(0)).toBe(0);
		expect(videoDurationSeconds(-3)).toBe(0);
		expect(videoDurationSeconds(NaN)).toBe(0);
		expect(videoDurationSeconds(Infinity)).toBe(0);
	});
});

describe('outgoing video envelope positions', () => {
	it('keeps duration_seconds at [7], file_id at [8], enc_secret at [9]', () => {
		const fileId = 'f_' + '3'.repeat(32);
		const wire = encodeContent([{
			kind: 'video',
			widthAspect: 16, heightAspect: 9, thumbHashB64: 'YTg4', name: 'short.mp4',
			size: 1024, mimeType: 'video/mp4', createdAt: 1715000000,
			fileId, encSecretB64: 'c2VjcmV0',
			durationSeconds: videoDurationSeconds(0.3),
		}]);
		const fields = JSON.parse(wire).video;
		expect(fields[7]).toBe(1);
		expect(fields[8]).toBe(fileId);
		expect(fields[9]).toBe('c2VjcmV0');
	});
});

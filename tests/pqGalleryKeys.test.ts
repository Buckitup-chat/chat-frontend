import { describe, it, expect } from 'vitest';
import { deriveInitialGalleryUuid, deriveInitialGalleryKey } from '@/lib/pq/galleryKeys';
import { toBase64Unpadded } from '@/lib/pq/signature';

const SECRET = new Uint8Array(32).fill(7);

describe('initial gallery derivation', () => {
	it('is pinned', () => {
		expect(deriveInitialGalleryUuid(SECRET)).toBe('94304922-a3af-88c5-8096-a29fec69d409');
		expect(toBase64Unpadded(deriveInitialGalleryKey(SECRET))).toBe('SuO2DysXew/MuXn5/UhrsO2ratmIJY1lGrkZTcPd5aM');
	});

	it('refuses an absent secret instead of deriving one gallery for everyone', () => {
		expect(() => deriveInitialGalleryUuid(new Uint8Array(0))).toThrow(TypeError);
		expect(() => deriveInitialGalleryKey(undefined as unknown as Uint8Array)).toThrow(TypeError);
	});
});

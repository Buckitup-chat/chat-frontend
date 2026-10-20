import { describe, it, expect } from 'vitest';
import {
	encodeContent, decodeContent, contentToText, previewText, quoteSnapshot,
	type AvatarGalleryAccessPart, type ContentPart,
} from '@/lib/pq/content';
import { toBase64Unpadded } from '@/lib/pq/signature';

const UUID = '0b7e3a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b';
const KEY = toBase64Unpadded(new Uint8Array(32).fill(7));
const grant: AvatarGalleryAccessPart = { kind: 'avatar_gallery_access', version: 1, galleryUuid: UUID, galleryKeyB64: KEY };
const wire = (value: unknown) => JSON.stringify({ avatar_gallery_access: value });

describe('avatar_gallery_access envelope', () => {
	it('round-trips at its positions: version, uuid, key', () => {
		const json = encodeContent([grant]);
		expect(json).toBe(wire([1, UUID, KEY]));
		expect(decodeContent(json)).toEqual([grant]);
	});

	it('reads an unknown version as no grant, kept verbatim', () => {
		const json = wire([2, UUID, KEY]);
		const parts = decodeContent(json);
		expect(parts).toEqual([{ kind: 'unknown', type: 'avatar_gallery_access', value: [2, UUID, KEY] }]);
		expect(encodeContent(parts)).toBe(json);
	});

	it('refuses to encode a grant a reader would drop', () => {
		for (const bad of [
			{ ...grant, galleryUuid: 'not-a-uuid' },
			{ ...grant, galleryKeyB64: KEY + '=' },
			{ ...grant, version: 2 as unknown as 1 },
		]) {
			expect(() => encodeContent([bad])).toThrow(TypeError);
		}
	});
});

describe('avatar_gallery_access is control content', () => {
	const unreadable: ContentPart = { kind: 'unknown', type: 'avatar_gallery_access', value: [2, UUID, KEY] };

	it('contributes no text and no preview, so copy and history show none of it', () => {
		for (const part of [grant, unreadable]) {
			expect(contentToText([part])).toBe('');
			expect(previewText([part])).toBe('');
			expect(contentToText([{ kind: 'text', text: 'hi' }, part])).toBe('hi');
			expect(previewText([part, { kind: 'text', text: 'hi' }])).toBe('hi');
		}
	});

	it('is left out of a quote, not named in it', () => {
		const snapshot = quoteSnapshot([{ kind: 'text', text: 'hi' }, grant, unreadable]);
		expect(snapshot).toEqual([{ kind: 'text', text: 'hi' }]);
	});
});

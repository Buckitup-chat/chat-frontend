// Preview metadata for outgoing images (design board §1.3).
//
// The bubble must reserve the picture's space before any byte of it arrives,
// so the message carries the aspect ratio and a ThumbHash — a ~25-byte blur
// preview. Both are computed here, in the browser, from the plaintext image:
// the device never sees it, so nobody else can produce them.

import { rgbaToThumbHash } from 'thumbhash';
import { toBase64 } from '@/lib/pq/signature';

export interface ImagePreview {
	widthAspect: number;
	heightAspect: number;
	thumbHashB64: string;
}

export const isImageMime = (mime: string): boolean =>
	/^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime || '');

/** Smallest whole-number ratio, so "1920x1080" travels as 16:9. */
const reduceRatio = (w: number, h: number): [number, number] => {
	const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
	const d = gcd(Math.round(w), Math.round(h)) || 1;
	return [Math.round(w) / d, Math.round(h) / d];
};

/**
 * Decodes the image, scales it into ThumbHash's 100x100 budget and hashes it.
 * Returns null when the file will not decode as an image — the caller then
 * sends it as a plain file rather than claiming a preview it does not have.
 */
export const buildImagePreview = async (blob: Blob): Promise<ImagePreview | null> => {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(blob);
	} catch {
		return null;
	}
	try {
		const scale = Math.min(100 / bitmap.width, 100 / bitmap.height, 1);
		const w = Math.max(1, Math.round(bitmap.width * scale));
		const h = Math.max(1, Math.round(bitmap.height * scale));

		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(bitmap, 0, 0, w, h);
		const { data } = ctx.getImageData(0, 0, w, h);

		const [widthAspect, heightAspect] = reduceRatio(bitmap.width, bitmap.height);
		return {
			widthAspect,
			heightAspect,
			thumbHashB64: toBase64(new Uint8Array(rgbaToThumbHash(w, h, data))),
		};
	} finally {
		bitmap.close();
	}
};

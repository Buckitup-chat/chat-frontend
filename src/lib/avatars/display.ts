// Drawing profile photos: what a photo element shows before and after its
// bytes arrive.

import { thumbHashToDataURL } from 'thumbhash';
import { fromBase64 } from '@/lib/pq/signature';
import type { AvatarPhoto } from '@/lib/pq/content';

const DRAWABLE = /^image\/(jpeg|png|webp|gif)$/;

/** The MIME type a photo is drawn as: the sender's word only when it names a picture format. */
export const imageMime = (mimeType: string): string => (DRAWABLE.test(mimeType) ? mimeType : 'image/jpeg');

/** An inline photo's bytes as a data URL; empty for an out-of-band one, whose bytes are fetched. */
export const inlineDataUrl = (photo: AvatarPhoto): string =>
	photo.kind === 'inline_image' && photo.dataB64 ? `data:${imageMime(photo.mimeType)};base64,${photo.dataB64}` : '';

const thumbs = new Map<string, string>();

/** The ThumbHash blur drawn while the photo is on its way; empty when there is none or it does not decode. */
export const thumbDataUrl = (photo: AvatarPhoto | null | undefined): string => {
	const hash = photo?.thumbHashB64;
	if (!hash) return '';
	let url = thumbs.get(hash);
	if (url === undefined) {
		try {
			url = thumbHashToDataURL(fromBase64(hash));
		} catch {
			url = '';
		}
		thumbs.set(hash, url);
	}
	return url;
};

/**
 * What an account record's `avatar` draws: the own account keeps a data URL,
 * a contact the `{ id, photo, thumb }` cache its dialog left behind.
 */
export const avatarSrcOf = (avatar: unknown): string => {
	if (typeof avatar === 'string') return avatar;
	const thumb = (avatar as { thumb?: unknown } | null)?.thumb;
	return typeof thumb === 'string' ? thumb : '';
};

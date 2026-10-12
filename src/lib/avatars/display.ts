// Drawing profile photos.

import { isImageMime, thumbDataUrl } from '@/lib/data/imageMeta';
import { photoFromWire, type AvatarPhoto } from '@/lib/pq/content';

/** The MIME type a photo is drawn as: the sender's word only when it names a picture format. */
export const imageMime = (mimeType: string): string => (isImageMime(mimeType) ? mimeType : 'image/jpeg');

export const dataUrlOf = (b64: string, mimeType: string): string => `data:${imageMime(mimeType)};base64,${b64}`;

/** An inline photo's bytes as a data URL; empty for an out-of-band one, whose bytes are fetched. */
export const inlineDataUrl = (photo: AvatarPhoto): string =>
	photo.kind === 'inline_image' && photo.dataB64 ? dataUrlOf(photo.dataB64, photo.mimeType) : '';

/**
 * A contact's current photo as the contacts slot caches it (pq_avatars §
 * What a reader keeps): its id and its wire element, or nothing.
 */
export const cachedPhotoOf = (avatar: unknown): { avatarId: string; photo: AvatarPhoto } | null => {
	const a = avatar as { id?: unknown; photo?: unknown } | null;
	const photo = a && typeof a.id === 'string' ? photoFromWire(a.photo) : null;
	return photo ? { avatarId: a!.id as string, photo } : null;
};

/** A gallery as the viewer's frames, newest first. */
export const galleryFrames = (
	entries: { avatarId: string; photo: AvatarPhoto }[],
	uploaderHash: string,
	photoUrl: (photo: AvatarPhoto, uploaderHash: string) => string,
) => entries.map(({ avatarId, photo }) => ({
	key: avatarId,
	src: photoUrl(photo, uploaderHash),
	placeholder: thumbDataUrl(photo),
	alt: 'Profile photo',
}));

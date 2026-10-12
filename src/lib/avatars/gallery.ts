// Profile-photo galleries (chat repo docs/pq/reqs/pq_avatars.proposed.md).
//
// A reader's gallery of a sender is computed per dialog from that dialog's
// messages; nothing is merged across dialogs. The owner's own gallery lives
// in a user_storage slot shared by the owner's devices, and is the source of
// what every dialog is sent.

import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import {
	isAvatarId, photoFromWire, photoToWire,
	type AvatarPart, type AvatarPhoto, type ContentPart,
} from '@/lib/pq/content';

/** A photo's longer side, at most (pq_avatars § The photo): the client resizes before sending. */
export const AVATAR_MAX_SIDE = 640;

/** What a photo may be picked from. */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export interface GalleryEntry {
	avatarId: string;
	photo: AvatarPhoto;
}

/** A dialog message as the reducer needs it: identity, author, liveness, content at its current revision. */
export interface GalleryMessage {
	messageId: string;
	senderHash: string;
	deleted?: boolean;
	parts: ContentPart[];
}

const byMessageId = (a: GalleryMessage, b: GalleryMessage) =>
	a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;

/**
 * The sender's gallery in one dialog, newest first; its first entry is the
 * current avatar. Walks the sender's live messages in message_id order (a
 * UUIDv7, signed with the row) and their parts in order: `avatar` puts its
 * id at the newest position with that photo, `avatar_removed` takes it out.
 * Messages of anyone else change nothing — a photo of someone else is a
 * picture, not their avatar — and a deleted message contributes nothing.
 */
export const galleryOf = (messages: GalleryMessage[], senderHash: string): GalleryEntry[] => {
	const order = new Map<string, AvatarPhoto>(); // insertion order: oldest → newest
	const own = messages.filter((m) => m.senderHash === senderHash && !m.deleted).sort(byMessageId);
	for (const message of own) {
		for (const part of message.parts) {
			if (part.kind === 'avatar') {
				order.delete(part.avatarId);
				order.set(part.avatarId, part.photo);
			} else if (part.kind === 'avatar_removed') {
				order.delete(part.avatarId);
			}
		}
	}
	return [...order].reverse().map(([avatarId, photo]) => ({ avatarId, photo }));
};

/** The whole gallery as one message, oldest first, so a reader applying it reproduces the order. */
export const snapshotParts = (gallery: GalleryEntry[]): AvatarPart[] =>
	[...gallery].reverse().map(({ avatarId, photo }) => ({ kind: 'avatar', avatarId, photo }));

/** A fresh photo id: 16 random bytes, lowercase hex. */
export const newAvatarId = (): string => bytesToHex(randomBytes(16));

// ---------- the owner's gallery slot ----------
//
// { avatars: { [avatar_id]: { photo, at } } }: `photo` is the wire element
// the dialogs are sent, `at` orders the gallery (newest = current). A patch
// edits entries by id — storageIntent's mergeJsonPatch merges an entry's
// fields and deletes one patched to null — so two devices changing the
// gallery at once keep both changes instead of the last list winning.

export const AVATARS_SLOT = 'avatars';

interface SlotEntry {
	photo?: unknown;
	at?: unknown;
}

const entriesOf = (record: unknown): [string, SlotEntry][] => {
	const avatars = (record as { avatars?: unknown } | null)?.avatars;
	if (!avatars || typeof avatars !== 'object') return [];
	return Object.entries(avatars as Record<string, SlotEntry | null>)
		.filter((e): e is [string, SlotEntry] => isAvatarId(e[0]) && !!e[1] && typeof e[1] === 'object');
};

/** The owner's gallery, newest first. An entry without a readable photo (set as main on one device while removed on another) is no photo. */
export const ownGalleryOf = (record: unknown): GalleryEntry[] =>
	entriesOf(record)
		.map(([avatarId, e]) => ({ avatarId, photo: photoFromWire(e.photo), at: Number(e.at) || 0 }))
		.filter((e): e is GalleryEntry & { at: number } => e.photo !== null)
		.sort((a, b) => b.at - a.at || (a.avatarId < b.avatarId ? 1 : -1))
		.map(({ avatarId, photo }) => ({ avatarId, photo }));

/** An `at` newer than every entry's, so the photo it marks is the newest even with a clock behind another device's. */
export const nextAt = (record: unknown, now = Date.now()): number =>
	entriesOf(record).reduce((max, [, e]) => Math.max(max, (Number(e.at) || 0) + 1), now);

export const addPatch = (avatarId: string, photo: AvatarPhoto, at: number) =>
	({ avatars: { [avatarId]: { photo: photoToWire(photo), at } } });

export const setMainPatch = (avatarId: string, at: number) => ({ avatars: { [avatarId]: { at } } });

export const removePatch = (avatarId: string) => ({ avatars: { [avatarId]: null } });

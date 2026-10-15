import { describe, it, expect } from 'vitest';
import {
	galleryOf, snapshotParts, newAvatarId,
	ownGalleryOf, nextAt, addPatch, setMainPatch, removePatch, type GalleryMessage,
} from '@/lib/avatars/gallery';
import { decodeContent, encodeContent, type AvatarPhoto, type ContentPart } from '@/lib/pq/content';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';

// pq_avatars § The gallery a reader sees.

const ME = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);
const id = (c: string) => c.repeat(32);
const photo = (n: number): AvatarPhoto => ({
	kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: `p${n}.jpg`, size: n,
	mimeType: 'image/jpeg', createdAt: 0, fileId: 'f_' + String(n).repeat(32).slice(0, 32), encSecretB64: 'c2VjcmV0',
});
const avatar = (c: string, n = 1): ContentPart => ({ kind: 'avatar', avatarId: id(c), photo: photo(n) });
const removed = (c: string): ContentPart => ({ kind: 'avatar_removed', avatarId: id(c) });
// UUIDv7-shaped ids whose order is the dialog order.
const mid = (n: number) => `dmsg_0190a3b2-${String(n).padStart(4, '0')}-7e5f-8a6b-7c8d9e0f1a2b`;
const msg = (n: number, parts: ContentPart[], over: Partial<GalleryMessage> = {}): GalleryMessage =>
	({ messageId: mid(n), senderHash: PEER, parts, ...over });
const ids = (messages: GalleryMessage[], sender = PEER) => galleryOf(messages, sender).map((e) => e.avatarId[0]);

describe('galleryOf', () => {
	it('is newest first, the newest being the current avatar', () => {
		expect(ids([msg(1, [avatar('a')]), msg(2, [avatar('b')]), msg(3, [avatar('c')])])).toEqual(['c', 'b', 'a']);
	});

	it('walks messages in message_id order, not in the order they arrived', () => {
		expect(ids([msg(3, [avatar('c')]), msg(1, [avatar('a')]), msg(2, [avatar('b')])])).toEqual(['c', 'b', 'a']);
	});

	it('set as main: sending an older id again moves it to the front, with the photo it carries now', () => {
		const g = galleryOf([msg(1, [avatar('a', 1)]), msg(2, [avatar('b')]), msg(3, [avatar('a', 7)])], PEER);
		expect(g.map((e) => e.avatarId[0])).toEqual(['a', 'b']);
		expect(g[0].photo).toEqual(photo(7));
	});

	it('removal takes an id out; a removal of what is not there changes nothing', () => {
		expect(ids([msg(1, [avatar('a')]), msg(2, [avatar('b')]), msg(3, [removed('b')]), msg(4, [removed('z')])])).toEqual(['a']);
	});

	it('an id removed and sent again is back, at the front', () => {
		expect(ids([msg(1, [avatar('a')]), msg(2, [avatar('b')]), msg(3, [removed('a')]), msg(4, [avatar('a')])])).toEqual(['a', 'b']);
	});

	it('a deleted message contributes nothing', () => {
		expect(ids([msg(1, [avatar('a')]), msg(2, [avatar('b')], { deleted: true })])).toEqual(['a']);
		expect(ids([msg(1, [avatar('a')]), msg(2, [removed('a')], { deleted: true })])).toEqual(['a']);
	});

	it('only the sender\'s own messages count', () => {
		const messages = [msg(1, [avatar('a')]), msg(2, [avatar('b')], { senderHash: ME }), msg(3, [removed('a')], { senderHash: ME })];
		expect(ids(messages)).toEqual(['a']);
		expect(ids(messages, ME)).toEqual(['b']);
	});

	it('applies a whole-gallery message part by part, oldest first, reproducing its order', () => {
		expect(ids([msg(1, [avatar('a'), avatar('b'), avatar('c')])])).toEqual(['c', 'b', 'a']);
		// over an existing one: the snapshot's order wins, extra ids stay older
		expect(ids([msg(1, [avatar('z'), avatar('a')]), msg(2, [avatar('a'), avatar('c')])])).toEqual(['c', 'a', 'z']);
	});

	it('ignores an avatar part whose photo is not an image element, and reads the rest of the message', () => {
		const parts = decodeContent(JSON.stringify([
			{ avatar: [id('a'), { video: [1, 1, '', 'v.mp4', 1, 'video/mp4', 0, 1, 'f_1', 'k'] }] },
			{ avatar: [id('b'), { image: [1, 1, '', 'b.jpg', 1, 'image/jpeg', 0, 'f_2', 'k'] }] },
		]));
		expect(ids([msg(1, parts)])).toEqual(['b']);
	});

	it('a gallery snapshot of it, applied in a fresh dialog, is the same gallery', () => {
		const history = [msg(1, [avatar('a')]), msg(2, [avatar('b')]), msg(3, [avatar('c')]), msg(4, [removed('b')]), msg(5, [avatar('a', 9)])];
		const gallery = galleryOf(history, PEER);
		const snapshot = snapshotParts(gallery);
		expect(snapshot.map((p) => p.avatarId[0])).toEqual(['c', 'a']); // oldest first
		const wire = encodeContent(snapshot);
		expect(galleryOf([msg(1, decodeContent(wire))], PEER)).toEqual(gallery);
	});
});

describe('newAvatarId', () => {
	it('is 16 random bytes as lowercase hex', () => {
		const a = newAvatarId();
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(newAvatarId()).not.toBe(a);
	});
});

// The owner's slot: { avatars: { [id]: { photo, at } } }, edited by id.
describe('the owner\'s gallery slot', () => {
	const apply = (record: Record<string, unknown> | null, patch: Record<string, unknown>) =>
		stripPatchDirectives(mergeJsonPatch(record, patch));
	const own = (record: unknown) => ownGalleryOf(record).map((e) => e.avatarId[0]);

	it('orders by `at`, newest first, and keeps the photo element', () => {
		let r = apply(null, addPatch(id('a'), photo(1), 10));
		r = apply(r, addPatch(id('b'), photo(2), 20));
		expect(own(r)).toEqual(['b', 'a']);
		expect(ownGalleryOf(r)[1].photo).toEqual(photo(1));
	});

	it('set as main moves a photo to the front and keeps its photo', () => {
		let r = apply(null, addPatch(id('a'), photo(1), 10));
		r = apply(r, addPatch(id('b'), photo(2), 20));
		r = apply(r, setMainPatch(id('a'), nextAt(r, 0)));
		expect(own(r)).toEqual(['a', 'b']);
		expect(ownGalleryOf(r)[0].photo).toEqual(photo(1));
	});

	it('removal deletes the entry', () => {
		let r = apply(null, addPatch(id('a'), photo(1), 10));
		r = apply(r, addPatch(id('b'), photo(2), 20));
		r = apply(r, removePatch(id('b')));
		expect(own(r)).toEqual(['a']);
		expect(Object.keys(r.avatars as object)).toEqual([id('a')]);
	});

	// Two devices editing at once: patches merge by id onto the newest base,
	// so neither change is lost to the other's list.
	it('two devices\' changes both survive', () => {
		const base = apply(null, addPatch(id('a'), photo(1), 10));
		const r = apply(apply(base, addPatch(id('b'), photo(2), 20)), addPatch(id('c'), photo(3), 30));
		expect(own(r)).toEqual(['c', 'b', 'a']);
	});

	it('an entry set as main on one device while removed on another is no photo', () => {
		const r = apply(apply(apply(null, addPatch(id('a'), photo(1), 10)), removePatch(id('a'))), setMainPatch(id('a'), 40));
		expect(own(r)).toEqual([]);
	});

	it('nextAt is past every entry even with a clock behind', () => {
		const r = apply(null, addPatch(id('a'), photo(1), 5000));
		expect(nextAt(r, 1000)).toBe(5001);
		expect(nextAt(r, 9000)).toBe(9000);
		expect(nextAt(null, 7)).toBe(7);
	});

	it('skips entries that are not a gallery photo', () => {
		const r = { avatars: { [id('a')]: { photo: { file: ['x', 1, 'a', 0, 'f', 'k'] }, at: 1 }, nope: { photo: {}, at: 2 } } };
		expect(own(r)).toEqual([]);
	});
});

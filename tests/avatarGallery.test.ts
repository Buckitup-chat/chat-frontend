import { describe, it, expect } from 'vitest';
import {
	newAvatarId, ownGalleryOf, nextAt, addPatch, setMainPatch, removePatch,
} from '@/lib/avatars/gallery';
import { type AvatarPhoto } from '@/lib/pq/content';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';

// pq_avatars § The owner's gallery slot.

const id = (c: string) => c.repeat(32);
const photo = (n: number): AvatarPhoto => ({
	kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: `p${n}.jpg`, size: n,
	mimeType: 'image/jpeg', createdAt: 0, fileId: 'f_' + String(n).repeat(32).slice(0, 32), encSecretB64: 'c2VjcmV0',
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

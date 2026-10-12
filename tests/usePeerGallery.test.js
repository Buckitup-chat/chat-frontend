// The reader side of pq_avatars, outside the page: the peer's gallery from
// the dialog's verified messages, and the copy of their current photo kept
// next to the contact (§ What a reader keeps) — written once per change,
// cleared only once the whole dialog has been read.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref, reactive, nextTick, effectScope } from 'vue';
import { setActivePinia, createPinia } from 'pinia';

const ME = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);
let user;
const writes = [];

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/avatars.store', () => ({
	useAvatarsStore: () => ({ photoUrl: () => '', contactAvatarSrc: () => '' }),
}));

const { usePeerGallery } = await import('@/composables/usePeerGallery');

const id = (c) => c.repeat(32);
const photo = (n) => ({ kind: 'inline_image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: `p${n}.jpg`, size: 1, mimeType: 'image/jpeg', createdAt: 0, dataB64: `A${n}` });
const msg = (n, parts, sender = PEER, over = {}) => ({
	id: `dmsg_${String(n).padStart(4, '0')}`, parts, _verify: 'verified',
	_raw: { sender_hash: sender }, ...over,
});
const avatar = (c, n = 1) => ({ kind: 'avatar', avatarId: id(c), photo: photo(n) });

const setup = (initial = []) => {
	const messages = ref(initial);
	const ready = ref(false);
	const scope = effectScope();
	const g = scope.run(() => usePeerGallery({ peerHash: ref(PEER), messages, ready }));
	return { messages, ready, g, stop: () => scope.stop() };
};
const flush = async () => { await nextTick(); await nextTick(); };

beforeEach(() => {
	setActivePinia(createPinia());
	writes.length = 0;
	user = reactive({
		currentUserHash: ME,
		contactsMap: { [PEER]: { user_hash: PEER } },
		async cacheContactAvatar(hash, avatar) {
			writes.push(avatar && { id: avatar.id, photo: avatar.photo });
			user.contactsMap[hash] = { ...user.contactsMap[hash], avatar };
			return true;
		},
	});
});

describe('usePeerGallery: the contact cache writer', () => {
	it('writes { id, photo } for the current photo, once, and again when it changes', async () => {
		const t = setup([msg(1, [avatar('a', 1)])]);
		await flush();
		expect(writes).toEqual([{ id: id('a'), photo: { inline_image: [1, 1, '', 'p1.jpg', 1, 'image/jpeg', 0, 'A1'] } }]);
		// a text message ticks the list; the current photo is the same
		t.messages.value = [...t.messages.value, msg(2, [{ kind: 'text', text: 'hi' }])];
		await flush();
		expect(writes).toHaveLength(1);
		t.messages.value = [...t.messages.value, msg(3, [avatar('b', 2)])];
		await flush();
		expect(writes.map((w) => w?.id)).toEqual([id('a'), id('b')]);
		t.stop();
	});

	it('counts only the peer\'s verified messages', async () => {
		const t = setup([msg(1, [avatar('a')], ME), msg(2, [avatar('b')], PEER, { _verify: 'waiting' })]);
		await flush();
		expect(writes).toEqual([]);
		expect(t.g.peerGallery.value).toEqual([]);
		t.stop();
	});

	it('clears a cached photo only once the dialog has been read and has none', async () => {
		user.contactsMap[PEER].avatar = { id: id('a'), photo: { inline_image: [1, 1, '', 'p1.jpg', 1, 'image/jpeg', 0, 'A1'] } };
		const t = setup([]);
		await flush();
		expect(writes).toEqual([]);
		t.ready.value = true;
		await flush();
		expect(writes).toEqual([null]);
		t.stop();
	});

	it('writes nothing for someone who is not a contact', async () => {
		delete user.contactsMap[PEER];
		const t = setup([msg(1, [avatar('a')])]);
		await flush();
		expect(writes).toEqual([]);
		t.stop();
	});

	it('a gallery removal is followed: the next photo becomes the cached one', async () => {
		const t = setup([msg(1, [avatar('a')]), msg(2, [avatar('b')])]);
		await flush();
		t.messages.value = [...t.messages.value, msg(3, [{ kind: 'avatar_removed', avatarId: id('b') }])];
		await flush();
		expect(writes.map((w) => w?.id)).toEqual([id('b'), id('a')]);
		t.stop();
	});
});

describe('usePeerGallery: the viewer', () => {
	it('opens the tapped sender\'s gallery at the tapped photo, newest first', async () => {
		const t = setup([msg(1, [avatar('a')]), msg(2, [avatar('b')]), msg(3, [avatar('c')], ME)]);
		t.g.openGallery({ senderHash: PEER, avatarId: id('a') });
		await flush();
		expect(t.g.viewer.frames.value.map((f) => f.key[0])).toEqual(['b', 'a']);
		expect(t.g.viewer.index.value).toBe(1);
		t.g.openGallery({ senderHash: ME });
		await flush();
		expect(t.g.viewer.frames.value.map((f) => f.key[0])).toEqual(['c']);
		expect(t.g.viewer.index.value).toBe(0);
		t.stop();
	});
});

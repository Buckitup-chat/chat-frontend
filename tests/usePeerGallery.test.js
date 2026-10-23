// @vitest-environment jsdom
// The reader side of pq_avatars, outside the page: the peer's gallery from
// their shared row, read on each approved trigger and never polled.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref, reactive, nextTick, effectScope } from 'vue';
import { setActivePinia, createPinia } from 'pinia';

const ME = 'u_' + 'a'.repeat(128);
const PEER = 'u_' + 'b'.repeat(128);
const OTHER_PEER = 'u_' + 'c'.repeat(128);
const UUID = '0b7e3a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b';
const KEY = 'K'.repeat(42) + 'w';
const NEWER_KEY = 'N'.repeat(42) + 'w';
let user;
const checks = [];

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/lib/avatars/peerGallery', () => ({
	isDisplayable: (state) => ['gallery', 'empty', 'deleted'].includes(state.state),
}));
vi.mock('@/store/avatars.store', () => ({
	useAvatarsStore: () => ({
		photoUrl: (photo) => `url:${photo.fileId}`,
		peerAvatarSrc: (peer, { fallback } = {}) => (fallback ? `cached:${fallback.id}` : ''),
		ownGallery: user.ownGallery,
		checkPeerGallery: (peer, opts) => new Promise((resolve) => { checks.push({ peer, ...opts, resolve }); }),
	}),
}));

const { usePeerGallery, INITIAL_CHECK_DELAY_MS } = await import('@/composables/usePeerGallery');

const id = (c) => c.repeat(32);
const photo = (n) => ({ kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: `p${n}.jpg`, size: 1, mimeType: 'image/jpeg', createdAt: 0, fileId: `f_${n}`, encSecretB64: 'k' });
const entry = (c, n) => ({ avatarId: id(c), photo: photo(n) });
const mid = (n) => `dmsg_0190a3b2-${String(n).padStart(4, '0')}-7e5f-8a6b-7c8d9e0f1a2b`;
const grantMsg = (n, key = KEY, over = {}) => ({
	id: mid(n), parts: [{ kind: 'avatar_gallery_access', version: 1, galleryUuid: UUID, galleryKeyB64: key }],
	_verify: 'verified', _raw: { sender_hash: PEER, message_id: mid(n) }, ...over,
});
const grantOf = (key = KEY) => ({ ownerHash: PEER, galleryUuid: UUID, galleryKeyB64: key });
const gallery = (...entries) => ({ state: 'gallery', entries });
const answer = (check, state, grant = grantOf()) => check.resolve({ grant, state });

const setup = (initial = [], peer = PEER) => {
	const messages = ref(initial);
	const peerHash = ref(peer);
	const scope = effectScope();
	const g = scope.run(() => usePeerGallery({ peerHash, messages }));
	return { messages, peerHash, g, stop: () => scope.stop() };
};
const flush = async () => { for (let i = 0; i < 4; i++) await nextTick(); await new Promise((r) => setTimeout(r, 0)); };
const opened = async () => { await new Promise((r) => setTimeout(r, INITIAL_CHECK_DELAY_MS + 10)); await flush(); };
const setVisibility = (state) => Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
const tabReturns = () => { setVisibility('visible'); document.dispatchEvent(new Event('visibilitychange')); };

beforeEach(() => {
	setActivePinia(createPinia());
	checks.length = 0;
	setVisibility('visible');
	user = reactive({
		currentUserHash: ME,
		contactsMap: { [PEER]: { user_hash: PEER } },
		ownGallery: [entry('m', 9)],
	});
});

describe('usePeerGallery: when the gallery is read', () => {
	it('once, shortly after the chat opens, with the grant in the peer\'s verified messages, past any cooldown', async () => {
		const t = setup([grantMsg(1)]);
		await opened();
		expect(checks).toHaveLength(1);
		expect(checks[0]).toMatchObject({ peer: PEER, force: true, grant: { ...grantOf(), messageId: mid(1) } });
		t.stop();
	});

	it('the tab becoming visible or the connection returning during the delay leaves it to the scheduled read', async () => {
		const t = setup([grantMsg(1)]);
		await flush();
		tabReturns();
		window.dispatchEvent(new Event('online'));
		await flush();
		expect(checks).toEqual([]);
		await opened();
		expect(checks.map((c) => [c.force, c.fresh])).toEqual([[true, false]]);
		t.stop();
	});

	it('switching chats quickly reads only the peer left open; a chat closed before the delay reads nothing', async () => {
		const t = setup([grantMsg(1)]);
		await flush();
		t.peerHash.value = OTHER_PEER;
		await flush();
		expect(checks).toEqual([]);
		await opened();
		expect(checks.map((c) => c.peer)).toEqual([OTHER_PEER]);
		t.stop();
		checks.length = 0;
		const closed = setup([grantMsg(1)]);
		await flush();
		closed.stop();
		await opened();
		expect(checks).toEqual([]);
	});

	it('a grant appearing while the chat is open is read at once; the grant already read is not read again', async () => {
		const t = setup([]);
		await opened();
		answer(checks[0], gallery(entry('a', 1)));
		await flush();
		t.messages.value = [grantMsg(1)];
		await flush();
		expect(checks).toHaveLength(1);
		t.messages.value = [grantMsg(1), grantMsg(2, NEWER_KEY)];
		await flush();
		expect(checks).toHaveLength(2);
		expect(checks[1]).toMatchObject({ force: true, grant: { galleryKeyB64: NEWER_KEY } });
		t.stop();
	});

	it('the tab becoming visible and the connection coming back recheck this peer, under the store\'s cooldown', async () => {
		const t = setup([grantMsg(1)]);
		await opened();
		setVisibility('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		tabReturns();
		window.dispatchEvent(new Event('online'));
		await flush();
		expect(checks.map((c) => [c.peer, c.force])).toEqual([[PEER, true], [PEER, false], [PEER, false]]);
		t.stop();
	});

	it('nothing else reads: no timer, and no event once the chat turned to another peer or closed', async () => {
		vi.useFakeTimers();
		try {
			const t = setup([grantMsg(1)]);
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(checks).toHaveLength(1);
			t.peerHash.value = OTHER_PEER;
			await vi.advanceTimersByTimeAsync(INITIAL_CHECK_DELAY_MS);
			expect(checks.map((c) => [c.peer, c.force])).toEqual([[PEER, true], [OTHER_PEER, true]]);
			tabReturns();
			expect(checks.map((c) => c.peer)).toEqual([PEER, OTHER_PEER, OTHER_PEER]);
			t.stop();
			tabReturns();
			window.dispatchEvent(new Event('online'));
			expect(checks).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('usePeerGallery: the picture', () => {
	it('shows the cached photo until the row answers, then the row\'s current one', async () => {
		user.contactsMap[PEER].avatar = { id: id('z') };
		const t = setup([grantMsg(1)]);
		await flush();
		expect(t.g.avatarUrl.value).toBe(`cached:${id('z')}`);
		await opened();
		expect(t.g.avatarUrl.value).toBe(`cached:${id('z')}`);
		answer(checks[0], gallery(entry('b', 2), entry('a', 1)));
		await flush();
		expect(t.g.avatarUrl.value).toBe('url:f_2');
		t.stop();
	});

	it('a read that says nothing verified keeps the gallery shown; a verified empty gallery shows none', async () => {
		const t = setup([grantMsg(1)]);
		await opened();
		answer(checks[0], gallery(entry('a', 1)));
		await flush();
		tabReturns();
		await flush();
		answer(checks[1], { state: 'unavailable', reason: 'read_failed' });
		await flush();
		expect(t.g.avatarUrl.value).toBe('url:f_1');
		window.dispatchEvent(new Event('online'));
		await flush();
		answer(checks[2], { state: 'empty' });
		await flush();
		expect(t.g.avatarUrl.value).toBe('');
		expect(t.g.peerGallery.value).toEqual([]);
		t.stop();
	});
});

describe('usePeerGallery: the viewer', () => {
	it('a tap on the peer\'s picture reads their row at once, then opens on the verified gallery at the tapped photo', async () => {
		const t = setup([grantMsg(1)]);
		await opened();
		answer(checks[0], gallery(entry('a', 1)));
		await flush();
		const opening = t.g.openGallery({ senderHash: PEER, avatarId: id('a') });
		expect(checks[1]).toMatchObject({ peer: PEER, force: true, fresh: true });
		expect(t.g.viewer.index.value).toBeNull();
		answer(checks[1], gallery(entry('b', 2), entry('a', 1)));
		await opening;
		expect(t.g.viewer.frames.value.map((f) => f.key[0])).toEqual(['b', 'a']);
		expect(t.g.viewer.index.value).toBe(1);
		t.stop();
	});

	it('a tap whose read ends after the chat turned to another peer, or another account signed in, opens nothing', async () => {
		const t = setup([grantMsg(1)]);
		await opened();
		const opening = t.g.openGallery({ senderHash: PEER });
		t.peerHash.value = OTHER_PEER;
		answer(checks[1], gallery(entry('b', 2)));
		await opening;
		expect(t.g.viewer.index.value).toBeNull();
		t.peerHash.value = PEER;
		await opened();
		const again = t.g.openGallery({ senderHash: PEER });
		user.currentUserHash = 'u_' + 'd'.repeat(128);
		answer(checks.at(-1), gallery(entry('b', 2)));
		await again;
		expect(t.g.viewer.index.value).toBeNull();
		t.stop();
	});
});

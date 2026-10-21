// The avatars store wires the gallery to its slot and its dialogs
// (pq_avatars): a change is recorded in the slot, then sent to the
// dialogs this account has written to; the first message into any peer's
// dialog brings the current photo. Fakes keep the contracts: the slot merges
// patches like storageIntent, a sent message is readable in its dialog.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';

const ME = 'u_' + 'a'.repeat(128);
const OTHER_ACCOUNT = 'u_' + 'e'.repeat(128);
const WRITTEN = 'u_' + 'b'.repeat(128); // a contact this account has sent to
const SILENT = 'u_' + 'c'.repeat(128); // a contact it never wrote to
const STRANGER = 'u_' + 'd'.repeat(128);

let user;
let dialogs;
let slot;
let slotUnreadable;

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => dialogs }));
vi.mock('@/lib/data/outboundDialogs', () => ({ peersWeWrote: async () => [...dialogs.messages.keys()] }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			loadSlotJson: async (_name, { strict } = {}) => {
				if (slotUnreadable && strict) throw new Error('The avatars slot on the server cannot be read');
				return slotUnreadable ? null : slot;
			},
			patchSlotJson: async (_name, patch) => {
				slot = stripPatchDirectives(mergeJsonPatch(slot, patch));
				return slot;
			},
		}),
	},
}));

// Canvas work is the browser's; here a resize just names what it was given.
vi.mock('@/utils/imageResize', () => ({
	resizeImageUrl: async (src, side) => ({ dataUrl: `resized(${side}):${src}`, blobFile: null }),
}));

const { useAvatarsStore, PHOTO_RETRY_AFTER_MS, CONTACT_PHOTO_REREAD_MS } = await import('@/store/avatars.store');
const { useMemoryAvatarStore } = await import('./helpers/avatarLocalStore');
const { getThumb, loadOwed, updateOwed } = await import('@/lib/avatars/localStore');

const fakeDialogs = () => {
	const messages = new Map(); // peer -> [{ messageId, senderHash, parts }]
	let hook = null;
	let seq = 0;
	return {
		messages,
		sent: [],
		uploads: 0,
		getDialogHash: (peer) => `di_${peer}`,
		onOwnSend: (fn) => { hook = fn; },
		/** The hook as dialogs.store calls it, for a message stored by `owner`. */
		stored: (peer, parts, owner) => hook?.(peer, parts, owner),
		async uploadAttachment({ name, mimeType, bytes }) {
			this.uploads++;
			return {
				kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name, size: bytes.length, mimeType,
				createdAt: 0, fileId: `f_${String(this.uploads).padStart(32, '0')}`, encSecretB64: 'k',
			};
		},
		async sendMessage(peer, parts) {
			this.sent.push({ peer, parts });
			const list = messages.get(peer) ?? [];
			list.push({ messageId: `dmsg_${String(++seq).padStart(4, '0')}`, senderHash: user.currentUserHash, parts });
			messages.set(peer, list);
			hook?.(peer, parts, user.currentUserHash);
		},
		probes: 0,
		async ownDialogCarriesAvatar(peer, { requireOwnKey } = {}) {
			this.probes++;
			const ownKey = messages.has(peer);
			if (requireOwnKey && !ownKey) return { ownKey, carries: null };
			const own = (messages.get(peer) ?? []).filter((m) => m.senderHash === user.currentUserHash);
			return { ownKey, carries: own.some((m) => m.parts.some((x) => x.kind === 'avatar')) };
		},
		peerReads: new Map(),
		readCounts: new Map(),
		async readPeerParts(peer, kinds, opts) {
			if (kinds.join(',') !== 'avatar,avatar_removed' || opts?.requireComplete !== true) throw new Error('Unexpected peer photo read');
			this.readCounts.set(peer, (this.readCounts.get(peer) ?? 0) + 1);
			const messages = this.peerReads.has(peer) ? this.peerReads.get(peer) : [];
			return messages === null ? null : { messages };
		},
		fetches: [],
		fetchResult: async () => new Uint8Array([1, 2, 3]),
		async fetchFile(part) {
			this.fetches.push(part);
			return this.fetchResult(part);
		},
	};
};

const photoBlob = () => new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' });
const settle = () => new Promise((r) => setTimeout(r, 0));
const kindsSentTo = (peer) => dialogs.sent.filter((s) => s.peer === peer).map((s) => s.parts.map((p) => p.kind).join('+'));

beforeEach(() => {
	useMemoryAvatarStore();
	slotUnreadable = false;
	const storage = new Map();
	globalThis.localStorage = {
		getItem: (k) => storage.get(k) ?? null,
		setItem: (k, v) => storage.set(k, String(v)),
		removeItem: (k) => storage.delete(k),
	};
	slot = null;
	user = reactive({
		currentUserHash: ME,
		currentUser: { user_hash: ME },
		contactsMap: { [WRITTEN]: { user_hash: WRITTEN }, [SILENT]: { user_hash: SILENT } },
		async setOwnAvatarImage({ avatarId, dataUrl }) { Object.assign(user.currentUser, { avatarId, avatar: dataUrl }); },
	});
	dialogs = fakeDialogs();
	dialogs.messages.set(WRITTEN, [{ messageId: 'dmsg_0000', senderHash: ME, parts: [{ kind: 'text', text: 'hi' }] }]);
	dialogs.messages.set(STRANGER, [{ messageId: 'dmsg_0000', senderHash: ME, parts: [{ kind: 'text', text: 'hi' }] }]);
	setActivePinia(createPinia());
});

describe('avatars store', () => {
	it('adds a photo: one upload, recorded in the slot, the own picture follows, sent to written dialogs', async () => {
		const store = useAvatarsStore();
		const result = await store.addPhoto(photoBlob());
		expect(dialogs.uploads).toBe(1);
		expect(store.ownGallery).toHaveLength(1);
		expect(user.currentUser.avatarId).toBe(store.ownGallery[0].avatarId);
		// the own picture is the uploaded bytes, downscaled — nothing downloaded back
		expect(user.currentUser.avatar).toMatch(/^resized\(128\):blob:/);
		expect(dialogs.fetches).toEqual([]);
		expect(result.sent).toEqual([WRITTEN, STRANGER]);
		expect(kindsSentTo(SILENT)).toEqual([]);
		expect(kindsSentTo(STRANGER)).toEqual(['avatar']);
	});

	it('a second photo goes out as the change alone; every dialog references the same file', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		await store.addPhoto(photoBlob());
		expect(kindsSentTo(WRITTEN)).toEqual(['avatar', 'avatar']);
		expect(dialogs.uploads).toBe(2);
	});

	it('set as main and remove go out as their one part, and the slot order follows', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		await store.addPhoto(photoBlob());
		const [newest, oldest] = store.ownGallery.map((e) => e.avatarId);
		await store.setMain(oldest);
		expect(store.ownGallery.map((e) => e.avatarId)).toEqual([oldest, newest]);
		expect(user.currentUser.avatarId).toBe(oldest);
		await store.removePhoto(newest);
		expect(store.ownGallery.map((e) => e.avatarId)).toEqual([oldest]);
		expect(dialogs.sent.filter((s) => s.peer === WRITTEN).slice(-2).map((s) => s.parts)).toEqual([
			[{ kind: 'avatar', avatarId: oldest, photo: expect.objectContaining({ kind: 'image' }) }],
			[{ kind: 'avatar', avatarId: oldest, photo: expect.objectContaining({ kind: 'image' }) }, { kind: 'avatar_removed', avatarId: newest }],
		]);
	});

	it('the first message brings only the current photo, including outside contacts', async () => {
		dialogs.messages.delete(STRANGER);
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		await store.addPhoto(photoBlob());
		await dialogs.sendMessage(SILENT, [{ kind: 'text', text: 'hello' }]);
		await vi.waitFor(() => expect(kindsSentTo(SILENT)).toContain('avatar'));
		await dialogs.sendMessage(SILENT, [{ kind: 'text', text: 'again' }]);
		await settle();
		expect(kindsSentTo(SILENT).filter((kind) => kind === 'avatar')).toEqual(['avatar']);
		await dialogs.sendMessage(STRANGER, [{ kind: 'text', text: 'hello' }]);
		await vi.waitFor(() => expect(kindsSentTo(STRANGER)).toEqual(['text', 'avatar']));
	});

	it('a delivery still running when the account changes sends nothing from the next one', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		dialogs.sent.length = 0;
		const send = dialogs.sendMessage.bind(dialogs);
		const probe = dialogs.ownDialogCarriesAvatar.bind(dialogs);
		dialogs.ownDialogCarriesAvatar = async (peer, opts) => {
			user.currentUserHash = OTHER_ACCOUNT;
			return probe(peer, opts);
		};
		dialogs.sendMessage = send;
		const result = await store.setMain(store.ownGallery[0].avatarId);
		expect(dialogs.sent).toEqual([]);
		expect(result.sent).toEqual([]);
		expect(String(result.failed[0]?.error?.message)).toMatch(/account changed/);
	});

	it('with no photo, a first message reads no dialog', async () => {
		useAvatarsStore();
		await dialogs.sendMessage(SILENT, [{ kind: 'text', text: 'hello' }]);
		await settle();
		expect(dialogs.probes).toBe(0);
		expect(kindsSentTo(SILENT)).toEqual(['text']);
	});

	it('the own-send hook acts only for the account signed in now', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		dialogs.sent.length = 0;
		dialogs.probes = 0;
		dialogs.stored(SILENT, [{ kind: 'text', text: 'from a session that ended' }], OTHER_ACCOUNT);
		await settle();
		expect(dialogs.probes).toBe(0);
		expect(dialogs.sent).toEqual([]);
	});

	it('what was owed goes out after sign-in without waiting for contacts', async () => {
		await updateOwed(ME, (o) => { o[SILENT] = { first: true }; });
		slot = { avatars: { ['a'.repeat(32)]: { photo: { image: [1, 1, '', 'a.jpg', 1, 'image/jpeg', 0, 'f_1', 'k'] }, at: 1 } } };
		const contacts = user.contactsMap;
		user.contactsMap = {};
		useAvatarsStore();
		await settle();
		await vi.waitFor(() => expect(kindsSentTo(SILENT)).toEqual(['avatar']));
		user.contactsMap = contacts;
		await vi.waitFor(async () => expect(await loadOwed(ME)).toEqual({}));
	});
});

describe("contacts' photos, read in the background", () => {
	const photoOf = (n) => ({ kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: `p${n}.jpg`, size: 3, mimeType: 'image/jpeg', createdAt: 0, fileId: `f_${n}`, encSecretB64: 'k' });
	const avatarMsg = (n, c) => ({ messageId: `dmsg_${n}`, senderHash: WRITTEN, parts: [{ kind: 'avatar', avatarId: c.repeat(32), photo: photoOf(n) }] });
	const cached = (peer) => user.contactsMap[peer]?.avatar?.id;
	beforeEach(() => {
		user.cacheContactAvatar = async (hash, avatar) => {
			user.contactsMap[hash] = { ...user.contactsMap[hash], avatar };
			return true;
		};
	});

	it('after sign-in, each contact gets the current photo of their dialog, without the chat being opened', async () => {
		dialogs.peerReads.set(WRITTEN, [avatarMsg(1, 'a'), avatarMsg(2, 'b')]);
		useAvatarsStore();
		await vi.waitFor(() => expect(cached(WRITTEN)).toBe('b'.repeat(32)));
		expect(user.contactsMap[WRITTEN].avatar.photo).toEqual({ image: [1, 1, '', 'p2.jpg', 3, 'image/jpeg', 0, 'f_2', 'k'] });
		expect(cached(SILENT)).toBeUndefined();
	});

	it('a dialog not read whole changes nothing: neither a clear nor an older photo', async () => {
		user.contactsMap[WRITTEN].avatar = { id: 'b'.repeat(32), photo: { image: [1, 1, '', 'p2.jpg', 3, 'image/jpeg', 0, 'f_2', 'k'] } };
		dialogs.peerReads.set(WRITTEN, null);
		useAvatarsStore();
		await vi.waitFor(() => expect(dialogs.readCounts.get(WRITTEN)).toBe(1));
		await settle();
		expect(cached(WRITTEN)).toBe('b'.repeat(32));
	});

	it('a dialog read whole with no photo clears the cached one', async () => {
		user.contactsMap[WRITTEN].avatar = { id: 'b'.repeat(32), photo: { image: [1, 1, '', 'p2.jpg', 3, 'image/jpeg', 0, 'f_2', 'k'] } };
		useAvatarsStore();
		await vi.waitFor(() => expect(user.contactsMap[WRITTEN].avatar).toBeNull());
	});

	it('a dialog is not read again before its re-read time, and is after it', async () => {
		const store = useAvatarsStore();
		await vi.waitFor(() => expect(dialogs.readCounts.get(WRITTEN)).toBe(1));
		await store.refreshContactAvatars();
		expect(dialogs.readCounts.get(WRITTEN)).toBe(1);
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + CONTACT_PHOTO_REREAD_MS + 1);
		try {
			dialogs.peerReads.set(WRITTEN, [avatarMsg(3, 'c')]);
			await store.refreshContactAvatars([WRITTEN]);
		} finally {
			vi.restoreAllMocks();
		}
		expect(dialogs.readCounts.get(WRITTEN)).toBe(2);
		expect(cached(WRITTEN)).toBe('c'.repeat(32));
	});
});

describe('the own picture', () => {
	it('a picture kept from before the gallery is cleared when the account has no gallery', async () => {
		user.currentUser = { user_hash: ME, avatar: 'data:image/jpeg;base64,LEGACY', avatarId: null };
		useAvatarsStore();
		await vi.waitFor(() => expect(user.currentUser.avatar).toBeNull());
	});

	it('is kept when the gallery slot is there and cannot be read', async () => {
		slotUnreadable = true;
		user.currentUser = { user_hash: ME, avatar: 'data:image/jpeg;base64,KEPT', avatarId: 'f'.repeat(32) };
		useAvatarsStore();
		await settle();
		await settle();
		expect(user.currentUser.avatar).toBe('data:image/jpeg;base64,KEPT');
	});
});

describe('photos as the screens draw them', () => {
	const PEER = WRITTEN;
	const photoOf = {
		kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: 'p.jpg', size: 3, mimeType: 'image/jpeg',
		createdAt: 0, fileId: 'f_' + '9'.repeat(32), encSecretB64: 'k',
	};

	it('fetches a photo as its sender\'s file, once, and serves it from the media cache', async () => {
		const store = useAvatarsStore();
		const photo = photoOf;
		expect(store.photoUrl(photo, PEER)).toBe('');
		const url = await store.loadPhoto(photo, PEER);
		expect(url).toMatch(/^blob:/);
		expect(store.photoUrl(photo, PEER)).toBe(url);
		expect(dialogs.fetches).toEqual([{ ...photo, uploaderHash: PEER }]);
	});

	it('a photo that failed is not fetched again before its retry-after, and is after it', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const store = useAvatarsStore();
			// another file than the test above's: the media cache outlives a test
			const photo = { ...photoOf, fileId: 'f_' + '8'.repeat(32) };
			dialogs.fetchResult = async () => { throw new Error('chunk 0 unavailable'); };
			await expect(store.loadPhoto(photo, PEER)).rejects.toThrow('chunk 0 unavailable');
			// every redraw asks again; none of them reaches the network
			for (let i = 0; i < 5; i++) store.photoUrl(photo, PEER);
			await expect(store.loadPhoto(photo, PEER)).rejects.toThrow(/asked for again later/);
			expect(dialogs.fetches).toHaveLength(1);
			vi.setSystemTime(Date.now() + PHOTO_RETRY_AFTER_MS + 1);
			dialogs.fetchResult = async () => new Uint8Array([1]);
			await expect(store.loadPhoto(photo, PEER)).resolves.toMatch(/^blob:/);
			expect(dialogs.fetches).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a contact\'s thumbnail is made once and kept sealed for this account; forgetting it removes it', async () => {
		const store = useAvatarsStore();
		const cached = { id: 'c'.repeat(32), photo: { image: [1, 1, '', 'c.jpg', 1, 'image/jpeg', 0, 'f_' + '7'.repeat(32), 'k'] } };
		store.contactAvatarSrc(cached, PEER);
		await vi.waitFor(async () => expect((await getThumb(ME, PEER))?.avatarId).toBe('c'.repeat(32)));
		await vi.waitFor(() => expect(store.contactAvatarSrc(cached, PEER)).toMatch(/^resized\(96\):blob:/));
		store.forgetContactThumb(PEER);
		await vi.waitFor(async () => expect(await getThumb(ME, PEER)).toBeNull());
	});
});

// The avatars store wires the gallery to its slot and its dialogs
// (pq_avatars): a change is recorded in the slot, then sent to the
// contacts this account has written to; the first message into a contact's
// dialog brings the whole gallery. Fakes keep the contracts: the slot merges
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

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => dialogs }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			loadSlotJson: async () => slot,
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

const { useAvatarsStore, PHOTO_RETRY_AFTER_MS } = await import('@/store/avatars.store');

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
			hook?.(peer, parts);
		},
		probes: 0,
		async ownDialogCarriesAvatar(peer, { requireOwnKey } = {}) {
			this.probes++;
			const ownKey = messages.has(peer);
			if (requireOwnKey && !ownKey) return { ownKey, carries: null };
			const own = (messages.get(peer) ?? []).filter((m) => m.senderHash === user.currentUserHash);
			return { ownKey, carries: own.some((m) => m.parts.some((x) => x.kind === 'avatar')) };
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
	it('adds a photo: one upload, recorded in the slot, the own picture follows, sent to the contacts written to', async () => {
		const store = useAvatarsStore();
		const result = await store.addPhoto(photoBlob());
		expect(dialogs.uploads).toBe(1);
		expect(store.ownGallery).toHaveLength(1);
		expect(user.currentUser.avatarId).toBe(store.ownGallery[0].avatarId);
		// the own picture is the uploaded bytes, downscaled — nothing downloaded back
		expect(user.currentUser.avatar).toMatch(/^resized\(128\):blob:/);
		expect(dialogs.fetches).toEqual([]);
		expect(result.sent).toEqual([WRITTEN]);
		expect(kindsSentTo(SILENT)).toEqual([]);
		expect(kindsSentTo(STRANGER)).toEqual([]);
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
		expect(dialogs.sent.slice(-2).map((s) => s.parts)).toEqual([
			[{ kind: 'avatar', avatarId: oldest, photo: expect.objectContaining({ kind: 'image' }) }],
			[{ kind: 'avatar_removed', avatarId: newest }],
		]);
	});

	it('the first message into a contact\'s dialog brings the gallery, once; not into a stranger\'s', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		await store.addPhoto(photoBlob());
		await dialogs.sendMessage(SILENT, [{ kind: 'text', text: 'hello' }]);
		await settle();
		await dialogs.sendMessage(SILENT, [{ kind: 'text', text: 'again' }]);
		await settle();
		expect(kindsSentTo(SILENT)).toEqual(['text', 'avatar+avatar', 'text']);
		await dialogs.sendMessage(STRANGER, [{ kind: 'text', text: 'hello' }]);
		await settle();
		expect(kindsSentTo(STRANGER)).toEqual(['text']);
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
});

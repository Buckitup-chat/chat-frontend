// The avatars store wires the gallery to its slot and its shared row
// (pq_avatars): a change is recorded in the slot, then published to the
// shared row; each dialog this account has written to gets its grant once.
// Fakes keep the contracts: the slot merges
// patches like storageIntent, a sent message is readable in its dialog.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';
import { mergeJsonPatch, stripPatchDirectives } from '@/lib/data/storageIntent';
import { legacyToSharedGallery } from '@/lib/avatars/sharedGalleryPublish';
import { StorageNotOnServerError } from '@/lib/data/userStorage';

const ME = 'u_' + 'a'.repeat(128);
const OTHER_ACCOUNT = 'u_' + 'e'.repeat(128);
const WRITTEN = 'u_' + 'b'.repeat(128); // a contact this account has sent to
const SILENT = 'u_' + 'c'.repeat(128); // a contact it never wrote to
const STRANGER = 'u_' + 'd'.repeat(128);
const MAPPING = { galleryUuid: '0b7e3a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b', galleryKeyB64: 'K'.repeat(42) + 'w', generation: 1 };
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));

let user;
let dialogs;
let slot;
let serverSlot;
let slotUnreadable;
let sharedRow;
let publishing;
let initialAnswer;
let published;
let slotOffline;
let acceptAtOnce;
let heldSlotWrites;
let peerRows;
let peerRowReads;

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => user }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => dialogs }));
vi.mock('@/lib/data/outboundDialogs', () => ({ peersWeWrote: async () => [...dialogs.messages.keys()] }));
vi.mock('@/lib/avatars/peerGallery', () => ({
	readPeerGallery: async (reader, grant) => {
		peerRowReads.push({ reader, grant });
		return peerRows.get(grant.ownerHash) ?? { state: 'missing' };
	},
	isDisplayable: (state) => ['gallery', 'empty', 'deleted'].includes(state.state),
}));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			loadSlotJson: async (_name, { strict } = {}) => {
				if (slotUnreadable && strict) throw new Error('The avatars slot on the server cannot be read');
				return slotUnreadable ? null : slot;
			},
			patchSlotJson: async (_name, patch) => {
				slot = stripPatchDirectives(mergeJsonPatch(slot, patch));
				if (slotOffline) {
					let settle;
					const outcome = new Promise((r) => { settle = r; });
					const held = { patch, outcome, settle };
					heldSlotWrites.push(held);
					if (acceptAtOnce) deliverHeld(held, 'accepted');
					throw new StorageNotOnServerError('queued', undefined, outcome);
				}
				serverSlot = stripPatchDirectives(mergeJsonPatch(serverSlot, patch));
				return slot;
			},
			loadAcceptedSlotJson: async () => ({ state: 'found', record: serverSlot }),
			publishSharedGalleryRecord: async (record) => {
				if (publishing !== 'published') return { state: 'pending', reason: publishing };
				sharedRow = record;
				published.push(record);
				return { state: 'published', mapping: MAPPING };
			},
			publishInitialSharedGallery: async () => {
				if (initialAnswer) return initialAnswer;
				const converted = legacyToSharedGallery(serverSlot);
				if (converted.state === 'needs-conversion') return converted;
				if (converted.state !== 'ok') return { state: 'refused', reason: converted.reason };
				if (sharedRow && JSON.stringify(sharedRow) === JSON.stringify(converted.record)) return { state: 'adopted', mapping: MAPPING };
				sharedRow = converted.record;
				published.push(converted.record);
				return { state: 'published', mapping: MAPPING };
			},
		}),
	},
}));

// Canvas work is the browser's; here a resize just names what it was given.
vi.mock('@/utils/imageResize', () => ({
	resizeImageUrl: async (src, side) => ({ dataUrl: `resized(${side}):${src}`, blobFile: null }),
}));

const { useAvatarsStore, PHOTO_RETRY_AFTER_MS, PEER_RECHECK_MS } = await import('@/store/avatars.store');
const { useMemoryAvatarStore } = await import('./helpers/avatarLocalStore');
const { getThumb, putThumb, loadGranted, getPeerAvatar, putPeerAvatar } = await import('@/lib/avatars/localStore');

const fakeDialogs = () => {
	const messages = new Map(); // peer -> [{ messageId, senderHash, parts }]
	let hook = null;
	let seq = 0;
	return {
		messages,
		sent: [],
		uploads: 0,
		onOwnSend: (fn) => { hook = fn; },
		/** The hook as dialogs.store calls it, for a message stored by `owner`. */
		stored: (peer, parts, owner) => hook?.(peer, parts, owner),
		async uploadAttachment({ name, mimeType, bytes }) {
			this.uploads++;
			return {
				kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name, size: bytes.length, mimeType,
				createdAt: 0, fileId: `f_${String(this.uploads).padStart(32, '0')}`, encSecretB64: SECRET,
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
		unconfirmed: new Set(),
		refuse(peer) {
			messages.set(peer, (messages.get(peer) ?? []).filter((m) => !m.parts.some((p) => p.kind === 'avatar_gallery_access')));
		},
		async ownDialogCarriesGrant(peer, grant) {
			this.probes++;
			const own = (messages.get(peer) ?? []).filter((m) => m.senderHash === user.currentUserHash);
			const carries = own.some((m) => m.parts.some((p) => p.kind === 'avatar_gallery_access' && p.galleryUuid === grant.galleryUuid));
			return { carries, confirmed: carries && !this.unconfirmed.has(peer) };
		},
		peerGrants: new Map(),
		grantReads: new Map(),
		async readPeerParts(peer, kinds) {
			if (kinds.join(',') !== 'avatar_gallery_access') throw new Error('Unexpected peer read');
			this.grantReads.set(peer, (this.grantReads.get(peer) ?? 0) + 1);
			const found = this.peerGrants.get(peer);
			return found === null ? null : { messages: found ? [found] : [] };
		},
		fetches: [],
		fetchResult: async () => new Uint8Array([1, 2, 3]),
		async fetchFile(part) {
			this.fetches.push(part);
			return this.fetchResult(part);
		},
	};
};

const deliverHeld = (held, kind) => {
	if (kind === 'accepted') serverSlot = stripPatchDirectives(mergeJsonPatch(serverSlot, held.patch));
	held.settle(kind === 'accepted' ? { kind } : { kind, error: 'refused' });
};

const photoBlob = () => new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' });
const settle = () => new Promise((r) => setTimeout(r, 0));
const kindsSentTo = (peer) => dialogs.sent.filter((s) => s.peer === peer).map((s) => s.parts.map((p) => p.kind).join('+'));
const allKindsSent = () => [...new Set(dialogs.sent.flatMap((s) => s.parts.map((p) => p.kind)))];
const sharedIds = () => Object.entries(sharedRow?.avatars ?? {}).sort((a, b) => b[1].at - a[1].at).map(([id]) => id);

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
	serverSlot = null;
	slotOffline = false;
	acceptAtOnce = false;
	heldSlotWrites = [];
	sharedRow = null;
	publishing = 'published';
	initialAnswer = null;
	published = [];
	peerRows = new Map();
	peerRowReads = [];
	user = reactive({
		currentUserHash: ME,
		currentUser: { user_hash: ME },
		contactsMap: { [WRITTEN]: { user_hash: WRITTEN }, [SILENT]: { user_hash: SILENT } },
		async setOwnAvatarImage({ avatarId, dataUrl }) { Object.assign(user.currentUser, { avatarId, avatar: dataUrl }); },
		async cacheContactAvatar(hash, avatar) {
			user.contactsMap[hash] = { ...user.contactsMap[hash], avatar };
			return true;
		},
	});
	dialogs = fakeDialogs();
	dialogs.messages.set(WRITTEN, [{ messageId: 'dmsg_0000', senderHash: ME, parts: [{ kind: 'text', text: 'hi' }] }]);
	dialogs.messages.set(STRANGER, [{ messageId: 'dmsg_0000', senderHash: ME, parts: [{ kind: 'text', text: 'hi' }] }]);
	setActivePinia(createPinia());
});

describe('the owner\'s edits', () => {
	it('adds a photo: one upload, recorded in the slot, the own picture follows, the shared row holds it', async () => {
		const store = useAvatarsStore();
		expect(await store.addPhoto(photoBlob())).toEqual({ shared: 'published' });
		expect(dialogs.uploads).toBe(1);
		expect(store.ownGallery).toHaveLength(1);
		expect(user.currentUser.avatarId).toBe(store.ownGallery[0].avatarId);
		// the own picture is the uploaded bytes, downscaled — nothing downloaded back
		expect(user.currentUser.avatar).toMatch(/^resized\(128\):blob:/);
		expect(dialogs.fetches).toEqual([]);
		expect(sharedIds()).toEqual([store.ownGallery[0].avatarId]);
	});

	it('every dialog this account wrote in gets the grant once; no photo travels in a dialog', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		await vi.waitFor(() => expect(kindsSentTo(WRITTEN)).toEqual(['avatar_gallery_access']));
		await vi.waitFor(() => expect(kindsSentTo(STRANGER)).toEqual(['avatar_gallery_access']));
		expect(kindsSentTo(SILENT)).toEqual([]);
		expect(dialogs.sent[0].parts[0]).toEqual({ kind: 'avatar_gallery_access', version: 1, galleryUuid: MAPPING.galleryUuid, galleryKeyB64: MAPPING.galleryKeyB64 });
		await store.addPhoto(photoBlob());
		await settle();
		expect(kindsSentTo(WRITTEN)).toEqual(['avatar_gallery_access']);
		expect(allKindsSent()).toEqual(['avatar_gallery_access']);
		await vi.waitFor(async () => expect(await loadGranted(ME)).toEqual({ [WRITTEN]: MAPPING.galleryUuid, [STRANGER]: MAPPING.galleryUuid }));
	});

	describe('an edit held offline', () => {
		const deliver = (i, kind) => deliverHeld(heldSlotWrites[i], kind);
		const localIds = () => Object.entries(slot?.avatars ?? {}).sort((x, y) => y[1].at - x[1].at).map(([id]) => id);
		const offlineAdd = async (store) => {
			await expect(store.addPhoto(photoBlob())).rejects.toThrow(/did not take it/);
			return localIds()[0];
		};
		const ready = async () => {
			const store = useAvatarsStore();
			await vi.waitFor(() => expect(sharedRow).toEqual({ version: 1, avatars: {} }));
			slotOffline = true;
			return store;
		};

		it('is published to the shared row once the server accepts it, with no reconnect or sign-in', async () => {
			const store = await ready();
			const a = await offlineAdd(store);
			expect(sharedIds()).toEqual([]);
			deliver(0, 'accepted');
			await vi.waitFor(() => expect(sharedIds()).toEqual([a]));
			expect(dialogs.uploads).toBe(1);
		});

		it('A accepted while a later B is refused: the row holds A, and B never reaches it', async () => {
			const store = await ready();
			const a = await offlineAdd(store);
			const b = await offlineAdd(store);
			deliver(0, 'accepted');
			await vi.waitFor(() => expect(sharedIds()).toEqual([a]));
			const count = published.length;
			deliver(1, 'rejected');
			await settle();
			await settle();
			expect(published).toHaveLength(count);
			expect(sharedIds()).toEqual([a]);
			expect(sharedIds()).not.toContain(b);
		});
	});

	it('set as main reuses the uploaded file, and remove takes the photo out of the shared row', async () => {
		const store = useAvatarsStore();
		await store.addPhoto(photoBlob());
		await store.addPhoto(photoBlob());
		const [newest, oldest] = store.ownGallery.map((e) => e.avatarId);
		expect(await store.setMain(oldest)).toEqual({ shared: 'published' });
		expect(dialogs.uploads).toBe(2);
		expect(store.ownGallery.map((e) => e.avatarId)).toEqual([oldest, newest]);
		expect(sharedIds()).toEqual([oldest, newest]);
		expect(user.currentUser.avatarId).toBe(oldest);
		await store.removePhoto(newest);
		expect(sharedIds()).toEqual([oldest]);
		await store.removePhoto(oldest);
		expect(sharedRow).toEqual({ version: 1, avatars: {} });
		expect(allKindsSent()).not.toContain('avatar');
		expect(allKindsSent()).not.toContain('avatar_removed');
	});

	it('an inline photo in the slot is uploaded once, in its place, before the gallery is shared', async () => {
		const inlineId = 'a'.repeat(32);
		slot = serverSlot = { avatars: { [inlineId]: { photo: { inline_image: [1, 1, '', 'old.jpg', 3, 'image/jpeg', 0, 'AAAA'] }, at: 5 } } };
		const store = useAvatarsStore();
		await vi.waitFor(() => expect(sharedIds()).toEqual([inlineId]));
		expect(dialogs.uploads).toBe(1);
		expect(sharedRow.avatars[inlineId].at).toBe(5);
		expect(Object.keys(sharedRow.avatars[inlineId].photo)).toEqual(['image']);
		expect(Object.keys(slot.avatars[inlineId].photo)).toEqual(['image']);
		expect(store.ownGallery[0].photo.kind).toBe('image');
	});
});

describe('the grant on sign-in and in new dialogs', () => {
	it('the first message into a new dialog brings the grant after it, once', async () => {
		dialogs.messages.delete(STRANGER);
		useAvatarsStore();
		await vi.waitFor(() => expect(kindsSentTo(WRITTEN)).toEqual(['avatar_gallery_access']));
		await dialogs.sendMessage(SILENT, [{ kind: 'text', text: 'hello' }]);
		await vi.waitFor(() => expect(kindsSentTo(SILENT)).toEqual(['text', 'avatar_gallery_access']));
		await dialogs.sendMessage(SILENT, [{ kind: 'text', text: 'again' }]);
		await settle();
		expect(kindsSentTo(SILENT)).toEqual(['text', 'avatar_gallery_access', 'text']);
	});

	it('the own-send hook acts only for the account signed in now', async () => {
		useAvatarsStore();
		await vi.waitFor(() => expect(kindsSentTo(WRITTEN)).toEqual(['avatar_gallery_access']));
		dialogs.sent.length = 0;
		dialogs.probes = 0;
		dialogs.stored(SILENT, [{ kind: 'text', text: 'from a session that ended' }], OTHER_ACCOUNT);
		await settle();
		expect(dialogs.probes).toBe(0);
		expect(dialogs.sent).toEqual([]);
	});

	it('a delivery running when the account signs out sends nothing', async () => {
		dialogs.ownDialogCarriesGrant = async () => {
			user.currentUserHash = null;
			return { carries: false, confirmed: false };
		};
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		useAvatarsStore();
		await settle();
		await settle();
		warn.mockRestore();
		expect(dialogs.sent).toEqual([]);
	});
});

describe("a contact's photos, read one contact at a time", () => {
	const photoWire = (n) => ({ image: [1, 1, '', `p${n}.jpg`, 3, 'image/jpeg', 0, `f_${String(n).repeat(32)}`, 'k'] });
	const photoOf = (n) => ({ kind: 'image', widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: `p${n}.jpg`, size: 3, mimeType: 'image/jpeg', createdAt: 0, fileId: `f_${String(n).repeat(32)}`, encSecretB64: 'k' });
	const grantPart = (key = MAPPING.galleryKeyB64) => ({ kind: 'avatar_gallery_access', version: 1, galleryUuid: MAPPING.galleryUuid, galleryKeyB64: key });
	const grantFrom = (peer, n = 1) => ({ messageId: `dmsg_${n}`, senderHash: peer, parts: [grantPart()] });
	const gallery = (...entries) => ({ state: 'gallery', entries });
	const cached = (peer) => user.contactsMap[peer]?.avatar?.id;

	it('sign-in reads no contact\'s row and no dialog for a grant', async () => {
		dialogs.peerGrants.set(WRITTEN, grantFrom(WRITTEN));
		peerRows.set(WRITTEN, gallery({ avatarId: 'b'.repeat(32), photo: photoOf(2) }));
		useAvatarsStore();
		await vi.waitFor(() => expect(kindsSentTo(WRITTEN)).toEqual(['avatar_gallery_access']));
		await settle();
		expect(peerRowReads).toEqual([]);
		expect(dialogs.grantReads.size).toBe(0);
	});

	it('moves the cached photo to the current one of the contact\'s row, opened with the grant they sent', async () => {
		dialogs.peerGrants.set(WRITTEN, grantFrom(WRITTEN));
		peerRows.set(WRITTEN, gallery({ avatarId: 'b'.repeat(32), photo: photoOf(2) }, { avatarId: 'a'.repeat(32), photo: photoOf(1) }));
		const store = useAvatarsStore();
		const result = await store.checkPeerGallery(WRITTEN, { force: true });
		expect(result.state).toMatchObject({ state: 'gallery' });
		expect(cached(WRITTEN)).toBe('b'.repeat(32));
		expect(user.contactsMap[WRITTEN].avatar.photo).toEqual(photoWire(2));
		expect(peerRowReads).toEqual([{ reader: ME, grant: { ownerHash: WRITTEN, galleryUuid: MAPPING.galleryUuid, galleryKeyB64: MAPPING.galleryKeyB64, messageId: 'dmsg_1' } }]);
	});

	it('a verified read is still returned when the contact cache cannot be updated', async () => {
		dialogs.peerGrants.set(WRITTEN, grantFrom(WRITTEN));
		peerRows.set(WRITTEN, gallery({ avatarId: 'b'.repeat(32), photo: photoOf(2) }));
		user.cacheContactAvatar = async () => { throw new Error('contacts slot not writable'); };
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const result = await useAvatarsStore().checkPeerGallery(WRITTEN, { force: true });
		expect(result.state).toMatchObject({ state: 'gallery' });
		expect(warn).toHaveBeenCalledWith('[avatars] contact avatar cache not updated:', 'contacts slot not writable');
		warn.mockRestore();
	});

	it.each([
		['blocked', { state: 'unavailable', reason: 'blocked' }],
		['missing', { state: 'missing' }],
		['refused', { state: 'invalid_signature', reason: 'bad_signature' }],
	])('a %s row changes nothing', async (_, state) => {
		user.contactsMap[WRITTEN].avatar = { id: 'b'.repeat(32), photo: photoWire(2) };
		dialogs.peerGrants.set(WRITTEN, grantFrom(WRITTEN));
		peerRows.set(WRITTEN, state);
		await useAvatarsStore().checkPeerGallery(WRITTEN, { force: true });
		expect(peerRowReads).toHaveLength(1);
		expect(cached(WRITTEN)).toBe('b'.repeat(32));
	});

	it('a verified empty gallery, or a removed row, clears the cached photo', async () => {
		for (const state of [{ ...gallery(), state: 'empty' }, { state: 'deleted' }]) {
			user.contactsMap[WRITTEN].avatar = { id: 'b'.repeat(32), photo: photoWire(2) };
			dialogs.peerGrants.set(WRITTEN, grantFrom(WRITTEN));
			peerRows.set(WRITTEN, state);
			setActivePinia(createPinia());
			await useAvatarsStore().checkPeerGallery(WRITTEN, { force: true });
			expect(user.contactsMap[WRITTEN].avatar).toBeNull();
		}
	});

	it('a recheck within PEER_RECHECK_MS reads nothing, a forced one does; the grant is read from the dialog once', async () => {
		dialogs.peerGrants.set(WRITTEN, grantFrom(WRITTEN));
		peerRows.set(WRITTEN, gallery({ avatarId: 'b'.repeat(32), photo: photoOf(2) }));
		const store = useAvatarsStore();
		await store.checkPeerGallery(WRITTEN, { force: true });
		expect(await store.checkPeerGallery(WRITTEN)).toBeNull();
		expect(peerRowReads).toHaveLength(1);
		await store.checkPeerGallery(WRITTEN, { force: true });
		expect(peerRowReads).toHaveLength(2);
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + PEER_RECHECK_MS + 1);
		try {
			peerRows.set(WRITTEN, gallery({ avatarId: 'c'.repeat(32), photo: photoOf(3) }));
			await store.checkPeerGallery(WRITTEN);
		} finally {
			vi.restoreAllMocks();
		}
		expect(peerRowReads).toHaveLength(3);
		expect(dialogs.grantReads.get(WRITTEN)).toBe(1);
		expect(cached(WRITTEN)).toBe('c'.repeat(32));
	});

	describe('kept across a restart for the lists', () => {
		const B = 'b'.repeat(32);
		const restart = () => { setActivePinia(createPinia()); return useAvatarsStore(); };

		it('a verified photo of a peer who is not a contact comes back after a restart from this device alone', async () => {
			dialogs.peerGrants.set(STRANGER, grantFrom(STRANGER));
			peerRows.set(STRANGER, gallery({ avatarId: B, photo: photoOf(2) }));
			await useAvatarsStore().checkPeerGallery(STRANGER, { force: true });
			expect(await getPeerAvatar(ME, STRANGER)).toEqual({ id: B, photo: photoWire(2) });
			await putThumb(ME, STRANGER, { avatarId: B, thumb: 'data:kept' });
			const reads = peerRowReads.length;
			dialogs.grantReads.clear();
			const store = restart();
			store.peerAvatarSrc(STRANGER, { fetch: false });
			await vi.waitFor(() => expect(store.peerAvatarSrc(STRANGER, { fetch: false })).toBe('data:kept'));
			expect(peerRowReads).toHaveLength(reads);
			expect(dialogs.grantReads.size).toBe(0);
		});

		it('an answer that lands after signing out and in again, to the same account, keeps nothing', async () => {
			dialogs.peerGrants.set(STRANGER, grantFrom(STRANGER));
			let answer;
			peerRows.set(STRANGER, new Promise((r) => { answer = r; }));
			const store = useAvatarsStore();
			const late = store.checkPeerGallery(STRANGER, { force: true });
			await vi.waitFor(() => expect(peerRowReads).toHaveLength(1));
			user.currentUserHash = null;
			user.currentUserHash = ME;
			answer(gallery({ avatarId: B, photo: photoOf(2) }));
			expect(await late).toBeNull();
			expect(await getPeerAvatar(ME, STRANGER)).toBeUndefined();
		});

		const STALE = 'z'.repeat(32);
		const staleContact = () => ({ id: STALE, photo: photoWire(1) });

		it('a newer photo kept on this device wins over an older one on the contact record', async () => {
			user.contactsMap[WRITTEN].avatar = staleContact();
			await putPeerAvatar(ME, WRITTEN, { id: B, photo: photoWire(2) });
			await putThumb(ME, WRITTEN, { avatarId: B, thumb: 'data:newer' });
			const store = restart();
			const src = () => store.peerAvatarSrc(WRITTEN, { fetch: false, fallback: user.contactsMap[WRITTEN].avatar });
			src();
			await vi.waitFor(() => expect(src()).toBe('data:newer'));
		});

		it('a gallery verified empty shows no photo, though the contact record kept an old one it could not drop', async () => {
			user.contactsMap[WRITTEN].avatar = staleContact();
			await putThumb(ME, WRITTEN, { avatarId: STALE, thumb: 'data:stale' });
			let store = restart();
			const src = () => store.peerAvatarSrc(WRITTEN, { fetch: false, fallback: user.contactsMap[WRITTEN].avatar });
			src();
			await vi.waitFor(() => expect(src()).toBe('data:stale'));
			user.cacheContactAvatar = async () => { throw new Error('contacts slot not writable'); };
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			dialogs.peerGrants.set(WRITTEN, grantFrom(WRITTEN));
			peerRows.set(WRITTEN, { state: 'empty' });
			await store.checkPeerGallery(WRITTEN, { force: true });
			warn.mockRestore();
			expect(cached(WRITTEN)).toBe(STALE);
			expect(src()).toBe('');
			expect(await getPeerAvatar(ME, WRITTEN)).toBeNull();
			store = restart();
			src();
			for (let i = 0; i < 4; i++) await settle();
			expect(src()).toBe('');
		});
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

	it('fetches a photo as its owner\'s file, once, and serves it from the media cache', async () => {
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

	it('a row off screen downloads no photo, yet draws a thumbnail kept on this device; on screen it makes the missing one', async () => {
		const store = useAvatarsStore();
		const wire = (n) => ({ image: [1, 1, '', `${n}.jpg`, 1, 'image/jpeg', 0, 'f_' + String(n).repeat(32), 'k'] });
		const kept = { id: 'd'.repeat(32), photo: wire(6) };
		const missing = { id: 'e'.repeat(32), photo: wire(5) };
		await putThumb(ME, SILENT, { avatarId: 'd'.repeat(32), thumb: 'data:kept' });
		store.contactAvatarSrc(kept, SILENT, { fetch: false });
		await vi.waitFor(() => expect(store.contactAvatarSrc(kept, SILENT, { fetch: false })).toBe('data:kept'));
		store.contactAvatarSrc(missing, PEER, { fetch: false });
		await settle();
		await settle();
		expect(dialogs.fetches).toEqual([]);
		store.contactAvatarSrc(missing, PEER);
		await vi.waitFor(() => expect(dialogs.fetches.map((f) => f.fileId)).toEqual(['f_' + '5'.repeat(32)]));
	});
});

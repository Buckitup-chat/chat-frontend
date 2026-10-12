// Profile photos (chat repo docs/pq/reqs/pq_avatars.proposed.md): the
// owner's gallery, its delivery into dialogs, and the decrypted photos the
// screens draw.
//
// The gallery lives in the `avatars` user_storage slot, shared by the
// owner's devices; every change to it goes out as dialog messages
// (lib/avatars/delivery). A reader's view of someone's gallery is not kept
// here: it is computed from the dialog (composables/usePeerGallery).

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import {
	AVATARS_SLOT, ownGalleryOf, nextAt, addPatch, setMainPatch, removePatch, newAvatarId,
} from '@/lib/avatars/gallery';
import { createAvatarDelivery } from '@/lib/avatars/delivery';
import { cachedPhotoOf, imageMime, inlineDataUrl } from '@/lib/avatars/display';
import { thumbDataUrl } from '@/lib/data/imageMeta';
import { getCachedMedia, putCachedMedia } from '@/lib/data/mediaCache';
import { fileKey } from '@/lib/data/fileKey';
import { isRefusedFile } from '@/lib/data/fileIntegrity';
import { IndexedDbStore } from '@/lib/data/indexedDbStore';
import { resizeImageUrl } from '@/utils/imageResize';

/** A photo that failed to arrive is not asked for again before this. */
export const PHOTO_RETRY_AFTER_MS = 60_000;
/** The account's own picture, kept on the device for the menu and the account list. */
const OWN_PICTURE_SIDE = 128;
/** A contact's picture in the lists. */
const CONTACT_THUMB_SIDE = 96;

export const useAvatarsStore = defineStore('avatars', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();
	const em = () => EncryptionManagerPQ.getInstance();

	// ---------- decrypted photos ----------

	// The URLs live in the media cache, keyed by fileKey: a photo is its
	// sender's own upload (pq_avatars § The photo), so the same file named by
	// someone else is another entry. This tick only tells the screens that
	// one arrived or failed; a URL the cache evicted is fetched again.
	const photoTick = ref(0);
	const inFlight = new Map(); // fileKey -> Promise<string>
	const failedUntil = new Map(); // fileKey -> time a retry is allowed
	const keyOf = (photo, uploaderHash) => fileKey({ uploaderHash, fileId: photo.fileId });

	/** Fetches a photo uploaded by `uploaderHash`; resolves to its URL. */
	const loadPhoto = (photo, uploaderHash) => {
		if (photo.kind === 'inline_image') return Promise.resolve(inlineDataUrl(photo));
		const key = keyOf(photo, uploaderHash);
		const cached = getCachedMedia(key);
		if (cached) return Promise.resolve(cached);
		if (inFlight.has(key)) return inFlight.get(key);
		if ((failedUntil.get(key) ?? 0) > Date.now()) return Promise.reject(new Error('This photo did not arrive; it is asked for again later'));
		const pending = $dialogs.fetchFile({ ...photo, uploaderHash })
			.then((bytes) => {
				failedUntil.delete(key);
				return putCachedMedia(key, bytes, imageMime(photo.mimeType));
			}, (e) => {
				// A refused file gets the same answer every time.
				failedUntil.set(key, isRefusedFile(e) ? Infinity : Date.now() + PHOTO_RETRY_AFTER_MS);
				console.warn('[avatars] photo not loaded:', e?.message ?? e);
				throw e;
			})
			.finally(() => {
				inFlight.delete(key);
				photoTick.value++;
			});
		inFlight.set(key, pending);
		return pending;
	};

	/**
	 * A photo's URL if it is here; empty while it is on its way, and asking
	 * for it starts that — or, after a failure, not before its retry-after.
	 */
	const photoUrl = (photo, uploaderHash) => {
		if (!photo) return '';
		if (photo.kind === 'inline_image') return inlineDataUrl(photo);
		void photoTick.value;
		const url = getCachedMedia(keyOf(photo, uploaderHash));
		if (!url) loadPhoto(photo, uploaderHash).catch(() => {});
		return url ?? '';
	};

	// A contact's picture in the lists: a small thumbnail of the photo the
	// contacts slot names, made once and kept on this device; its ThumbHash
	// blur until then.
	const thumbStore = new IndexedDbStore('bkp-avatar-thumbs');
	const thumbs = ref({}); // `${userHash}/${avatarId}` -> data URL
	const thumbsAsked = new Set();

	const loadThumb = async (key, photo, userHash) => {
		let thumb = await thumbStore.get(key).catch(() => null);
		if (!thumb) {
			thumb = (await resizeImageUrl(await loadPhoto(photo, userHash), CONTACT_THUMB_SIDE, 0.7)).dataUrl;
			thumbStore.set(key, thumb).catch(() => {});
		}
		thumbs.value = { ...thumbs.value, [key]: thumb };
	};

	/** What the lists draw for a contact whose slot entry caches `avatar` ({ id, photo }); empty for none. */
	const contactAvatarSrc = (avatar, userHash) => {
		const cached = cachedPhotoOf(avatar);
		if (!cached) return '';
		const key = `${userHash}/${cached.avatarId}`;
		if (thumbs.value[key]) return thumbs.value[key];
		if (!thumbsAsked.has(key)) {
			thumbsAsked.add(key);
			loadThumb(key, cached.photo, userHash).catch(() => {
				setTimeout(() => thumbsAsked.delete(key), PHOTO_RETRY_AFTER_MS);
			});
		}
		return thumbDataUrl(cached.photo);
	};

	// ---------- the owner's gallery ----------

	const own = ref({ owner: null, record: null });
	let loading = null;

	/** The account's photos, newest first: the first is the current avatar. */
	const ownGallery = computed(() =>
		own.value.owner && own.value.owner === $userPQ.currentUserHash ? ownGalleryOf(own.value.record) : []);

	/** Reads the gallery slot once per account; `fresh` reads it again (another device may have changed it). */
	const loadOwn = ({ fresh = false } = {}) => {
		const owner = $userPQ.currentUserHash;
		if (!owner) return Promise.resolve([]);
		if (!fresh && own.value.owner === owner) return Promise.resolve(ownGallery.value);
		if (loading?.owner === owner) return loading.promise;
		const promise = (async () => {
			const record = await em().loadSlotJson(AVATARS_SLOT);
			if ($userPQ.currentUserHash !== owner) throw new Error('The account changed while its photos were loading');
			// null: no slot yet, or none this device could read.
			own.value = { owner, record };
			return ownGallery.value;
		})().finally(() => { if (loading?.promise === promise) loading = null; });
		loading = { owner, promise };
		return promise;
	};

	const patchOwn = async (owner, patch) => {
		const record = await em().patchSlotJson(AVATARS_SLOT, patch);
		if ($userPQ.currentUserHash === owner) own.value = { owner, record };
		return record;
	};

	/**
	 * Keeps the account's own picture (menu, account list) on the current
	 * photo: a small data URL kept on this device, refreshed when the current
	 * photo is another one than the one it shows — after a change here, or one
	 * another device made.
	 */
	const syncOwnAvatarImage = async () => {
		const owner = $userPQ.currentUserHash;
		const current = ownGallery.value[0] ?? null;
		const shown = $userPQ.currentUser?.avatarId ?? null;
		if ((current?.avatarId ?? null) === shown && (current || !$userPQ.currentUser?.avatar)) return;
		// A slot that could not be read says nothing about the picture: keep it.
		if (!current && own.value.record === null) return;
		const dataUrl = current
			? (await resizeImageUrl(await loadPhoto(current.photo, owner), OWN_PICTURE_SIDE, 0.8)).dataUrl
			: null;
		if ($userPQ.currentUserHash !== owner) return;
		await $userPQ.setOwnAvatarImage({ avatarId: current?.avatarId ?? null, dataUrl });
	};

	// ---------- delivery ----------

	// One delivery per account, its dependencies bound to that account: a
	// delivery still running after an account switch must not send the old
	// account's photos from the new one.
	const deliveries = new Map();
	const deliveryFor = (owner) => {
		if (deliveries.has(owner)) return deliveries.get(owner);
		const sameAccount = () => {
			if ($userPQ.currentUserHash !== owner) throw new Error('The account changed; its photos are not sent from another one');
		};
		const delivery = createAvatarDelivery({
			gallery: () => {
				sameAccount();
				return loadOwn();
			},
			contacts: () => Object.keys($userPQ.contactsMap).filter((p) => p !== owner),
			isTarget: (peerHash) => peerHash !== owner && !!$userPQ.contactsMap[peerHash],
			probe: async (peerHash, opts) => {
				sameAccount();
				const read = await $dialogs.ownDialogCarriesAvatar(peerHash, opts).catch((e) => {
					console.warn('[avatars] dialog not read:', e?.message ?? e);
					return null;
				});
				return read ?? { ownKey: null, carries: null };
			},
			send: async (peerHash, parts) => {
				sameAccount();
				await $dialogs.sendMessage(peerHash, parts, (status, cause) => {
					if (status === 'error') console.warn('[avatars] a photo message was refused for', peerHash, cause);
				});
			},
		});
		deliveries.set(owner, delivery);
		return delivery;
	};

	// Rule 2: a message this account stores for a dialog may bring the gallery along.
	$dialogs.onOwnSend((peerHash, parts) => {
		const owner = $userPQ.currentUserHash;
		if (!owner) return;
		deliveryFor(owner).onOwnSend(peerHash, parts)
			.catch((e) => console.warn('[avatars] gallery not sent into a new dialog:', e));
	});

	// ---------- owner's actions ----------

	// Each change starts from the slot as it is now: another device may have
	// changed it, and the new photo's `at` must be past every entry there.

	/**
	 * Adds a photo, already resized (≤640 px, JPEG), as the current avatar:
	 * uploaded once as a file that every dialog's message references, then
	 * recorded in the gallery slot, then sent. Resolves to the delivery
	 * result: which dialogs it was stored for sending to, which refused it.
	 */
	const addPhoto = async (blob) => {
		const owner = $userPQ.currentUserHash;
		if (!owner) throw new Error('Not signed in');
		await loadOwn({ fresh: true });
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const photo = await $dialogs.uploadAttachment({
			name: 'avatar.jpg', mimeType: blob.type || 'image/jpeg', bytes,
			createdAt: Math.floor(Date.now() / 1000), blob,
		});
		if (photo.kind !== 'image') throw new Error('The photo could not be read as an image');
		// The bytes are here already: no download of what was just uploaded.
		putCachedMedia(keyOf(photo, owner), bytes, imageMime(photo.mimeType));
		const avatarId = newAvatarId();
		await patchOwn(owner, addPatch(avatarId, photo, nextAt(own.value.record)));
		await syncOwnAvatarImage().catch((e) => console.warn('[avatars] own picture not refreshed:', e));
		return deliveryFor(owner).deliverChange({ kind: 'avatar', avatarId, photo });
	};

	/** Makes an older photo the current avatar again ("set as main"). */
	const setMain = async (avatarId) => {
		const owner = $userPQ.currentUserHash;
		await loadOwn({ fresh: true });
		const entry = ownGallery.value.find((e) => e.avatarId === avatarId);
		if (!entry) throw new Error('This photo is no longer in the gallery');
		await patchOwn(owner, setMainPatch(avatarId, nextAt(own.value.record)));
		await syncOwnAvatarImage().catch((e) => console.warn('[avatars] own picture not refreshed:', e));
		return deliveryFor(owner).deliverChange({ kind: 'avatar', avatarId, photo: entry.photo });
	};

	/** Takes a photo out of the gallery. It cannot unsend it: a reader who downloaded it keeps the bytes. */
	const removePhoto = async (avatarId) => {
		const owner = $userPQ.currentUserHash;
		await loadOwn({ fresh: true });
		await patchOwn(owner, removePatch(avatarId));
		await syncOwnAvatarImage().catch((e) => console.warn('[avatars] own picture not refreshed:', e));
		return deliveryFor(owner).deliverChange({ kind: 'avatar_removed', avatarId });
	};

	// Each signed-in account reads its gallery once, and the picture follows
	// it. Keyed on the session's user, which sign-in sets after the keys open.
	watch(() => $userPQ.currentUser?.user_hash, (owner) => {
		if (!owner) return;
		loadOwn()
			.then(() => syncOwnAvatarImage())
			.catch((e) => console.warn('[avatars] gallery not loaded:', e));
	}, { immediate: true });

	return {
		ownGallery,
		loadOwn,
		addPhoto,
		setMain,
		removePhoto,
		photoUrl,
		loadPhoto,
		contactAvatarSrc,
	};
});

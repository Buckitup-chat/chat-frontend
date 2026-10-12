// Profile photos (chat repo docs/pq/reqs/pq_avatars.proposed.md): the
// owner's gallery, its delivery into dialogs, and the decrypted photos the
// screens draw.
//
// The gallery lives in the `avatars` user_storage slot, shared by the
// owner's devices; every change to it goes out as dialog messages
// (lib/avatars/delivery). A reader's view of someone's gallery is not kept
// here: it is computed from the dialog (lib/avatars/gallery galleryOf).

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import {
	AVATARS_SLOT, ownGalleryOf, nextAt, addPatch, setMainPatch, removePatch, newAvatarId, carriesAvatarFrom,
} from '@/lib/avatars/gallery';
import { createAvatarDelivery } from '@/lib/avatars/delivery';
import { imageMime, inlineDataUrl } from '@/lib/avatars/display';
import { getCachedMedia, putCachedMedia } from '@/lib/data/mediaCache';
import { fromBase64, toBase64 } from '@/lib/pq/signature';

export const useAvatarsStore = defineStore('avatars', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();
	const em = () => EncryptionManagerPQ.getInstance();

	// ---------- decrypted photos ----------

	// Keyed by uploader and file: a photo counts only as its sender's own
	// upload (pq_avatars § The photo), so the same file fetched for someone
	// else is a different, refused, entry.
	const photoUrls = ref({}); // key -> { url } | { error: true }
	const inFlight = new Map(); // key -> Promise<string>
	const photoKey = (photo, uploaderHash) => `${uploaderHash}|${photo.fileId}`;

	/** A photo's URL if it is here; empty while it is on its way or failed. */
	const photoUrl = (photo, uploaderHash) => {
		if (!photo) return '';
		if (photo.kind === 'inline_image') return inlineDataUrl(photo);
		return photoUrls.value[photoKey(photo, uploaderHash)]?.url ?? '';
	};

	/** Fetches a photo uploaded by `uploaderHash`; resolves to its URL. */
	const loadPhoto = (photo, uploaderHash) => {
		if (photo.kind === 'inline_image') return Promise.resolve(inlineDataUrl(photo));
		const key = photoKey(photo, uploaderHash);
		const known = photoUrls.value[key]?.url;
		if (known) return Promise.resolve(known);
		const cached = getCachedMedia(`avatar|${key}`);
		if (cached) {
			photoUrls.value = { ...photoUrls.value, [key]: { url: cached } };
			return Promise.resolve(cached);
		}
		if (inFlight.has(key)) return inFlight.get(key);
		const pending = $dialogs.fetchFile(photo, { uploaderHash })
			.then((bytes) => {
				const url = putCachedMedia(`avatar|${key}`, bytes, imageMime(photo.mimeType));
				photoUrls.value = { ...photoUrls.value, [key]: { url } };
				return url;
			}, (e) => {
				photoUrls.value = { ...photoUrls.value, [key]: { error: true } };
				throw e;
			})
			.finally(() => inFlight.delete(key));
		inFlight.set(key, pending);
		return pending;
	};

	const photoBytes = (photo, uploaderHash) =>
		photo.kind === 'inline_image' ? Promise.resolve(fromBase64(photo.dataB64)) : $dialogs.fetchFile(photo, { uploaderHash });

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
	 * photo: a data URL kept on this device, refreshed when the current photo
	 * is another one than the one it shows — after a change here, or one
	 * another device made.
	 */
	const syncOwnAvatarImage = async ({ bytes = null } = {}) => {
		const owner = $userPQ.currentUserHash;
		const current = ownGallery.value[0] ?? null;
		const shown = $userPQ.currentUser?.avatarId ?? null;
		if ((current?.avatarId ?? null) === shown && (current || !$userPQ.currentUser?.avatar)) return;
		// A slot that could not be read says nothing about the picture: keep it.
		if (!current && own.value.record === null) return;
		let dataUrl = null;
		if (current) {
			const data = bytes ?? await photoBytes(current.photo, owner);
			dataUrl = `data:${imageMime(current.photo.mimeType)};base64,${toBase64(data)}`;
		}
		if ($userPQ.currentUserHash !== owner) return;
		await $userPQ.setOwnAvatarImage({ avatarId: current?.avatarId ?? null, dataUrl });
	};

	// ---------- delivery ----------

	const markerKey = (owner, peerHash) => `bkp:avatar-carried:${owner}:${$dialogs.getDialogHash(peerHash)}`;

	// One delivery per account, its dependencies bound to that account: a
	// delivery still running after an account switch must not send the old
	// account's photos from the new one.
	const deliveries = new Map();
	const deliveryFor = (owner) => {
		if (deliveries.has(owner)) return deliveries.get(owner);
		const sameAccount = () => {
			if ($userPQ.currentUserHash !== owner) throw new Error('The account changed; its photos are not sent from another one');
		};
		const marked = (peerHash) => {
			try {
				return localStorage.getItem(markerKey(owner, peerHash)) === '1';
			} catch {
				return false;
			}
		};
		const delivery = createAvatarDelivery({
			gallery: () => {
				sameAccount();
				return loadOwn();
			},
			targets: async () => {
				const out = [];
				for (const peerHash of Object.keys($userPQ.contactsMap)) {
					if (peerHash === owner) continue;
					sameAccount();
					if (marked(peerHash) || (await $dialogs.hasOwnDialogKey(peerHash).catch(() => null)) === true) out.push(peerHash);
				}
				return out;
			},
			isTarget: (peerHash) => peerHash !== owner && !!$userPQ.contactsMap[peerHash],
			readCarries: async (peerHash) => {
				sameAccount();
				const messages = await $dialogs.ownMessagesIn(peerHash).catch(() => null);
				return messages ? carriesAvatarFrom(messages, owner) : null;
			},
			marked,
			mark: (peerHash) => {
				try {
					localStorage.setItem(markerKey(owner, peerHash), '1');
				} catch { /* private mode: the dialog is read again next time */ }
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
		const avatarId = newAvatarId();
		await patchOwn(owner, addPatch(avatarId, photo, nextAt(own.value.record)));
		await syncOwnAvatarImage({ bytes }).catch((e) => console.warn('[avatars] own picture not refreshed:', e));
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
	};
});

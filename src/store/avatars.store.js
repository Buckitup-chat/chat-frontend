// Profile photos (chat repo docs/pq/reqs/pq_avatars.proposed.md): the
// owner's gallery, its shared row and grants, and the decrypted photos the
// screens draw.
//
// The gallery lives in the `avatars` user_storage slot, shared by the
// owner's devices; every change to it is published to the shared gallery row
// (lib/avatars/sharedGallery). A reader's view of someone's gallery is not kept
// here: it is read from that row (composables/usePeerGallery). What a
// reader keeps is a peer's current photo, also cached next to saved contacts.

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import {
	AVATARS_SLOT, ownGalleryOf, nextAt, addPatch, setMainPatch, removePatch, newAvatarId,
} from '@/lib/avatars/gallery';
import { createGrantDelivery, grantPartOf, isGrantPart } from '@/lib/avatars/galleryGrants';
import { legacyToSharedGallery } from '@/lib/avatars/sharedGalleryPublish';
import { readPeerGallery, isDisplayable } from '@/lib/avatars/peerGallery';
import { StorageNotOnServerError } from '@/lib/data/userStorage';
import { photoFromWire } from '@/lib/pq/content';
import { fromBase64 } from '@/lib/pq/signature';
import { peersWeWrote } from '@/lib/data/outboundDialogs';
import { cachedPhotoOf, contactAvatarChange, imageMime, inlineDataUrl } from '@/lib/avatars/display';
import { thumbDataUrl } from '@/lib/data/imageMeta';
import { getCachedMedia, putCachedMedia } from '@/lib/data/mediaCache';
import { fileKey } from '@/lib/data/fileKey';
import { isRefusedFile } from '@/lib/data/fileIntegrity';
import {
	getThumb, putThumb, forgetThumb, loadGranted, markGranted, getPeerGrant, putPeerGrant,
	getPeerAvatar, putPeerAvatar,
} from '@/lib/avatars/localStore';
import { resizeImageUrl } from '@/utils/imageResize';

/** A photo that failed to arrive is not asked for again before this. */
export const PHOTO_RETRY_AFTER_MS = 60_000;
/** The account's own picture, kept on the device for the menu and the account list. */
const OWN_PICTURE_SIDE = 128;
/** A peer's picture in the lists. */
const CONTACT_THUMB_SIDE = 96;
export const PEER_RECHECK_MS = 30_000;
const SHARED_RETRY_AFTER_MS = 60_000;

export const useAvatarsStore = defineStore('avatars', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();
	const em = () => EncryptionManagerPQ.getInstance();

	let signIn = 0;
	watch(() => $userPQ.currentUserHash, () => { signIn++; }, { flush: 'sync' });

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
	// contacts slot names, made once and kept on this device, sealed per
	// account (lib/avatars/localStore) — one per contact, replaced when the
	// photo changes; its ThumbHash blur until then.
	const thumbs = ref({}); // `${owner}|${userHash}|${avatarId}` -> data URL
	const thumbsAsked = new Set();

	const loadThumb = async (owner, key, userHash, { avatarId, photo }, fetch) => {
		const stored = await getThumb(owner, userHash).catch(() => null);
		let thumb = stored?.avatarId === avatarId ? stored.thumb : null;
		if (!thumb) {
			if (!fetch) return;
			thumb = (await resizeImageUrl(await loadPhoto(photo, userHash), CONTACT_THUMB_SIDE, 0.7)).dataUrl;
			await putThumb(owner, userHash, { avatarId, thumb }).catch((e) => console.warn('[avatars] thumbnail not kept:', e?.message ?? e));
		}
		thumbs.value = { ...thumbs.value, [key]: thumb };
	};

	/** What the lists draw for a contact whose slot entry caches `avatar` ({ id, photo }); empty for none. */
	const contactAvatarSrc = (avatar, userHash, { fetch = true } = {}) => {
		const cached = cachedPhotoOf(avatar);
		const owner = $userPQ.currentUserHash;
		if (!cached || !owner) return '';
		const key = `${owner}|${userHash}|${cached.avatarId}`;
		if (thumbs.value[key]) return thumbs.value[key];
		const asked = fetch ? `${key}|fetch` : key;
		if (!thumbsAsked.has(asked)) {
			thumbsAsked.add(asked);
			loadThumb(owner, key, userHash, cached, fetch).catch(() => {
				setTimeout(() => thumbsAsked.delete(asked), PHOTO_RETRY_AFTER_MS);
			});
		}
		return thumbDataUrl(cached.photo);
	};

	/** Drops the thumbnail kept for a contact whose gallery is empty. */
	const forgetContactThumb = (userHash) => {
		const owner = $userPQ.currentUserHash;
		if (owner) forgetThumb(owner, userHash).catch((e) => console.warn('[avatars] thumbnail not removed:', e?.message ?? e));
	};

	const peerAvatars = ref({});
	const peerAvatarsRestored = new Set();

	const peerAvatarSrc = (peerHash, { fallback = null, ...options } = {}) => {
		const owner = $userPQ.currentUserHash;
		if (!owner || !peerHash) return '';
		const key = `${owner}|${peerHash}`;
		if (!(key in peerAvatars.value) && !peerAvatarsRestored.has(`${signIn}|${key}`)) {
			peerAvatarsRestored.add(`${signIn}|${key}`);
			const session = signIn;
			getPeerAvatar(owner, peerHash).then((stored) => {
				if (stored === undefined || signIn !== session || key in peerAvatars.value) return;
				peerAvatars.value = { ...peerAvatars.value, [key]: stored };
			}).catch((e) => console.warn('[avatars] kept peer photo not read:', e?.message ?? e));
		}
		return contactAvatarSrc(key in peerAvatars.value ? peerAvatars.value[key] : fallback, peerHash, options);
	};

	const followContactAvatar = async (peerHash, current) => {
		const owner = $userPQ.currentUserHash;
		if (!owner || !peerHash || peerHash === owner) return;
		const key = `${owner}|${peerHash}`;
		const peerValue = contactAvatarChange(peerAvatars.value[key], current);
		if (peerValue !== undefined || !current) peerAvatars.value = { ...peerAvatars.value, [key]: peerValue ?? null };
		const warn = (e) => console.warn('[avatars] kept peer photo not updated:', e?.message ?? e);
		if (peerValue) await putPeerAvatar(owner, peerHash, peerValue).catch(warn);
		if (!current) {
			forgetContactThumb(peerHash);
			await putPeerAvatar(owner, peerHash, null).catch(warn);
		}
		const contact = $userPQ.contactsMap?.[peerHash];
		if (!contact) return;
		const value = contactAvatarChange(contact.avatar, current);
		if (value === undefined) return;
		await $userPQ.cacheContactAvatar(peerHash, value);
	};

	const checkedAt = new Map();

	const checkPeerGallery = async (peerHash, { grant = null, force = false, fresh = false } = {}) => {
		const owner = $userPQ.currentUserHash;
		if (!owner || !peerHash || peerHash === owner) return null;
		const session = signIn;
		const key = `${owner}|${peerHash}`;
		if (!force && Date.now() - (checkedAt.get(key) ?? -Infinity) < PEER_RECHECK_MS) return null;
		checkedAt.set(key, Date.now());
		if (grant) await rememberPeerGrant(peerHash, grant);
		const current = await peerGrant(peerHash);
		if (!current || $userPQ.currentUserHash !== owner) return null;
		const state = await readPeerGallery(owner, current, { fresh });
		if ($userPQ.currentUserHash !== owner || signIn !== session) return null;
		if (isDisplayable(state)) {
			await followContactAvatar(peerHash, state.state === 'gallery' ? state.entries[0] ?? null : null)
				.catch((e) => console.warn('[avatars] contact avatar cache not updated:', e?.message ?? e));
		}
		return { grant: current, state };
	};

	// ---------- the owner's gallery ----------

	const own = ref({ owner: null, record: null, at: 0 });
	let loading = null;

	/** The account's photos, newest first: the first is the current avatar. */
	const ownGallery = computed(() =>
		own.value.owner && own.value.owner === $userPQ.currentUserHash ? ownGalleryOf(own.value.record) : []);

	/**
	 * Reads the gallery slot once per account; `fresh` reads it again (another
	 * device may have changed it), `maxAgeMs` when the last read is older. A
	 * slot there that does not decrypt fails the read rather than reading as
	 * an empty gallery.
	 */
	const loadOwn = ({ fresh = false, maxAgeMs = Infinity } = {}) => {
		const owner = $userPQ.currentUserHash;
		if (!owner) return Promise.resolve([]);
		const recent = own.value.owner === owner && Date.now() - own.value.at <= maxAgeMs;
		if (!fresh && recent) return Promise.resolve(ownGallery.value);
		if (loading?.owner === owner) return loading.promise;
		const promise = (async () => {
			// null: the account has no gallery slot.
			const record = await em().loadSlotJson(AVATARS_SLOT, { strict: true });
			if ($userPQ.currentUserHash !== owner) throw new Error('The account changed while its photos were loading');
			own.value = { owner, record, at: Date.now() };
			return ownGallery.value;
		})().finally(() => { if (loading?.promise === promise) loading = null; });
		loading = { owner, promise };
		return promise;
	};

	const patchOwn = async (owner, patch) => {
		let record;
		try {
			record = await em().patchSlotJson(AVATARS_SLOT, patch);
		} catch (e) {
			if (e instanceof StorageNotOnServerError && e.outcome) publishWhenAccepted(owner, e.outcome);
			throw e;
		}
		if ($userPQ.currentUserHash === owner) own.value = { owner, record, at: Date.now() };
		return record;
	};

	const publishWhenAccepted = (owner, outcome) => {
		const session = signIn;
		const current = () => signIn === session && $userPQ.currentUserHash === owner;
		void outcome.then(async (verdict) => {
			if (verdict?.kind !== 'accepted' || !current()) return;
			const accepted = await em().loadAcceptedSlotJson(AVATARS_SLOT);
			if (accepted.state !== 'found' || !current()) return;
			const result = await publishOwnGallery(owner, accepted.record);
			if (result.state === 'published' && current()) await grantDeliveryFor(owner).grantAll();
		}).catch((e) => console.warn('[avatars] gallery not published after its edit was accepted:', e?.message ?? e));
	};

	/**
	 * Keeps the account's own picture (menu, account list) on the current
	 * photo: a small data URL kept on this device, refreshed when the current
	 * photo is another one than the one it shows — after a change here, or one
	 * another device made. With no gallery there is no picture: one kept from
	 * before the gallery is not the account's photo. Runs only after a read
	 * of the slot that succeeded (loadOwn throws for one that does not
	 * decrypt), so a failed read never clears it.
	 */
	const syncOwnAvatarImage = async () => {
		const owner = $userPQ.currentUserHash;
		const current = ownGallery.value[0] ?? null;
		const shown = $userPQ.currentUser?.avatarId ?? null;
		if ((current?.avatarId ?? null) === shown && (current || !$userPQ.currentUser?.avatar)) return;
		const dataUrl = current
			? (await resizeImageUrl(await loadPhoto(current.photo, owner), OWN_PICTURE_SIDE, 0.8)).dataUrl
			: null;
		if ($userPQ.currentUserHash !== owner) return;
		await $userPQ.setOwnAvatarImage({ avatarId: current?.avatarId ?? null, dataUrl });
	};

	const peerGrants = new Map(); // `${owner}|${peer}` -> { ownerHash, galleryUuid, galleryKeyB64, messageId }

	const rememberPeerGrant = async (peerHash, grant) => {
		const owner = $userPQ.currentUserHash;
		if (!owner || !grant || grant.ownerHash !== peerHash) return;
		const key = `${owner}|${peerHash}`;
		const held = peerGrants.get(key);
		if (held && held.messageId >= grant.messageId) return;
		peerGrants.set(key, grant);
		const { galleryUuid, galleryKeyB64, messageId } = grant;
		await putPeerGrant(owner, peerHash, { galleryUuid, galleryKeyB64, messageId })
			.catch((e) => console.warn('[avatars] grant not kept:', e?.message ?? e));
	};

	const peerGrant = async (peerHash) => {
		const owner = $userPQ.currentUserHash;
		if (!owner || !peerHash || peerHash === owner) return null;
		const key = `${owner}|${peerHash}`;
		if (peerGrants.has(key)) return peerGrants.get(key);
		const stored = await getPeerGrant(owner, peerHash).catch(() => null);
		if ($userPQ.currentUserHash !== owner) return null;
		if (stored) {
			const grant = { ownerHash: peerHash, ...stored };
			peerGrants.set(key, grant);
			return grant;
		}
		const read = await $dialogs.readPeerParts(peerHash, ['avatar_gallery_access'], { newestMatch: () => true });
		const found = read?.messages?.[0];
		const part = found?.parts?.find(isGrantPart);
		if (!part || $userPQ.currentUserHash !== owner) return null;
		const grant = { ownerHash: peerHash, galleryUuid: part.galleryUuid, galleryKeyB64: part.galleryKeyB64, messageId: found.messageId };
		await rememberPeerGrant(peerHash, grant);
		return grant;
	};

	const shared = ref({ owner: null, mapping: null });
	let ensuring = null;
	let notReadyUntil = { owner: null, at: 0 };

	const convertInlinePhotos = async (owner, avatarIds) => {
		await loadOwn({ fresh: true });
		for (const avatarId of avatarIds) {
			const entry = own.value.record?.avatars?.[avatarId];
			const photo = entry ? photoFromWire(entry.photo) : null;
			if (!photo || photo.kind !== 'inline_image') continue;
			const bytes = fromBase64(photo.dataB64);
			const mimeType = imageMime(photo.mimeType);
			const uploaded = await $dialogs.uploadAttachment({
				name: photo.name || 'avatar.jpg', mimeType, bytes, createdAt: photo.createdAt,
				blob: new Blob([bytes], { type: mimeType }),
			});
			if (uploaded.kind !== 'image') throw new Error('An inline photo could not be read as an image');
			putCachedMedia(keyOf(uploaded, owner), bytes, mimeType);
			await patchOwn(owner, addPatch(avatarId, uploaded, entry.at));
		}
	};

	const sharedRecordOf = async (owner, record) => {
		let converted = legacyToSharedGallery(record);
		if (converted.state === 'needs-conversion') {
			await convertInlinePhotos(owner, converted.avatarIds);
			converted = legacyToSharedGallery(own.value.record);
		}
		if (converted.state === 'ok') return converted.record;
		console.warn('[avatars] the gallery cannot be shared:', converted.state === 'invalid' ? converted.reason : converted.avatarIds);
		return null;
	};

	const publishOwnGallery = async (owner, record) => {
		const sharedRecord = await sharedRecordOf(owner, record);
		if (!sharedRecord) return { state: 'refused', reason: 'the gallery cannot be shared' };
		const result = await em().publishSharedGalleryRecord(sharedRecord);
		if (result.state === 'published' && $userPQ.currentUserHash === owner) shared.value = { owner, mapping: result.mapping };
		else if (result.state !== 'published') console.warn('[avatars] the shared gallery was not published:', result.state, result.reason ?? '');
		return result;
	};

	const ensureShared = (owner, { force = false } = {}) => {
		if (!force && shared.value.owner === owner && shared.value.mapping) return Promise.resolve(shared.value.mapping);
		if (ensuring?.owner === owner) {
			return force ? ensuring.promise.then((mapping) => mapping ?? ensureShared(owner, { force: true })) : ensuring.promise;
		}
		if (!force && notReadyUntil.owner === owner && notReadyUntil.at > Date.now()) return Promise.resolve(null);
		const promise = (async () => {
			for (let attempt = 0; attempt < 2; attempt++) {
				if ($userPQ.currentUserHash !== owner) return null;
				const result = await em().publishInitialSharedGallery();
				if ($userPQ.currentUserHash !== owner) return null;
				if (result.state === 'published' || result.state === 'adopted') {
					shared.value = { owner, mapping: result.mapping };
					return result.mapping;
				}
				if (result.state === 'needs-conversion' && attempt === 0) {
					await convertInlinePhotos(owner, result.avatarIds);
					continue;
				}
				console.warn('[avatars] the shared gallery is not ready:', result.state, result.reason ?? result.detail ?? '');
				return null;
			}
			return null;
		})().catch((e) => {
			console.warn('[avatars] the shared gallery is not ready:', e?.message ?? e);
			return null;
		}).then((mapping) => {
			if (!mapping) notReadyUntil = { owner, at: Date.now() + SHARED_RETRY_AFTER_MS };
			return mapping;
		}).finally(() => { if (ensuring?.promise === promise) ensuring = null; });
		ensuring = { owner, promise };
		return promise;
	};

	// ---------- delivery ----------

	// One delivery per account, its dependencies bound to that account: a
	// delivery still running after an account switch must not send the old
	// account's grant from the new one.
	const grantDeliveries = new Map();
	const grantDeliveryFor = (owner) => {
		if (grantDeliveries.has(owner)) return grantDeliveries.get(owner);
		const sameAccount = () => {
			if ($userPQ.currentUserHash !== owner) throw new Error('The account changed; its grant is not sent from another one');
		};
		const delivery = createGrantDelivery({
			grant: async () => {
				const mapping = $userPQ.currentUserHash === owner ? await ensureShared(owner) : null;
				return mapping ? grantPartOf(mapping) : null;
			},
			peers: () => peersWeWrote(owner),
			isTarget: (peerHash) => peerHash !== owner,
			granted: {
				load: () => loadGranted(owner),
				mark: (peerHash, galleryUuid) => markGranted(owner, peerHash, galleryUuid),
			},
			carries: async (peerHash, grant) => {
				sameAccount();
				const read = await $dialogs.ownDialogCarriesGrant(peerHash, grant).catch((e) => {
					console.warn('[avatars] dialog not read:', e?.message ?? e);
					return null;
				});
				if (!read || read.carries === null) return null;
				if (!read.carries) return 'none';
				return read.confirmed ? 'confirmed' : 'pending';
			},
			send: async (peerHash, parts) => {
				sameAccount();
				await $dialogs.sendMessage(peerHash, parts, (status, cause) => {
					if (status === 'error') console.warn('[avatars] the grant message was refused for', peerHash, cause);
				});
			},
		});
		grantDeliveries.set(owner, delivery);
		return delivery;
	};

	// A message this account stores for a dialog may bring the gallery grant
	// along — the account that stored it, and only while it is the one signed
	// in.
	$dialogs.onOwnSend((peerHash, parts, ownerHash) => {
		if (!ownerHash || ownerHash !== $userPQ.currentUserHash) return;
		grantDeliveryFor(ownerHash).onOwnSend(peerHash, parts)
			.catch((e) => console.warn('[avatars] grant not sent into a new dialog:', e?.message ?? e));
	});

	/** Sends the grant to dialogs without it; on sign-in, on reconnect. */
	const shareGallery = async () => {
		const owner = $userPQ.currentUserHash;
		if (!owner) return null;
		try {
			if (!(await ensureShared(owner, { force: true }))) return null;
			return await grantDeliveryFor(owner).grantAll();
		} catch (e) {
			console.warn('[avatars] grants not sent:', e?.message ?? e);
			return null;
		}
	};
	if (typeof window !== 'undefined') window.addEventListener('online', () => { void shareGallery(); });

	// ---------- owner's actions ----------

	// Each change starts from the slot as it is now: another device may have
	// changed it, and the new photo's `at` must be past every entry there.

	const afterEdit = async (owner, record) => {
		await syncOwnAvatarImage().catch((e) => console.warn('[avatars] own picture not refreshed:', e));
		const result = await publishOwnGallery(owner, record).catch((e) => ({ state: 'failed', error: e }));
		if (result.state === 'published' && $userPQ.currentUserHash === owner) {
			void grantDeliveryFor(owner).grantAll().catch((e) => console.warn('[avatars] grants not sent:', e?.message ?? e));
		}
		return { shared: result.state };
	};

	/**
	 * Adds a photo, already resized (≤640 px, JPEG), as the current avatar:
	 * uploaded once as a file, recorded in the gallery slot, then published.
	 * Resolves to `{ shared }`: 'published' once contacts can see it.
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
		const record = await patchOwn(owner, addPatch(newAvatarId(), photo, nextAt(own.value.record)));
		return afterEdit(owner, record);
	};

	/** Makes an older photo the current avatar again ("set as main"). */
	const setMain = async (avatarId) => {
		const owner = $userPQ.currentUserHash;
		await loadOwn({ fresh: true });
		if (!ownGallery.value.some((e) => e.avatarId === avatarId)) throw new Error('This photo is no longer in the gallery');
		const record = await patchOwn(owner, setMainPatch(avatarId, nextAt(own.value.record)));
		return afterEdit(owner, record);
	};

	/** Takes a photo out of the gallery. It cannot unsend it: a reader who downloaded it keeps the bytes. */
	const removePhoto = async (avatarId) => {
		const owner = $userPQ.currentUserHash;
		await loadOwn({ fresh: true });
		const record = await patchOwn(owner, removePatch(avatarId));
		return afterEdit(owner, record);
	};

	// Each signed-in account reads its gallery once, and the picture follows
	// it. Keyed on the session's user, which sign-in sets after the keys open.
	watch(() => $userPQ.currentUser?.user_hash, (owner) => {
		if (!owner) return;
		loadOwn()
			.then(() => syncOwnAvatarImage())
			.catch((e) => console.warn('[avatars] gallery not loaded:', e));
	}, { immediate: true });

	// The grant goes out after sign-in, independent of the contact list.
	watch(() => $userPQ.currentUserHash, (owner) => {
		if (owner) void shareGallery();
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
		peerAvatarSrc,
		forgetContactThumb,
		checkPeerGallery,
		shareGallery,
	};
});

import { ref, computed, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useAvatarsStore } from '@/store/avatars.store';
import { grantFromMessages } from '@/lib/avatars/galleryGrants';
import { isDisplayable } from '@/lib/avatars/peerGallery';
import { useGalleryViewer } from '@/composables/useGalleryViewer';

const grantKey = (grant) => (grant ? `${grant.galleryUuid}|${grant.galleryKeyB64}` : '');

export const INITIAL_CHECK_DELAY_MS = 150;

export function usePeerGalleryRefresh(peerHash, dialogGrant = computed(() => null)) {
	const $userPQ = userPQStore();
	const $avatars = useAvatarsStore();
	const shown = ref(null);
	let readGrant = '';
	let started = 0;
	let applied = 0;
	let initialTimer = null;

	const check = async (peer, { force = false, fresh = false } = {}) => {
		const id = ++started;
		try {
			const result = await $avatars.checkPeerGallery(peer, { grant: dialogGrant.value, force, fresh });
			if (!result || result.state.state === 'superseded') return result?.state ?? null;
			if (peerHash.value !== peer || id < applied) return result.state;
			applied = id;
			readGrant = grantKey(result.grant);
			if (isDisplayable(result.state)) shown.value = result.state;
			return result.state;
		} catch (e) {
			console.warn('[avatars] peer gallery not read:', e?.message ?? e);
			return null;
		}
	};

	const cancelInitial = () => {
		clearTimeout(initialTimer);
		initialTimer = null;
	};

	const checkNow = (peer) => {
		cancelInitial();
		return check(peer, { force: true, fresh: true });
	};

	watch([() => $userPQ.currentUserHash, peerHash], ([reader, peer], _before, onCleanup) => {
		shown.value = null;
		readGrant = '';
		if (!reader || !peer) return;
		initialTimer = setTimeout(() => {
			initialTimer = null;
			void check(peer, { force: true });
		}, INITIAL_CHECK_DELAY_MS);
		const onVisible = () => { if (document.visibilityState === 'visible' && !initialTimer) void check(peer); };
		const onOnline = () => { if (!initialTimer) void check(peer); };
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('online', onOnline);
		onCleanup(() => {
			cancelInitial();
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('online', onOnline);
		});
	}, { immediate: true });

	watch(() => grantKey(dialogGrant.value), (key) => {
		if (key && key !== readGrant && peerHash.value && !initialTimer) void check(peerHash.value, { force: true });
	});

	return { shown, checkNow };
}

/**
 * A dialog's profile photos as its reader sees them: the peer's gallery from
 * their shared gallery row, the peer's current photo, and the gallery viewer.
 *
 * `messages`: the page's decrypted messages.
 */
export function usePeerGallery({ peerHash, messages }) {
	const $userPQ = userPQStore();
	const $avatars = useAvatarsStore();

	const dialogGrant = computed(() => (peerHash.value ? grantFromMessages(messages.value, peerHash.value) : null));
	const { shown, checkNow } = usePeerGalleryRefresh(peerHash, dialogGrant);
	const peerGallery = computed(() => (shown.value?.state === 'gallery' ? shown.value.entries : []));

	/** The peer's current photo from their gallery, or until it is read the one cached next to the contact. */
	const avatarUrl = computed(() => {
		const current = peerGallery.value[0];
		if (current) return $avatars.photoUrl(current.photo, peerHash.value);
		if (shown.value) return '';
		return $avatars.peerAvatarSrc(peerHash.value, { fallback: $userPQ.contactsMap?.[peerHash.value]?.avatar });
	});

	// The viewer: the gallery of whoever's picture or photo line was tapped.
	const viewerSender = ref(null);
	const galleryOfSender = (senderHash) => {
		if (!senderHash) return [];
		if (senderHash === $userPQ.currentUserHash) return $avatars.ownGallery;
		return senderHash === peerHash.value ? peerGallery.value : [];
	};
	const viewer = useGalleryViewer(computed(() => galleryOfSender(viewerSender.value)), viewerSender);
	const show = (senderHash, avatarId) => {
		viewerSender.value = senderHash;
		viewer.open(avatarId);
	};
	const openGallery = async ({ senderHash, avatarId = null }) => {
		if (!senderHash || senderHash !== peerHash.value) return show(senderHash, avatarId);
		const reader = $userPQ.currentUserHash;
		const state = await checkNow(senderHash);
		if (state?.state === 'superseded') return;
		if (peerHash.value === senderHash && $userPQ.currentUserHash === reader) show(senderHash, avatarId);
	};
	watch(peerHash, () => viewer.close());

	return { peerGallery, avatarUrl, viewer, openGallery };
}

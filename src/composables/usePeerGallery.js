import { ref, computed, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useAvatarsStore } from '@/store/avatars.store';
import { galleryOf } from '@/lib/avatars/gallery';
import { cachedPhotoOf } from '@/lib/avatars/display';
import { isAvatarPart, photoToWire } from '@/lib/pq/content';
import { useGalleryViewer } from '@/composables/useGalleryViewer';

/**
 * A dialog's profile photos as its reader sees them (pq_avatars § The
 * gallery a reader sees): each sender's gallery from their own verified
 * messages at their current revision, the peer's current photo, the gallery
 * viewer, and the copy of the peer's current photo kept next to the contact
 * (§ What a reader keeps) so the lists draw it without reading the dialog.
 *
 * `messages`: the page's decrypted messages. `ready`: every row of the
 * dialog is here and read — only then does an empty gallery mean the peer
 * has no photo, rather than that the dialog is still being read.
 */
export function usePeerGallery({ peerHash, messages, ready }) {
	const $userPQ = userPQStore();
	const $avatars = useAvatarsStore();

	// Only messages carrying a photo part matter; deleted ones carry none.
	const avatarMessages = computed(() => (messages.value || [])
		.filter((m) => m._verify === 'verified' && m._raw?.sender_hash && (m.parts || []).some(isAvatarPart))
		.map((m) => ({ messageId: m.id, senderHash: m._raw.sender_hash, deleted: !!m._deleted, parts: m.parts })));

	const galleryOfSender = (senderHash) => (senderHash ? galleryOf(avatarMessages.value, senderHash) : []);
	const peerGallery = computed(() => galleryOfSender(peerHash.value));
	const currentId = computed(() => peerGallery.value[0]?.avatarId ?? null);

	/** The peer's current photo from this dialog, or until the dialog is read the one cached next to the contact. */
	const avatarUrl = computed(() => {
		const current = peerGallery.value[0];
		return (current && $avatars.photoUrl(current.photo, peerHash.value))
			|| $avatars.contactAvatarSrc($userPQ.contactsMap?.[peerHash.value]?.avatar, peerHash.value);
	});

	// The contact's cached photo follows the dialog's current one: written
	// when it differs, cleared once the read dialog has none. Keyed on the
	// ids, so a message tick that changes neither writes nothing; a write
	// shows in contactsMap at once (userPQ writeContacts), so the next tick
	// finds it done.
	watch([peerHash, currentId, () => ready.value === true], ([peer, id, read]) => {
		const contact = $userPQ.contactsMap?.[peer];
		if (!peer || !contact) return;
		const cachedId = cachedPhotoOf(contact.avatar)?.avatarId ?? null;
		if (id === cachedId || (!id && (!read || !contact.avatar))) return;
		const value = id ? { id, photo: photoToWire(peerGallery.value[0].photo) } : null;
		$userPQ.cacheContactAvatar(peer, value).catch((e) => console.warn('[chat] avatar cache not updated:', e?.message ?? e));
	}, { immediate: true });

	// The viewer: the gallery of whoever's picture or photo line was tapped.
	const viewerSender = ref(null);
	const viewer = useGalleryViewer(computed(() => galleryOfSender(viewerSender.value)), viewerSender);
	const openGallery = ({ senderHash, avatarId = null }) => {
		viewerSender.value = senderHash;
		viewer.open(avatarId);
	};
	watch(peerHash, () => viewer.close());

	return { peerGallery, avatarUrl, viewer, openGallery };
}

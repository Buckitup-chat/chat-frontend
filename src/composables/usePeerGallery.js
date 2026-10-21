import { ref, computed, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useAvatarsStore } from '@/store/avatars.store';
import { galleryOf } from '@/lib/avatars/gallery';
import { isAvatarPart } from '@buckitup/pq-client/content';
import { useGalleryViewer } from '@/composables/useGalleryViewer';

/**
 * Whether a dialog has been read whole: the live set is confirmed and every
 * row has come to a final state — shown, deleted, or refused for good (failed
 * verification for good, blocked behind such a row, or content that will not
 * decode). A row still waiting on a dependency, a card or its key is not
 * final. Only a dialog read whole can say its sender has no photo.
 */
export const isDialogRead = (live, rows, entries) => {
	if (!live || entries.length !== rows.length) return false;
	return entries.every((m) => {
		if (m._deleted || m._verify === 'blocked') return true;
		if (m._verify === 'invalid') return m._verifyTerminal === true;
		if (m._verify !== 'verified') return false;
		return m._decrypted !== false || m._awaitingKey !== true;
	});
};

/**
 * A dialog's profile photos as its reader sees them (pq_avatars § The
 * gallery a reader sees): each sender's gallery from their own verified
 * messages at their current revision, the peer's current photo, the gallery
 * viewer, and the copy of the peer's current photo kept next to the contact
 * (§ What a reader keeps) so the lists draw it without reading the dialog.
 *
 * `messages`: the page's decrypted messages, one per row of `rows` that has
 * been processed. `live`: the server's set of rows is confirmed (not a disk
 * copy shown while it loads).
 */
export function usePeerGallery({ peerHash, messages, rows, live }) {
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

	const read = computed(() => isDialogRead(live.value === true, rows.value || [], messages.value || []));

	// The contact's cached photo follows the dialog's current one, from a
	// dialog read whole only (avatars.store followContactAvatar). Keyed on
	// the ids, so a message tick that changes neither writes nothing.
	watch([peerHash, currentId, read], ([peer, , whole]) => {
		if (!whole) return;
		$avatars.followContactAvatar(peer, peerGallery.value[0] ?? null)
			.catch((e) => console.warn('[chat] avatar cache not updated:', e?.message ?? e));
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

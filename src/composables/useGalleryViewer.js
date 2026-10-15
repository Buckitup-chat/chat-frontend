import { ref, computed, watch, unref } from 'vue';
import { useAvatarsStore } from '@/store/avatars.store';
import { galleryFrames } from '@/lib/avatars/display';

/**
 * The open/closed state of a photo gallery shown in GalleryViewer: the
 * frames of `entries` (newest first) uploaded by `uploaderHash`, which frame
 * is shown, and a viewer that follows the gallery as it changes — a removed
 * last frame steps back, an empty gallery closes it.
 */
export function useGalleryViewer(entries, uploaderHash) {
	const $avatars = useAvatarsStore();
	const index = ref(null);
	const frames = computed(() => galleryFrames(unref(entries) ?? [], unref(uploaderHash), $avatars.photoUrl));

	const show = (i) => { index.value = i; };
	/** Opens at the photo `avatarId`, or at the newest. */
	const open = (avatarId = null) => {
		const list = unref(entries) ?? [];
		if (list.length) index.value = Math.max(0, list.findIndex((e) => e.avatarId === avatarId));
	};
	const close = () => { index.value = null; };

	watch(() => frames.value.length, (length) => {
		if (index.value === null) return;
		if (!length) index.value = null;
		else if (index.value >= length) index.value = length - 1;
	});

	return { index, frames, show, open, close };
}

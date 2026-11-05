<template>
	<!-- The account's photo gallery: the current photo in the circle, a tap
	     opens every photo newest first, where an older one can be set as the
	     avatar again or taken out. Each change goes to the account's dialogs
	     at once (avatars.store). -->
	<div class="_avatar">
		<div class="_img_wrap" :class="{ _pointer: gallery.length }" :role="gallery.length ? 'button' : undefined"
			:aria-label="gallery.length ? 'Open your photos' : undefined" @click="viewer.open()">
			<img v-if="currentSrc" :src="currentSrc" alt="Profile photo" />
			<Avatar v-else :name="userHash || 'User'" variant="bauhaus" />
		</div>

		<button type="button" class="_edit" title="Add a photo" aria-label="Add a photo" :disabled="busy"
			@click="$refs.photoInput.click()">
			<i class="_icon_edit"></i>
		</button>
		<input class="_hidden" ref="photoInput" type="file" :accept="ALLOWED_IMAGE_TYPES.join(',')" @change="pickPhoto" />
	</div>
	<button v-if="gallery.length > 1" type="button" class="_photo_count ui-caption" @click="viewer.open()">
		{{ gallery.length }} photos
	</button>

	<GalleryViewer v-if="viewerIndex !== null && frames.length" :frames="frames" :index="viewerIndex" count-join="of"
		@update:index="viewer.show" @close="viewer.close">
		<template #actions="{ frame, index }">
			<button type="button" class="btn btn-light btn-sm rounded-pill" :disabled="busy || index === 0"
				@click="run(() => $avatars.setMain(frame.key), 'Set as main')">
				{{ index === 0 ? 'Current photo' : 'Set as main' }}
			</button>
			<button type="button" class="btn btn-danger btn-sm rounded-pill" :disabled="busy"
				@click="removeFrame(frame.key)">Remove</button>
		</template>
	</GalleryViewer>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._avatar {
	position: relative;
	flex-shrink: 0;
	width: 80px;
	height: 80px;

	@include media-breakpoint-up(md) {
		width: 88px;
		height: 88px;
	}
}

._img_wrap {
	width: 100%;
	height: 100%;
	border-radius: 50%;
	overflow: hidden;

	img,
	svg {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
}

._edit {
	position: absolute;
	right: -2px;
	bottom: -2px;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border: 2px solid var(--color-surface);
	border-radius: 50%;
	background: var(--color-ink);
	cursor: pointer;

	i { width: 16px; height: 16px; background-color: var(--color-text-on-dark); }
	&:disabled { opacity: 0.4; cursor: default; }
	&:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
}

._photo_count {
	margin-top: var(--space-1);
	padding: 0;
	border: 0;
	background: none;
	color: var(--color-text-secondary);
}
</style>

<script setup>
import { ref, computed, inject } from 'vue';
import Avatar from 'vue-boring-avatars';
import GalleryViewer from '@/components/GalleryViewer.vue';
import { useAvatarsStore } from '@/store/avatars.store';
import { userPQStore } from '@/store/userPQ.store';
import { useGalleryViewer } from '@/composables/useGalleryViewer';
import { ALLOWED_IMAGE_TYPES, AVATAR_MAX_SIDE } from '@/lib/avatars/gallery';
import { resizeImageUrl } from '@/utils/imageResize';
import errorMessage from '@/utils/errorMessage';

const $swal = inject('$swal');
const $avatars = useAvatarsStore();
const $userPQ = userPQStore();

const userHash = computed(() => $userPQ.currentUserHash);
const gallery = computed(() => $avatars.ownGallery);
const busy = ref(false);
const viewer = useGalleryViewer(gallery, userHash);
const { index: viewerIndex, frames } = viewer;

// The circle draws the decrypted current photo, or until it arrives the
// copy this device keeps for the menu.
const currentSrc = computed(() => {
	const current = gallery.value[0];
	return (current && $avatars.photoUrl(current.photo, userHash.value)) || $userPQ.currentUser?.avatar || '';
});

// Another device may have changed the gallery since this one read it.
$avatars.loadOwn({ fresh: true }).catch((e) => console.warn('[profile] gallery not loaded:', e?.message ?? e));

/** Runs a gallery change and says what came of it: shared, owed for later, or why not. */
const run = async (change, title) => {
	busy.value = true;
	try {
		const { shared } = await change();
		if (shared !== 'published') {
			$swal.fire({
				icon: 'info',
				title,
				text: 'Saved. Your contacts see it once this device can reach the server again.',
			});
		}
	} catch (e) {
		console.error('[profile] gallery change failed:', e);
		$swal.fire({ icon: 'error', title, footer: errorMessage(e), timer: 15000 });
	} finally {
		busy.value = false;
	}
};

const removeFrame = (avatarId) => {
	if (!window.confirm('Remove this photo? People who already received it keep their copy.')) return;
	run(() => $avatars.removePhoto(avatarId), 'Remove photo');
};

const pickPhoto = async (event) => {
	const file = Array.from(event.target.files || [])[0];
	event.target.value = '';
	if (!file) return;
	if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
		$swal.fire({ icon: 'error', title: 'Add photo', text: `"${file.name}" is not a supported picture format` });
		return;
	}
	const source = URL.createObjectURL(file);
	try {
		const { blobFile } = await resizeImageUrl(source, AVATAR_MAX_SIDE, 0.85);
		await run(() => $avatars.addPhoto(blobFile), 'Add photo');
	} catch (e) {
		$swal.fire({ icon: 'error', title: 'Add photo', footer: errorMessage(e) });
	} finally {
		URL.revokeObjectURL(source);
	}
};
</script>

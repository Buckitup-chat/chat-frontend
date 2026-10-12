<template>
	<!-- The account's photo gallery: the current photo in the circle, a tap
	     opens every photo newest first, where an older one can be set as the
	     avatar again or taken out. Each change goes to the account's dialogs
	     at once (avatars.store). -->
	<div class="_avatar">
		<div class="_wrap">
			<div class="_img_wrap" :class="{ _pointer: gallery.length }" :role="gallery.length ? 'button' : undefined"
				@click="openViewer(0)">
				<img v-if="currentSrc" :src="currentSrc" alt="Profile photo" />
				<Avatar v-else :name="userHash || 'User'" variant="bauhaus" />
			</div>

			<a href="#" class="btn btn-dark rounded-pill p-2" title="Add a photo" :class="{ disabled: busy }"
				@click.prevent="!busy && $refs.photoInput.click()">
				<i class="bg-white _icon_plus"></i>
			</a>
			<input class="_hidden" ref="photoInput" type="file" :accept="ALLOWED_IMAGE_TYPES.join(',')" @change="pickPhoto" />
		</div>
	</div>
	<div v-if="gallery.length > 1" class="_photo_count text-center small mt-1" role="button" @click="openViewer(0)">
		{{ gallery.length }} photos
	</div>

	<GalleryViewer v-if="viewerIndex !== null && frames.length" :frames="frames" :index="viewerIndex" count-join="of"
		@update:index="showFrame" @close="viewerIndex = null">
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
	display: flex;
	justify-content: center;
	width: 100%;

	._wrap {
		position: relative;

		._img_wrap {
			width: 10rem;
			height: 10rem;

			@include media-breakpoint-up(sm) {
				width: 14rem;
				height: 14rem;
			}

			border-radius: 50%;
			border: 5px solid $white;
			overflow: hidden;

			img,
			svg {
				height: 100%;
				width: 100%;
				object-fit: cover;
			}
		}

		a {
			position: absolute;
			bottom: 1rem;
			right: 5rem;
			transform: translateX(4rem);
		}
	}
}

._photo_count {
	color: $grey_dark;
}
</style>

<script setup>
import { ref, computed, inject, watch } from 'vue';
import Avatar from 'vue-boring-avatars';
import GalleryViewer from '@/components/GalleryViewer.vue';
import { useAvatarsStore } from '@/store/avatars.store';
import { userPQStore } from '@/store/userPQ.store';
import { AVATAR_MAX_SIDE } from '@/lib/avatars/gallery';
import { thumbDataUrl } from '@/lib/avatars/display';
import { resizeImageUrl } from '@/utils/imageResize';
import errorMessage from '@/utils/errorMessage';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const $swal = inject('$swal');
const $avatars = useAvatarsStore();
const $userPQ = userPQStore();

const userHash = computed(() => $userPQ.currentUserHash);
const gallery = computed(() => $avatars.ownGallery);
const busy = ref(false);
const viewerIndex = ref(null);

// The circle draws the decrypted current photo, or until it arrives the
// copy this device keeps for the menu.
const currentSrc = computed(() => {
	const current = gallery.value[0];
	return (current && $avatars.photoUrl(current.photo, userHash.value)) || $userPQ.currentUser?.avatar || '';
});

const load = (entry) => {
	if (entry) $avatars.loadPhoto(entry.photo, userHash.value).catch((e) => console.warn('[profile] photo not loaded:', e?.message ?? e));
};

// Another device may have changed the gallery since this one read it.
$avatars.loadOwn({ fresh: true }).catch((e) => console.warn('[profile] gallery not loaded:', e?.message ?? e));
watch(() => gallery.value[0], load, { immediate: true });

const frames = computed(() => gallery.value.map(({ avatarId, photo }) => ({
	key: avatarId,
	src: $avatars.photoUrl(photo, userHash.value),
	placeholder: thumbDataUrl(photo),
	alt: 'Profile photo',
})));

const showFrame = (index) => {
	viewerIndex.value = index;
	load(gallery.value[index]);
};
const openViewer = (index) => {
	if (gallery.value.length) showFrame(index);
};

// The viewer follows the gallery: a removed last frame steps back, an empty gallery closes it.
watch(() => gallery.value.length, (length) => {
	if (viewerIndex.value === null) return;
	if (!length) viewerIndex.value = null;
	else if (viewerIndex.value >= length) showFrame(length - 1);
});

/** Runs a gallery change and says what came of it: stored for sending, or why not. */
const run = async (change, title) => {
	busy.value = true;
	try {
		const { failed } = await change();
		if (failed.length) {
			$swal.fire({
				icon: 'warning',
				title,
				text: `Saved, but ${failed.length} ${failed.length === 1 ? 'conversation' : 'conversations'} could not be given the change: ${errorMessage(failed[0].error)}`,
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
	if (!window.confirm('Remove this photo? Contacts who already have it keep their copy.')) return;
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

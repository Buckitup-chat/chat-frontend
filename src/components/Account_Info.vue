<template>
	<div class=" " v-if="account">
		<div class="_avatar">
			<div class="_wrap">
				<div class="_img_wrap">
					<Avatar :name="account.user_hash || 'User'" variant="bauhaus" v-if="!avatarDataUrl && !account.avatar" />

					<img :src="avatarDataUrl || account.avatar" v-if="avatarDataUrl || account.avatar" />
				</div>

				<a href="#" class="btn btn-dark rounded-pill p-2" @click.prevent="$refs.avatarImageInput.click()">
					<i class="bg-white" :class="[avatarDataUrl || account.avatar ? '_icon_edit' : '_icon_plus']"></i>
				</a>
				<input class="_hidden" ref="avatarImageInput" type="file" :accept="ALLOWED_IMAGE_TYPES.join(',')"
					@change="handleImage($event)" />
			</div>
		</div>

		<div class="_input_block mt-3">
			<div class="mb-2">
				<label for="name" class="form-label">
					Name
					<span class="small ms-1 opacity-50" v-if="!account.name">({{ maxNameLength }} characters max)</span>
				</label>
				<input class="form-control" id="name" placeholder="any name you want" type="text" rows="1"
					v-model="account.name" :class="{ 'fw-bold': account.name }" />
			</div>

			<div class="mb-2">
				<label for="notes" class="form-label">
					Notes
					<span class="small ms-1 opacity-50" v-if="!account.notes">({{ maxNotesLength }} characters max)</span>
				</label>
				<textarea id="notes" class="form-control" placeholder="private note" type="text" rows="2"
					v-model="account.notes"></textarea>
			</div>

			<div class="mb-2" v-if="account.user_hash">
				<label class="form-label d-flex justify-content-between">
					<div>User hash</div>
					<div class="d-flex align-items-center">
						<div>
							{{ $filters.txHashShort(account.user_hash) }}
						</div>

						<i class="_icon_copy bg-black ms-2 _pointer" @click="copyUserHash()"></i>
					</div>
				</label>
			</div>
		</div>
	</div>
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
</style>

<script setup>

import { ref, onMounted, watch, inject } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useLoader } from '@/composables/useLoader';
import imageResize from '@/utils/imageResize';
import errorMessage from '@/utils/errorMessage';
import copyToClipboard from '@/utils/copyToClipboard';
import Avatar from 'vue-boring-avatars';

const $swal = inject('$swal');
const $mitt = inject('$mitt');
const $loader = useLoader();
const $user = userPQStore();
const $em = inject('$encryptionManagerPQ');

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const maxNameLength = 30;
const maxNotesLength = 300;

const emit = defineEmits(['update', 'avatar-draft']);
const account = ref();
const avatarDataUrl = ref(null);
const avatarUuid = ref(null);

const { accountIn } = defineProps({
	accountIn: { type: Object },
});

onMounted(async () => {
	account.value = JSON.parse(JSON.stringify(accountIn));

	if (accountIn?.avatarUuid) {
		await loadAvatarFromStorage(accountIn.avatarUuid);
	}

	watch(
		() => accountIn,
		async (newVal) => {
			if (newVal) {
				account.value = JSON.parse(JSON.stringify(accountIn));
				if (accountIn?.avatarUuid && accountIn.avatarUuid !== avatarUuid.value) {
					await loadAvatarFromStorage(accountIn.avatarUuid);
				}
			}
		},
		{ deep: true },
	);

	watch(account, (newVal) => {
		if (newVal.name && newVal.name.length > maxNameLength) {
			newVal.name = newVal.name.slice(0, maxNameLength);
		}
		if (newVal.notes && newVal.notes.length > maxNotesLength) {
			newVal.notes = newVal.notes.slice(0, maxNotesLength);
		}
		emit('update', newVal);
	}, { deep: true });
});

async function loadAvatarFromStorage(uuid) {
	if (!uuid || !$em) return;
	try {
		const blob = await $em.loadAvatar(uuid);
		if (blob) {
			avatarDataUrl.value = URL.createObjectURL(blob);
			avatarUuid.value = uuid;
		}
	} catch (error) {
		console.error('Failed to load avatar:', error);
	}
}

const reset = () => {
	account.value = JSON.parse(JSON.stringify(accountIn));
	avatarDataUrl.value = null; // reset preview
};

const copyUserHash = () => {
	if (account.value.user_hash === $user.currentUserHash) {
		$mitt.emit('swal::open', { id: 'copy_public_key' });
	} else {
		copyToClipboard(account.value.user_hash);
	}
};

const handleImage = async (event) => {
	event.preventDefault();
	$loader.show();
	try {
		const file = Array.from(event.target.files)[0];
		if (!ALLOWED_IMAGE_TYPES.includes(file.type)) throw Error(`"${file.name}" not supported media format`);
		var reader = new FileReader();
		reader.onload = function (readerEvent) {
			var image = new Image();
			image.onload = async function () {
				const { dataUrl, blobFile } = imageResize(image, 300, 0.8);
				if (dataUrl && blobFile) {
					avatarDataUrl.value = dataUrl;
					account.value.avatar = dataUrl; // for comparison in parent
					emit('avatar-draft', blobFile);
					emit('update', account.value);
				}
				$loader.hide();
			};
			image.src = readerEvent.target.result;
		};
		reader.readAsDataURL(file);
	} catch (error) {
		console.error(error);

		$swal.fire({
			icon: 'error',
			title: 'Avatar upload',
			footer: errorMessage(error),
			timer: 15000,
		});

		$loader.hide();
	}

	event.target.value = '';
};

defineExpose({ reset });
</script>

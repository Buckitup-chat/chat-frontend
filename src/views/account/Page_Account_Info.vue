<template>
	<FullContentBlock v-if="accountIn">
		<template #header>
			<div class="fw-bold fs-5 py-1">Identity</div>
		</template>
		<template #content>
			<div class="_full_width_block">
				<Account_Info :account-in="accountIn" ref="accountInfo" @update="handleUpdate"
					@avatar-draft="handleAvatarDraft" />

				<div class="mt-3 text-center">
					<Transition name="slide-fade">
						<button v-if="hasChanges" :disabled="!hasChanges" class="btn btn-primary rounded-pill w-100 fw-bold"
							@click="saveProfile">
							Save Changes
						</button>
					</Transition>
				</div>

				<div class="d-flex justify-content-center align-items-center mt-4 mb-3">
					<!-- TODO: PQ - account_dxos_invite modal needs PQ implementation (Coming Soon) -->
					<button type="button" class="btn btn-dark rounded-pill _action_btn"
						@click="$mitt.emit('modal::open', { id: 'account_dxos_invite' })">
						<i class="_icon_reload bg-white"></i>
					</button>


					<button type="button" class="btn btn-dark rounded-pill _action_btn"
						@click="$mitt.emit('modal::open', { id: 'account_backup' })">
						<i class="_icon_backups bg-white"></i>
					</button>

					<button type="button" class="btn btn-dark rounded-pill _action_btn" @click="sharePublicKey()">
						<i class="_icon_share bg-white"></i>
					</button>

					<button type="button" class="btn btn-dark rounded-pill _action_btn" @click="deleteAccount()">
						<i class="_icon_delete bg-white"></i>
					</button>
				</div>
			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._full_width_block {
	max-width: 30rem;
	width: 100%;
}

._action_btn {
	padding: 0.8rem;

	@include media-breakpoint-up(sm) {
		padding: 1.2rem;
	}

	margin-left: 0.3rem;
	margin-right: 0.3rem;

	i {
		height: 1.5rem;
		width: 1.5rem;
	}
}

.slide-fade-enter-active {
	transition: all 0.4s ease-out;
}

.slide-fade-leave-active {
	transition: all 0.3s cubic-bezier(1, 0.5, 0.8, 1);
}

.slide-fade-enter-from,
.slide-fade-leave-to {
	opacity: 0;
}
</style>

<script setup>
import { userPQStore } from '@/store/userPQ.store';


// TODO: PQ - This page is already adapted for PQ user data
// Future: Add contact management, settings, etc.

import { inject, computed, ref } from 'vue';
import Account_Info from '@/components/Account_Info.vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
import copyToClipboard from '@/utils/copyToClipboard';

const $userPQ = userPQStore();
const $swal = inject('$swal');
const $swalModal = inject('$swalModal');
const $router = inject('$router');
const $mitt = inject('$mitt');
const $em = inject('$encryptionManagerPQ');

const accountInfoRef = ref(null);
const draftAccount = ref(null);
const draftAvatarBlob = ref(null);

const accountIn = computed(() => {
	const u = $userPQ.currentUser;
	if (!u) return null;
	return {
		user_hash: u.user_hash,
		name: u.name,
		avatarUuid: u.userStorage?.avatarUuid,
		notes: u.userStorage?.notes,
		sign_pkey: u.sign_pkey
	};
});

function handleUpdate(acc) {
	draftAccount.value = acc;
}

function handleAvatarDraft(blob) {
	draftAvatarBlob.value = blob;
}

const hasChanges = computed(() => {
	if (!accountIn.value || !draftAccount.value) return false;
	const acc = draftAccount.value;
	return acc.name !== accountIn.value.name ||
		acc.notes !== accountIn.value.notes ||
		acc.avatarUuid !== accountIn.value.avatarUuid ||
		draftAvatarBlob.value !== null;
});

async function saveProfile() {
	if (!hasChanges.value) return;

	try {
		let uuid = draftAccount.value.avatarUuid;

		if (draftAvatarBlob.value) {
			uuid = await $em.encryptAndStoreAvatar(draftAvatarBlob.value);
			draftAvatarBlob.value = null;
		}

		await $userPQ.updateCurrentUserProfile({
			name: draftAccount.value.name,
			notes: draftAccount.value.notes,
			avatarUuid: uuid,
			avatarDataUrl: draftAccount.value.avatar
		});
	} catch (e) {
		// The write survives locally; what failed is server sync — say so
		// instead of pretending the save fully succeeded (review finding 12)
		console.error('[account] profile save failed:', e);
		$swal.fire({
			icon: 'error',
			title: 'Profile not synced',
			text: 'Changes are saved on this device but could not reach the server. They will not appear on your other devices yet.',
		});
	}
}

function sharePublicKey() {
	if (accountIn.value?.sign_pkey) {
		copyToClipboard(accountIn.value.sign_pkey);
		$mitt.emit('swal::open', { id: 'copy_public_key' });
	}
}

const deleteAccount = async () => {
	if (!(await $swalModal.value.open({ id: 'delete_account', data: $userPQ.currentUser }))) return;

	$router.push({ name: 'login' });
};
</script>

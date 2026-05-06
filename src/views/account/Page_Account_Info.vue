<template>
	<FullContentBlock v-if="accountIn">
		<template #header>
			<div class="fw-bold fs-5 py-1">Identity</div>
		</template>
		<template #content>
			<div class="_full_width_block">
				<Account_Info :account-in="accountIn" ref="accountInfo" @update="updateAccount" />

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

				<div class="mt-4 p-3 bg-light rounded">
					<div class="small text-muted mb-2">User Hash</div>
					<div class="text-break" style="word-break: break-all; font-size: 0.8rem;">
						{{ accountIn.user_hash }}
					</div>
				</div>

				<div class="mt-3 p-3 bg-light rounded">
					<div class="small text-muted mb-2">Sign Public Key</div>
					<div class="text-break" style="word-break: break-all; font-size: 0.7rem;">
						{{ accountIn.sign_pkey }}
					</div>
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
</style>

<script setup>
// TODO: PQ - This page is already adapted for PQ user data
// Future: Add contact management, settings, etc.

import { inject, computed } from 'vue';
import Account_Info from '@/components/Account_Info.vue';
import FullContentBlock from '@/components/FullContentBlock.vue';
import copyToClipboard from '@/utils/copyToClipboard';

const $userPQ = inject('$userPQ');
const $swalModal = inject('$swalModal');
const $router = inject('$router');
const $mitt = inject('$mitt');

const accountIn = computed(() => {
	const u = $userPQ.currentUser;
	if (!u) return null;
	return {
		user_hash: u.user_hash,
		name: u.name,
		avatar: u.userStorage?.avatar,
		notes: u.userStorage?.notes,
		sign_pkey: u.sign_pkey
	};
});

async function updateAccount(acc) {
	await $userPQ.updateCurrentUserProfile({
		name: acc.name,
		notes: acc.notes,
		avatar: acc.avatar,
		avatarUuid: acc.avatarUuid
	});
}

function sharePublicKey() {
	if (accountIn.value?.sign_pkey) {
		copyToClipboard(accountIn.value.sign_pkey);
		$mitt.emit('swal::open', { id: 'copy_public_key' });
	}
}

const deleteAccount = async () => {
	if (!(await $swalModal.value.open({ id: 'delete_account' }))) return;

	await $userPQ.logout();
	$router.push({ name: 'login' });
};
</script>

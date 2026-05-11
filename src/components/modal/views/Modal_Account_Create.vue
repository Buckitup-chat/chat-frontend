<template>
	<!-- Header -->
	<div class="p-2">
		<Account_Info :account-in="account" @update="updateAccount" @avatar-draft="account.draftAvatar = $event" class="mb-3" v-if="account" />
		<div class="row justify-content-center gx-2 mt-3">
			<div class="col-lg-12 col-xl-10">
				<button type="button" class="btn btn-dark w-100" @click="create()" :disabled="creating">
					<span v-if="creating">Creating...</span>
					<span v-else>Create</span>
				</button>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped></style>

<script setup>
import { ref, inject } from 'vue';
import Account_Info from '@/components/Account_Info.vue';

const $userPQ = inject('$userPQ');
const $mitt = inject('$mitt');
const $router = inject('$router');

const creating = ref(false);
const account = ref({
	name: '',
	notes: '',
	avatar: null,
	draftAvatar: null,
	user_hash: null,
	sign_pkey: null
});

const updateAccount = (data) => {
	account.value.name = data.name || '';
	account.value.notes = data.notes || '';
	account.value.avatar = data.avatar || null;
};

const create = async () => {
	if (creating.value) return;
	creating.value = true;
	try {
		// TODO: PQ Registration - commented out old Web3 code
		// await $encryptionManager.createVault({
		// 	keyOptions: {
		// 		username: account.value.name,
		// 		displayName: account.value.name,
		// 	},
		// 	address: account.value.address,
		// 	publicKey: account.value.publicKey,
		// 	avatar: account.value.avatar,
		// 	notes: account.value.notes,
		// });

		// $user.account = await $user.generateAccount(account.value.privateKey);

		// await $encryptionManager.setData($user.toVaultFormat());

		// await $user.openStorage({
		// 	accountInfo: {
		// 		name: account.value.name,
		// 		notes: account.value.notes,
		// 		avatar: account.value.avatar,
		// 	},
		// });

		await $userPQ.registerNewUser({
			name: account.value.name || 'Anonymous',
			notes: account.value.notes,
			avatar: account.value.draftAvatar,
			avatarDataUrl: account.value.avatar
		});

		$mitt.emit('account::created');
		$mitt.emit('modal::close');
		$router.replace({ name: 'account_info' });
	} catch (error) {
		console.error('create error', error);
	} finally {
		creating.value = false;
	}
};
</script>

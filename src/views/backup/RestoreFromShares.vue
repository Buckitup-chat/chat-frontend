<template>
	<div>
		<template v-if="!secretText">
			<div class="_divider mb-2">
				Provide shares
				<InfoTooltip class="align-self-center ms-2" :content="'To restore secret you must provide required number of shares backup was created with (Restore treshold)'" />
			</div>

			<div class="_input_block">
				<div class="mb-2" v-for="(share, idx) in shares">
					<div class="d-flex justify-content-between align-items-center">
						<div class="fw-bold mb-1">Share # {{ idx + 1 }}</div>
						<i class="_icon_times bg-dark _pointer" @click="shares.splice(idx, 1)" v-if="shares.length > 1"></i>
					</div>
					<textarea class="form-control" rows="3" placeholder="decrypted share from trusted partie" v-model="shares[idx]"></textarea>
				</div>
			</div>

			<div class="row justify-content-center gx-2 mt-3">
				<div class="col-lg-12 col-xl-10 mb-2">
					<button type="button" class="btn btn-dark w-100" @click="shares.push('')">Add share</button>
				</div>
				<div class="col-lg-12 col-xl-10 mb-2">
					<button type="button" class="btn btn-dark w-100" @click="recover()" :disabled="!shares.find((v) => v?.trim().length)">Restore</button>
				</div>
			</div>
		</template>

		<template v-if="secretText && !accountToRecover">
			<div class="_divider mb-2">Restored secret</div>

			<div class="_input_block text-break">
				{{ secretText }}
			</div>

			<div class="row justify-content-center gx-2 mt-2">
				<div class="col-lg-12 col-xl-10">
					<button type="button" class="btn btn-dark w-100" @click="copyToClipboard(secretText)">Copy</button>
				</div>
			</div>
		</template>

		<div class="row justify-content-center gx-2" v-if="accountToRecover">
			<div class="_divider mb-3">
				{{ isInVault ? 'Existing account' : 'Account found' }}
			</div>
			<div class="fs-4 mb-4 text-center">
				<span class="fw-bold">{{ accountToRecover.name ? accountToRecover.name : 'Unnamed' }}</span>
				<span class="text-secondary ms-2" v-if="accountToRecover.user_hash">[{{ accountToRecover.user_hash.slice(0, 8) }}]</span>
			</div>

			<div class="col-30 col-md-20">
				<button type="button" class="btn btn-dark btn-lg w-100" @click="addAccount()">
					{{ isInVault ? 'Overwrite account' : 'Restore account' }}
				</button>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
//@import '@/scss/variables.scss';
</style>

<script setup>
import { ref, onMounted, inject, computed } from 'vue';
import errorMessage from '@/utils/errorMessage';
import copyToClipboard from '@/utils/copyToClipboard';

const shares = ref([]);
const $web3 = inject('$web3');
const $swal = inject('$swal');
const $userPQ = inject('$userPQ');
const $appstate = inject('$appstate');
const $swalModal = inject('$swalModal');
const $router = inject('$router');

const secretText = ref();
const accountToRecover = ref();
const backupKeys = ref();

const emit = defineEmits(['restore', 'account']);

onMounted(async () => {
	if ($appstate.value.shareToRestore) {
		shares.value.push($appstate.value.shareToRestore);
		$appstate.value.shareToRestore = null;
	} else {
		shares.value.push('');
	}
});

const isInVault = computed(() => {
	return $userPQ.myLocalUsers.find((e) => e.user_hash === accountToRecover.value.user_hash);
});

const addAccount = async () => {
	try {
		if (isInVault.value) {
			const confirmed = await $swalModal.value.open({
				id: 'confirm',
				title: 'Account restore',
				content: `
                    Account <strong>${accountToRecover.value.name}</strong> already present on this device.
                    <br> Are you sure you want to replace it with one from backup?
                    `,
			});
			if (!confirmed) return;
		}

		await $userPQ.importBackup({ identity: accountToRecover.value, keys: backupKeys.value });

		$router.replace({ name: 'chats_home' });

	} catch (error) {
		console.error(error);
		$swal.fire({
			icon: 'error',
			title: 'Recover error',
			footer: errorMessage(error),
			timer: 30000,
		});
	}

	emit('account');
};

const recover = () => {
	try {
		secretText.value = $web3.bukitupClient.recoverSecret(shares.value.filter((v) => v?.trim().length));
		emit('restore', secretText.value);
		checkAccountRestore(secretText.value);
	} catch (error) {
		console.error(error);
		$swal.fire({
			icon: 'error',
			title: 'Recover error',
			footer: errorMessage(error),
			timer: 30000,
		});
	}
};

const checkAccountRestore = async (s) => {
	try {
		const decoded = JSON.parse(s);
		if (decoded.identity && decoded.keys) {
			accountToRecover.value = decoded.identity;
			backupKeys.value = decoded.keys;
		}
	} catch (error) {
		console.error(error);
	}
};
</script>

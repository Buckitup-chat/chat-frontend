<template>
	<div>
		<template v-if="!secretText">
			<div class="_divider mb-2 mt-3">
				Provide shares
				<InfoTooltip class="align-self-center ms-2" :content="'To restore secret you must provide required number of shares backup was created with (Restore threshold)'" />
			</div>

			<div class="_input_block">
				<div class="mb-2" v-for="(share, idx) in shares" :key="idx">
					<div class="d-flex justify-content-between align-items-center">
						<div class="fw-bold mb-1">Share # {{ idx + 1 }}</div>
						<i class="_icon_times bg-dark _pointer" @click="shares.splice(idx, 1)" v-if="shares.length > 1"></i>
					</div>
					<textarea class="form-control" rows="3" placeholder="decrypted share from trusted party" v-model="shares[idx]"></textarea>
				</div>
			</div>

			<div class="row justify-content-center gx-2 mt-3">
				<div class="col-lg-12 col-xl-10 mb-2">
					<button type="button" class="btn btn-outline-dark w-100" @click="shares.push('')">Add share</button>
				</div>
				<div class="col-lg-12 col-xl-10 mb-2">
					<button type="button" class="btn btn-dark w-100" @click="recover()" :disabled="!shares.find((v) => v?.trim().length) || processing">
						<span v-if="processing" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
						Restore
					</button>
				</div>
			</div>
		</template>

		<template v-if="secretText && !accountToRecover">
			<div class="_divider mb-2 mt-3">Restored secret</div>
			<div class="alert alert-warning small">
				The combined secret is not a valid BukItUp account backup.
			</div>
			<div class="_input_block text-break">
				{{ secretText }}
			</div>

			<div class="row justify-content-center gx-2 mt-3">
				<div class="col-lg-12 col-xl-10">
					<button type="button" class="btn btn-dark w-100" @click="copyToClipboard(secretText)">Copy Text</button>
				</div>
			</div>
		</template>

		<div class="row justify-content-center gx-2 mt-3" v-if="accountToRecover">
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
const $mitt = inject('$mitt');

const secretText = ref();
const accountToRecover = ref();
const backupKeys = ref();
const processing = ref(false);

onMounted(async () => {
	if ($appstate.value.shareToRestore) {
		shares.value.push($appstate.value.shareToRestore);
		$appstate.value.shareToRestore = null;
	} else {
		shares.value.push('');
	}
});

const isInVault = computed(() => {
	return $userPQ.myLocalUsers?.find((e) => e.user_hash === accountToRecover.value?.user_hash);
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

		$mitt.emit('account::created');
		$mitt.emit('modal::close');
		$router.replace({ name: 'account_info' });
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

const recover = async () => {
	try {
		processing.value = true;
		await new Promise(r => setTimeout(r, 100));

		const validShares = shares.value.filter((v) => v?.trim().length).map(v => v.trim());
		if (validShares.length < 2) {
			throw new Error('Provide at least 2 shares to restore.');
		}

		secretText.value = $web3.bukitupClient.recoverSecret(validShares);
		if (!secretText.value) throw new Error('Recovery returned empty result');

		await checkAccountRestore(secretText.value);
	} catch (error) {
		console.error(error);
		$swal.fire({
			icon: 'error',
			title: 'Recover error',
			text: error.message || 'Check if you provided enough valid shares.',
			footer: errorMessage(error),
			timer: 30000,
		});
	} finally {
		processing.value = false;
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
<template>
	<!-- Header -->

	<div class="mb-1 mt-2 text-center fs-5">Account will be completely wiped from this device</div>
	<div class="mb-3 text-center text-danger">Make sure you made backup before continue</div>
	<div v-if="keptBytes" class="mb-3 text-center small">
		Files this account keeps on this device ({{ fmtSize(keptBytes) }}) will be removed too.
	</div>

	<div class="d-flex align-items-center justify-content-center">
		<div class="form-check form-switch mb-2">
			<input class="form-check-input" type="checkbox" role="switch" id="setpassword" v-model="confirmed" />
			<label class="form-check-label d-flex align-items-center _pointer small text-center" for="setpassword"> I understand that it will erase all data </label>
		</div>
	</div>

	<div class="border-bottom opacity-75 my-2"></div>

	<div class="d-flex justify-content-center mt-3">
		<button type="button" class="btn btn-outline-dark" @click="cancel()">
			<trn k="tx_confirm.cancel"> Cancel </trn>
		</button>
		<button type="button" class="btn btn-dark ms-2" @click="backup()" v-if="$user.account">
			<trn k="tx_confirm.cancel"> Backup </trn>
		</button>
		<button type="button" class="btn btn-danger ms-2 px-4" @click="confirm()" :disabled="!confirmed">
			<trn k="tx_confirm.ok"> Delete </trn>
		</button>
	</div>
</template>

<script setup>
import { userStore } from '@/store/user.store';
import { userPQStore } from '@/store/userPQ.store';


import { inject, onMounted, ref } from 'vue';
import errorMessage from '@/utils/errorMessage';

const $user = userStore();
const $userPQ = userPQStore();
const $encryptionManager = inject('$encryptionManager');
const $mitt = inject('$mitt');
const $swal = inject('$swal');

const confirmed = ref();
const keptBytes = ref(0);

const { data } = defineProps({
	data: { type: Object, required: true },
});

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// What "Keep on this device" holds for the account goes with it; the size is
// read from the chunk pins, which need no key.
onMounted(async () => {
	const hash = data?.user_hash || $userPQ.currentUser?.user_hash;
	if (!hash) return;
	try {
		keptBytes.value = await (await import('@/lib/data/chunkCache')).pinnedBytesOf(hash);
	} catch (e) {
		console.warn('Could not read the size of the account\'s kept files', e);
	}
});

function cancel() {
	$mitt.emit('swal::close', false);
}

function backup() {
	$mitt.emit('swal::close', false);
	$mitt.emit('modal::open', { id: 'account_backup', showLocal: true });
}

async function confirm() {
	$mitt.emit('swal::close', 'ok');
	try {
		if (data?.user_hash || $userPQ.currentUser?.user_hash) {
			const hash = data?.user_hash || $userPQ.currentUser?.user_hash;
			await $userPQ.deleteAccount(hash);
		} else {
			await $encryptionManager.removeVault();
			await $user.logout();
			$user.vaults = await $encryptionManager.getVaults();
		}

		$swal.fire({
			icon: 'success',
			title: 'Account deleted',
			timer: 5000,
		});
	} catch (error) {
		console.error(error);
		$swal.fire({
			icon: 'error',
			title: 'Recover error',
			footer: errorMessage(error),
			timer: 30000,
		});
	}
}
</script>

<template>
	<!-- Header -->

	<div class="mb-1 mt-2 text-center fs-5">Account will be completely wiped from this device</div>
	<div class="mb-3 text-center text-danger">Make sure you made backup before continue</div>
	<div v-if="keptBytes" class="mb-3 text-center small">
		Files only this account keeps on this device ({{ fileSize(keptBytes) }}) will be removed too.
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
		<button type="button" class="btn btn-dark ms-2" @click="backup()" v-if="canBackUp">
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


import { computed, inject, onMounted, ref } from 'vue';
import errorMessage from '@/utils/errorMessage';
import { fileSize } from '@/utils/formatBytes';

const $user = userStore();
const $userPQ = userPQStore();
const $encryptionManager = inject('$encryptionManager');
const $mitt = inject('$mitt');
const $router = inject('$router');
const $swal = inject('$swal');

const confirmed = ref();
const keptBytes = ref(0);

const { data } = defineProps({
	data: { type: Object, required: true },
});

// The account to wipe: the one the dialog was opened for ({ id, data: account }), or the signed-in one.
const targetHash = computed(() => data?.data?.user_hash || $userPQ.currentUser?.user_hash);
// Only the signed-in account can be backed up: its keys are the open ones.
const canBackUp = computed(() => !!targetHash.value && targetHash.value === $userPQ.currentUser?.user_hash);

// What "Keep on this device" holds for the account goes with it; the size is
// read from the chunk pins, which need no key. A chunk another account keeps
// stays, so it is not counted.
onMounted(async () => {
	if (!targetHash.value) return;
	try {
		keptBytes.value = await (await import('@/lib/data/chunkCache')).soleKeptBytesOf(targetHash.value);
	} catch (e) {
		console.warn('Could not read the size of the account\'s kept files', e);
	}
});

function cancel() {
	$mitt.emit('swal::close', false);
}

function backup() {
	$mitt.emit('swal::close', false);
	$mitt.emit('modal::close');
	$router.push({ name: 'account_backups' });
}

async function confirm() {
	// Read before closing: the dialog drops what it was opened with as it closes.
	const hash = targetHash.value;
	$mitt.emit('swal::close', 'ok');
	try {
		if (hash) {
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

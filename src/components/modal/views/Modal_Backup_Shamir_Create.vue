<template>
	<div>
		<div v-if="step === 1">
			<div class="_divider mt-3">
				Setup Threshold
				<InfoTooltip class="align-self-center ms-2" :content="'Select how many shares to create and how many are needed to restore.'" />
			</div>

			<div class="_input_block mt-3 px-3 py-2">
				<div class="mb-3">
					<label class="form-label d-flex justify-content-between align-items-center">
						<span>Total shares (n):</span>
						<span class="fw-bold fs-5">{{ totalShares }}</span>
					</label>
					<input type="range" class="form-range" min="2" max="10" step="1" v-model="totalShares" @input="onTotalSharesChange" />
				</div>

				<div class="mb-3">
					<label class="form-label d-flex justify-content-between align-items-center">
						<span>Threshold (t):</span>
						<span class="fw-bold fs-5">{{ threshold }}</span>
					</label>
					<input type="range" class="form-range" min="2" :max="totalShares" step="1" v-model="threshold" />
				</div>

				<div class="alert alert-warning small">
					<i class="_icon_info me-1"></i>
					If you lose {{ totalShares - threshold + 1 }} or more shares, your account cannot be restored.
				</div>
			</div>

			<div class="row justify-content-center gx-2 mt-4">
				<div class="col-md-20">
					<button class="btn btn-dark w-100" @click="generateShares" :disabled="processing">
						<span v-if="processing" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
						Generate Shares
					</button>
				</div>
			</div>
		</div>

		<div v-if="step === 2">
			<div class="_divider mt-3">
				Your Shares
				<InfoTooltip class="align-self-center ms-2" :content="'Save these shares securely. You need ' + threshold + ' out of ' + totalShares + ' to restore.'" />
			</div>

			<div class="alert alert-info small mt-2">
				Store each share in a different secure location or give to trusted contacts.
			</div>

			<div class="_shares_list mt-3">
				<div v-for="(share, index) in generatedShares" :key="index" class="mb-3 p-2 border rounded position-relative">
					<div class="small fw-bold mb-1">Share {{ index + 1 }}</div>
					<textarea class="form-control form-control-sm" rows="3" readonly :value="share"></textarea>
					<button class="btn btn-sm btn-outline-dark position-absolute top-0 end-0 m-2" @click="copyShare(share)">
						Copy
					</button>
				</div>
			</div>

			<div class="row justify-content-center gx-2 mt-4">
				<div class="col-md-20">
					<button class="btn btn-dark w-100" @click="finish">Done</button>
				</div>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
._shares_list {
	max-height: 400px;
	overflow-y: auto;
}
</style>

<script setup>
import { web3Store } from '@/store/web3.store';

import { userPQStore } from '@/store/userPQ.store';


import { inject, ref } from 'vue';
import copyToClipboard from '@/utils/copyToClipboard';

const $userPQ = userPQStore();
const $web3 = web3Store();
const $swal = inject('$swal');
const $mitt = inject('$mitt');

const step = ref(1);
const totalShares = ref(5);
const threshold = ref(3);
const processing = ref(false);
const generatedShares = ref([]);

const onTotalSharesChange = () => {
	if (threshold.value > totalShares.value) {
		threshold.value = totalShares.value;
	}
};

const copyShare = (share) => {
	copyToClipboard(share);
	$swal.fire({
		icon: 'success',
		title: 'Copied',
		timer: 1500,
		showConfirmButton: false,
	});
};

const generateShares = async () => {
	processing.value = true;
	await new Promise(r => setTimeout(r, 100));

	try {
		const backup = await $userPQ.exportBackup();
		if (!backup) throw new Error('Unable to export backup. Make sure you are logged in.');

		const secretStr = JSON.stringify(backup);
		generatedShares.value = $web3.bukitupClient.generateShares(secretStr, parseInt(totalShares.value), parseInt(threshold.value));
		
		if (!generatedShares.value?.length) throw new Error('No shares were generated');
		
		step.value = 2;
	} catch (e) {
		console.error(e);
		$swal.fire({
			icon: 'error',
			title: 'Error generating shares',
			text: e.message || 'Unknown error',
			timer: 8000,
		});
	} finally {
		processing.value = false;
	}
};

const finish = () => {
	$mitt.emit('modal::close');
};
</script>
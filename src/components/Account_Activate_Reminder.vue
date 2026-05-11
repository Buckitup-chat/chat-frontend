<template>
	<div v-if="showReminder">
		<div>
			<div class="_divider">
				Activate Your Profile
				<InfoTooltip class="align-self-center ms-2" :content="'Register meta address'" />
			</div>
			<div class="text-secondary text-center mb-3">Before creating backups or participating in backups of other users as
				trusted partie, register your meta address in on-chain public registry</div>

			<div class="row justify-content-center gx-2">
				<div class="col-lg-12 col-xl-10">
					<button type="button" class="btn btn-dark w-100"
						@click="$mitt.emit('modal::open', { id: 'account_activate' })">Activate</button>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, inject, onMounted } from 'vue';
import { deriveEvmAccount } from '@/utils/deriveEvmAccount';
import { web3Store } from '@/store/web3.store';

const $mitt = inject('$mitt');
const $userPQ = inject('$userPQ');

const showReminder = ref(true);

onMounted(async () => {
	const evmSkey = await $userPQ.getEvmPrivateKey();
	if (evmSkey) {
		const account = await deriveEvmAccount(evmSkey);
		const metaPublicKey = await web3Store().registryContract.metaPublicKeys(account.address);
		if (metaPublicKey && metaPublicKey.length > 2) {
			showReminder.value = false;
		}
	}
});
</script>

<template>
	<div class="px-3 pt-3 pb-3 d-flex flex-column gap-3" data-test="recover-friends">
		<div class="text-secondary">
			Lost every device? If you made a community backup, your guardians can bring you back.
		</div>
		<ol class="text-secondary small mb-0 ps-3">
			<li>This device makes a temporary account and shows a code for it.</li>
			<li>You call a guardian, give them the code, and read them ten words to prove it is you.</li>
			<li>Once enough guardians approve and the waiting period is over, their pieces come back and you are in your own account again.</li>
		</ol>
		<div class="small text-secondary">Still have a device signed in? Use <strong>Sync with other device</strong> instead: it is instant.</div>
		<div v-if="error" class="text-danger small" data-test="recover-error">{{ error }}</div>
		<button class="btn btn-dark w-100" :disabled="starting || !store.deployment" data-test="recover-start" @click="start">
			<span v-if="starting" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Start
		</button>
		<div v-if="!store.deployment" class="small text-secondary">This app names no network to recover on.</div>
		<div class="small text-secondary">Starting asks for a passkey for the temporary account.</div>
	</div>
</template>

<script setup>
// The login page's "Recover with friends" (plan § 7.5): what is about to
// happen, and the temporary account made from a tap — creating it makes a
// passkey, which needs a user gesture.
import { inject, ref } from 'vue';
import { useRecoveryRestoreStore } from '@/store/recoveryRestore.store';
import errorMessage from '@/utils/errorMessage';

const store = useRecoveryRestoreStore();
const $mitt = inject('$mitt');
const starting = ref(false);
const error = ref(null);

const start = async () => {
	starting.value = true;
	error.value = null;
	try {
		await store.begin();
		$mitt.emit('account::created');
		$mitt.emit('modal::close');
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		starting.value = false;
	}
};
</script>

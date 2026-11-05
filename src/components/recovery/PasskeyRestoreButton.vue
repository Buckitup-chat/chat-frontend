<template>
	<template v-if="store.prfSupport !== 'unsupported'">
		<p v-if="note" class="small-note">{{ note }}</p>
		<button :class="buttonClass" :disabled="busy" data-test="restore-with-passkey" @click="restoreWithPasskey">
			<span v-if="busy" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
			Restore with passkey
		</button>
	</template>
</template>

<script setup lang="ts">
import { inject, onMounted, ref } from 'vue';
import { usePasskeyRecoveryStore, passkeyRecoveryMessage } from '@/store/passkeyRecovery.store';
import { useRestoreAccount } from '@/composables/useRestoreAccount';
import errorMessage from '@/utils/errorMessage';
import type { Recovered } from '@/lib/recovery/passkeyRecovery';

type Swal = { fire: (options: { icon: string; title: string; text: string }) => unknown };

defineProps({
	buttonClass: { type: String, default: 'btn btn-outline-light w-100' },
	note: { type: String, default: '' },
});

const store = usePasskeyRecoveryStore();
const { restore } = useRestoreAccount();
const $swal = inject<Swal>('$swal')!;
const busy = ref(false);

onMounted(() => store.detectSupport());

const restoreWithPasskey = async () => {
	busy.value = true;
	let found: Recovered | null = null;
	try {
		const recovered = await store.recover();
		found = recovered;
		const restored = await restore(recovered.backup, { lock: recovered.prepared });
		if (!restored) recovered.prepared.seed.fill(0);
	} catch (e) {
		console.error('[passkey recovery] restore failed', e);
		found?.prepared.seed.fill(0);
		const [title, text] = passkeyRecoveryMessage(e) ?? ['The account could not be restored', errorMessage(e)];
		$swal.fire({ icon: 'error', title, text });
	} finally {
		busy.value = false;
	}
};
</script>

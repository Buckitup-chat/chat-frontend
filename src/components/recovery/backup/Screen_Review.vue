<template>
	<ScreenHeader :title="draft.reshare ? 'Renew your backup' : 'Create your backup'" :step="3" step-label="Review" back />

	<div class="cb-block">
		<div class="d-flex review-faces">
			<ContactAvatar v-for="g in draft.guardians.value" :key="g.userHash" :hash="g.userHash" />
		</div>
		<div class="cb-headline" data-test="review-headline">any {{ needed }} of {{ draft.guardians.value.length }}</div>
		<div class="cb-muted">
			{{ plural(s.spares, 'spare piece') }} · {{ s.nodeThreshold }} of {{ draft.nodes.value.length }} nodes<br />
			{{ durationAdjective(s.delaySec) }} wait · alerts: {{ draft.state.alerts.skipped && !draft.alertsConnected.value ? 'none' : alertsText(draft.alertChannels.value) }}<br />
			Network fee: {{ feeText(draft.feeChoice.value) }}
		</div>
	</div>

	<div v-if="draft.feeChoice.value === 'self' && draft.state.quote" class="cb-small">
		Estimated fee ≈ {{ amount(draft.state.quote.estimate) }} {{ CURRENCY }}, from your address {{ shortAddress(draft.state.quote.address) }}.
	</div>
	<div class="cb-muted">If fewer than {{ needed }} guardians keep their piece, the backup stops working. You will see it here.</div>

	<div v-if="error" class="cb-error" data-test="create-error">{{ error }}</div>
	<div class="cb-actions">
		<button class="btn btn-dark w-100" :disabled="!!blocked || creating" data-test="create" @click="create">
			<span v-if="creating" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>{{ draft.reshare ? 'Renew backup' : 'Create backup' }}
		</button>
		<div v-if="blocked" class="cb-small text-center">{{ blocked }}</div>
	</div>
</template>

<script setup>
import { computed, inject, onMounted, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { neededGuardians, plural } from '@/lib/recovery/backupPlan';
import errorMessage from '@/utils/errorMessage';
import ScreenHeader from './ScreenHeader.vue';
import ContactAvatar from './ContactAvatar.vue';
import { CURRENCY, DRAFT, NAV, alertsText, amount, durationAdjective, feeText, shortAddress } from './backupFlow';

const draft = inject(DRAFT);
const nav = inject(NAV);
const store = useRecoveryBackupStore();

const s = computed(() => draft.settings.value);
const needed = computed(() => neededGuardians(s.value));

// Paying yourself: the balance is read again right before Create.
onMounted(async () => {
	if (draft.feeChoice.value !== 'self') return;
	try {
		draft.state.quote = await store.selfPayQuote(draft.guardians.value.length);
	} catch (e) {
		console.warn('[recovery] balance could not be read:', e);
	}
});

const blocked = computed(() => {
	if (draft.blockReason.value) return draft.blockReason.value;
	if (draft.feeChoice.value === 'self' && !draft.state.quote) return 'Reading the balance…';
	if (!draft.alertsConnected.value && !draft.state.alerts.skipped) return 'Set up alerts or skip them first.';
	return null;
});

const creating = ref(false);
const error = ref(null);
// start resolves once the run is saved, before anything leaves this device;
// the progress screen follows it from there.
const create = async () => {
	creating.value = true;
	error.value = null;
	try {
		await store.start(draft.startPayload());
		nav.reset('progress');
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		creating.value = false;
	}
};
</script>

<style lang="scss" scoped>
.review-faces > * + * {
	margin-left: -8px;
}
</style>

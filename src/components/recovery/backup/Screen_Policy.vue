<template>
	<ScreenHeader title="Waiting period" back />

	<div v-if="!isLiveBackup(run)" class="cb-muted">There is no backup to change.</div>
	<template v-else>
		<PolicyFields v-model:delay-sec="delaySec" v-model:window-sec="windowSec" :problems="problems" messages />
		<div class="cb-small">If someone else starts a recovery, you have {{ delayWords }} to stop it from any of your devices. The change is sent to the network and paid the way this backup pays.</div>

		<div v-if="changing" class="cb-warn" data-test="blocked">{{ FINISH_CHANGE_FIRST }}</div>
		<div v-if="error" class="cb-error" data-test="policy-error">{{ error }}</div>
		<div class="cb-actions">
			<button class="btn btn-dark w-100" :disabled="!canSave" data-test="save-policy" @click="save">
				<span v-if="saving" class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Save
			</button>
		</div>
	</template>
</template>

<script setup>
import { computed, inject, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { DELAY_BOUNDS, WINDOW_BOUNDS, durationText, policyProblems } from '@/lib/recovery/backupPlan';
import errorMessage from '@/utils/errorMessage';
import ScreenHeader from './ScreenHeader.vue';
import PolicyFields from './PolicyFields.vue';
import { FINISH_CHANGE_FIRST, NAV, changeInProgress, isLiveBackup } from './backupFlow';

// The waiting period and the time to finish of a finished backup (plan § 7.4,
// Controls): within the contract's bounds, set on chain by store.setPolicy.
const nav = inject(NAV);
const store = useRecoveryBackupStore();

const run = computed(() => store.run);
const delaySec = ref(run.value?.settings?.delaySec ?? DELAY_BOUNDS.min);
const windowSec = ref(run.value?.settings?.windowSec ?? WINDOW_BOUNDS.min);

const problems = computed(() => (run.value ? policyProblems(run.value.settings, delaySec.value, windowSec.value, run.value.guardians.length, run.value.nodes.length) : []));
const delayWords = computed(() => (problems.value.some((p) => p.field === 'delaySec') ? 'the waiting period' : durationText(delaySec.value)));

const changing = computed(() => changeInProgress(store));
const changed = computed(() => delaySec.value !== run.value?.settings?.delaySec || windowSec.value !== run.value?.settings?.windowSec);
const saving = ref(false);
const error = ref(null);
const canSave = computed(() => changed.value && !problems.value.length && !changing.value && !saving.value);

const save = async () => {
	if (!canSave.value) return;
	saving.value = true;
	error.value = null;
	try {
		await store.setPolicy({ delaySec: delaySec.value, windowSec: windowSec.value });
		nav.back();
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		saving.value = false;
	}
};
</script>

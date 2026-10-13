<template>
	<ScreenHeader title="Waiting period" back />

	<div v-if="!run || run.step !== 'done' || run.revokedAt" class="cb-muted">There is no backup to change.</div>
	<template v-else>
		<div class="cb-group">
			<div class="d-flex flex-column">
				<div class="cb-setting flex-wrap">
					<div class="flex-grow-1 d-flex flex-column gap-1">
						<span class="fw-medium">Waiting period</span>
						<span class="cb-small">{{ boundsText(DELAY_BOUNDS) }}</span>
					</div>
					<DurationInput v-model="delaySec" label="Waiting period" :invalid="bad('delaySec')" data-test="delay" />
				</div>
				<div v-if="bad('delaySec')" class="cb-field-error pb-2" data-test="delay-error">The waiting period must be between {{ boundsText(DELAY_BOUNDS, ' and ') }}.</div>
			</div>
			<div class="d-flex flex-column">
				<div class="cb-setting flex-wrap">
					<div class="flex-grow-1 d-flex flex-column gap-1">
						<span class="fw-medium">Time to finish after the wait</span>
						<span class="cb-small">{{ boundsText(WINDOW_BOUNDS) }}</span>
					</div>
					<DurationInput v-model="windowSec" label="Time to finish" :invalid="bad('windowSec')" data-test="window" />
				</div>
				<div v-if="bad('windowSec')" class="cb-field-error pb-2" data-test="window-error">The time to finish must be between {{ boundsText(WINDOW_BOUNDS, ' and ') }}.</div>
			</div>
		</div>
		<div class="cb-small">If someone else starts a recovery, you have {{ delayWords }} to stop it from any of your devices. The change is sent to the network and paid the way this backup pays.</div>

		<div v-if="blocked" class="cb-warn" data-test="blocked">{{ blocked }}</div>
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
import { unfinished } from '@/lib/recovery/backupRun';
import { DELAY_BOUNDS, WINDOW_BOUNDS, durationText, settingsProblems } from '@/lib/recovery/backupPlan';
import errorMessage from '@/utils/errorMessage';
import ScreenHeader from './ScreenHeader.vue';
import DurationInput from './DurationInput.vue';
import { NAV } from './backupFlow';

// The waiting period and the time to finish of a finished backup (plan § 7.4,
// Controls): within the contract's bounds, set on chain by store.setPolicy.
const nav = inject(NAV);
const store = useRecoveryBackupStore();

const run = computed(() => store.run);
const delaySec = ref(run.value?.settings?.delaySec ?? DELAY_BOUNDS.min);
const windowSec = ref(run.value?.settings?.windowSec ?? WINDOW_BOUNDS.min);

const problems = computed(() =>
	run.value
		? settingsProblems({ ...run.value.settings, delaySec: delaySec.value, windowSec: windowSec.value }, run.value.guardians.length, run.value.nodes.length).filter(
				(p) => p.field === 'delaySec' || p.field === 'windowSec',
			)
		: [],
);
const bad = (field) => problems.value.some((p) => p.field === field);
const boundsText = (b, sep = ' … ') => `${durationText(b.min)}${sep}${durationText(b.max)}`;
const delayWords = computed(() => (bad('delaySec') ? 'the waiting period' : durationText(delaySec.value)));

const blocked = computed(() => (unfinished(store.reshare) ? 'A change to this backup is being made. Finish or discard the change first.' : null));
const changed = computed(() => delaySec.value !== run.value?.settings?.delaySec || windowSec.value !== run.value?.settings?.windowSec);
const saving = ref(false);
const error = ref(null);
const canSave = computed(() => changed.value && !problems.value.length && !blocked.value && !saving.value);

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

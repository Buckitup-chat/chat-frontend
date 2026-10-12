<template>
	<div class="card mb-3 shadow-sm border-0 cb-card" data-test="community-backup-card">
		<div class="card-body d-flex flex-column gap-2">
			<div class="d-flex align-items-center">
				<svg class="me-3" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#241824" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"></path>
					<path d="M9 12l2 2 4-4"></path>
				</svg>
				<h5 class="card-title mb-0 fw-bold">Community backup</h5>
			</div>

			<!-- No network to back up on in this build -->
			<template v-if="state === 'unavailable'">
				<p class="card-text text-secondary mb-0">{{ ABOUT }}</p>
				<div class="cb-muted">Not available in this version of the app.</div>
			</template>

			<template v-else-if="state === 'loading'">
				<p class="card-text text-secondary mb-0">{{ ABOUT }}</p>
				<div v-if="loadError" class="cb-muted">
					Could not read your backup: {{ loadError }}
					<button class="btn btn-link btn-sm p-0 ms-1 align-baseline" @click="load">Try again</button>
				</div>
				<div v-else class="cb-muted"><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Loading…</div>
			</template>

			<!-- 1.2: a run that has not finished -->
			<template v-else-if="state === 'unfinished'">
				<div class="cb-warn" data-test="unfinished">
					<div class="fw-semibold">{{ unfinishedTitle }}</div>
					<div class="text-secondary">{{ unfinishedText }}</div>
				</div>
				<div class="d-flex gap-2">
					<button v-if="showDiscard" class="btn btn-outline-dark flex-fill" :disabled="busy" data-test="discard" @click="discard">Discard</button>
					<button class="btn btn-dark flex-fill" :disabled="busy" data-test="continue" @click="cont">{{ continueLabel }}</button>
				</div>
				<div v-if="actionError" class="cb-field-error">{{ actionError }}</div>
			</template>

			<!-- 1.0 / 1.3: the backup exists -->
			<template v-else-if="state === 'done'">
				<HealthLine :view="health" :extra="healthExtra" />
				<div v-if="!outsideAlerts" class="cb-warn" data-test="no-alerts">No alerts. You may not learn about an attempt in time to stop it.</div>
				<div class="d-flex gap-2">
					<button v-if="!outsideAlerts" class="btn btn-outline-dark flex-fill" @click="open('alerts')">Set up alerts</button>
					<button class="btn btn-dark flex-fill" @click="open('done')">Manage</button>
				</div>
			</template>

			<!-- 1.1: no backup yet -->
			<template v-else>
				<p class="card-text text-secondary mb-0">{{ ABOUT }}</p>
				<div class="d-flex align-items-center gap-2">
					<div class="d-flex cb-card-faces">
						<ContactAvatar v-for="c in agreed.slice(0, 3)" :key="c.userHash" :hash="c.userHash" small />
						<span v-for="i in Math.max(0, 2 - agreed.length)" :key="`p${i}`" class="cb-card-slot"></span>
					</div>
					<span class="small fw-medium" data-test="agreed">{{ agreedText }}</span>
				</div>
				<div class="d-flex gap-2">
					<button class="btn btn-outline-dark flex-fill" @click="open('guardians')">Ask guardians</button>
					<button class="btn btn-dark flex-fill" :disabled="!!createBlocked" data-test="create" @click="open('guardians')">Create backup</button>
				</div>
				<div v-if="createBlocked" class="text-secondary small" data-test="create-reason">{{ createBlocked }}</div>
			</template>
		</div>
	</div>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted, ref } from 'vue';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { canDiscard, stepNumber } from '@/lib/recovery/backupRun';
import HealthLine from './HealthLine.vue';
import ContactAvatar from './ContactAvatar.vue';
import errorMessage from '@/utils/errorMessage';
import { plural } from '@/lib/recovery/backupPlan';
import { STEP_LABELS, alertsText, hasOutsideAlerts, healthView } from './backupFlow';

const ABOUT = 'Your keys are split between contacts you trust and a few independent nodes. Nobody can open your account alone.';

const store = useRecoveryBackupStore();
const $modal = inject('$modal');

const loadError = ref(null);
const busy = ref(false);
const actionError = ref(null);

const load = async () => {
	loadError.value = null;
	try {
		await store.load();
	} catch (e) {
		loadError.value = errorMessage(e);
	}
};
// An unfinished run may be driven by another device or tab: the card follows it.
onMounted(() => {
	if (!store.deployment) return;
	load();
	store.follow();
});
onUnmounted(() => {
	if (store.deployment) store.unfollow();
});

const run = computed(() => store.run);
const state = computed(() => {
	if (!store.deployment) return 'unavailable';
	if (!store.loaded) return 'loading';
	const step = run.value?.step;
	if (!step || step === 'discarded') return 'none';
	if (step === 'done') return 'done';
	return 'unfinished';
});

// --- No backup -------------------------------------------------------------

const agreed = computed(() => store.pickable);
const agreedText = computed(() => {
	const n = agreed.value.length;
	return n ? `${plural(n, 'guardian')} ${n === 1 ? 'has' : 'have'} agreed` : 'No guardian has agreed yet';
});
const createBlocked = computed(() => {
	const n = agreed.value.length;
	return n >= 2 ? null : `Create backup needs 2 guardians who agreed. ${2 - n} more to go.`;
});

// --- Unfinished --------------------------------------------------------------

const step = computed(() => (run.value ? stepNumber(run.value) : 1));
const stepLine = computed(() => `step ${step.value} of 6: ${STEP_LABELS[step.value - 1].toLowerCase()}`);
const elsewhere = computed(() => !store.runsHere);
const unfinishedTitle = computed(() => {
	if (store.running) return 'Creating your backup';
	if (elsewhere.value) return `Your backup is being created on your ${run.value.device}`;
	return 'Your backup was not finished';
});
const unfinishedText = computed(() => {
	if (store.running) return `Now at ${stepLine.value}.`;
	if (elsewhere.value) return `Last seen at ${stepLine.value}. This device shows its progress and does not start a second backup.`;
	return `Stopped at ${stepLine.value}.`;
});
const showDiscard = computed(() => !store.running && !elsewhere.value && !!run.value && canDiscard(run.value));
const continueLabel = computed(() => (store.running || elsewhere.value ? 'Show progress' : 'Continue'));

const cont = () => {
	const resume = !store.running && !elsewhere.value;
	open('progress');
	if (resume) store.resume();
};
const discard = async () => {
	busy.value = true;
	actionError.value = null;
	try {
		await store.discard();
	} catch (e) {
		actionError.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

// --- Done ----------------------------------------------------------------------

const health = computed(() => healthView(run.value));
const outsideAlerts = computed(() => hasOutsideAlerts(run.value?.alerts));
const healthExtra = computed(() => {
	const spares = plural(run.value?.settings?.spares ?? 0, 'spare piece');
	return outsideAlerts.value ? `${spares} · alerts: ${alertsText(run.value.alerts.channels)}` : spares;
});

const open = (start) => {
	$modal.value.open({ id: 'community_backup', start });
};
</script>

<style lang="scss" scoped>
@import './tokens';
@include cb-tokens;

.cb-card {
	background-color: #f8f9fa;
	border-radius: 12px;
}
.cb-warn {
	padding: 10px 12px;
	gap: 2px;
}
.cb-card-faces > * + * {
	margin-left: -6px;
}
.cb-card-slot {
	width: 26px;
	height: 26px;
	border-radius: 50%;
	background: #fff;
	border: 2px dashed #c9c9cc;
	display: inline-block;
}
</style>

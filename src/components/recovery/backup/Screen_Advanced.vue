<template>
	<ScreenHeader title="Backup settings" back :on-back="cancel" />

	<div class="cb-section">Pieces</div>
	<div class="cb-group">
		<div class="cb-setting">
			<div class="flex-grow-1 d-flex flex-column gap-1">
				<span class="fw-medium">Pieces needed</span>
				<span class="cb-small">of {{ plural(guardianCount, 'guardian') }}<template v-if="w.threshold >= maxThreshold"> · maximum</template></span>
			</div>
			<Stepper v-model="w.threshold" :min="2" :max="maxThreshold" data-test="threshold" />
		</div>
		<div class="d-flex flex-column">
			<div class="cb-setting">
				<div class="flex-grow-1 d-flex flex-column gap-1">
					<span class="fw-medium">Approvals needed</span>
					<span class="cb-small">guardians who confirm on a call</span>
				</div>
				<Stepper v-model="w.approvals" :min="1" :max="Math.max(guardianCount, 2)" :invalid="!!approvalsError" data-test="approvals" />
			</div>
			<div v-if="approvalsError" class="cb-field-error pb-2" data-test="approvals-error">{{ approvalsError }}</div>
		</div>
		<div class="cb-setting">
			<div class="flex-grow-1 d-flex flex-column gap-1">
				<span class="fw-medium">Spare pieces</span>
				<span class="cb-small">{{ SPARES_CAPTION }}</span>
			</div>
			<Stepper v-model="w.spares" :min="SPARES_BOUNDS.min" :max="SPARES_BOUNDS.max" />
		</div>
	</div>

	<div class="cb-section">Time</div>
	<div class="cb-group">
		<div class="cb-setting flex-wrap">
			<div class="flex-grow-1 d-flex flex-column gap-1">
				<span class="fw-medium">Waiting period</span>
				<span class="cb-small">{{ boundsText(DELAY_BOUNDS) }}</span>
			</div>
			<DurationInput v-model="w.delaySec" label="Waiting period" :invalid="bad('delaySec')" />
		</div>
		<div class="cb-setting flex-wrap">
			<div class="flex-grow-1 d-flex flex-column gap-1">
				<span class="fw-medium">Time to finish after the wait</span>
				<span class="cb-small">{{ boundsText(WINDOW_BOUNDS) }}</span>
			</div>
			<DurationInput v-model="w.windowSec" label="Time to finish" :invalid="bad('windowSec')" />
		</div>
	</div>
	<div class="cb-small">If someone else starts a recovery, you have {{ delayWords }} to stop it from any of your devices.</div>

	<div class="cb-section">Nodes and fee</div>
	<div class="cb-group">
		<div class="cb-setting link" role="button" @click="openNodes">
			<span class="flex-grow-1 fw-medium">Nodes</span>
			<span class="cb-small">{{ draft.settings.value.nodeThreshold }} of {{ draft.nodes.value.length }} needed</span>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 7l5 5-5 5"></path></svg>
		</div>
		<div class="cb-setting link" role="button" @click="nav.go('fee')">
			<span class="flex-grow-1 fw-medium">Network fee</span>
			<span class="cb-small">{{ feeText(draft.feeChoice.value, 'row') }}</span>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 7l5 5-5 5"></path></svg>
		</div>
	</div>

	<div class="cb-actions">
		<div class="d-flex gap-2">
			<button class="btn btn-outline-dark flex-fill" @click="reset">Reset</button>
			<button class="btn btn-dark flex-fill" :disabled="problems.length > 0" data-test="save" @click="save">Save</button>
		</div>
	</div>
</template>

<script setup>
import { computed, inject } from 'vue';
import { DELAY_BOUNDS, WINDOW_BOUNDS, SPARES_BOUNDS, defaultSettings, durationText, plural, settingsProblems } from '@/lib/recovery/backupPlan';
import ScreenHeader from './ScreenHeader.vue';
import Stepper from './Stepper.vue';
import DurationInput from './DurationInput.vue';
import { DRAFT, NAV, SPARES_CAPTION, feeText } from './backupFlow';

const FIELDS = ['threshold', 'approvals', 'spares', 'delaySec', 'windowSec'];

const draft = inject(DRAFT);
const nav = inject(NAV);

const pick = (s) => Object.fromEntries(FIELDS.map((k) => [k, s[k]]));
// The working copy outlives a visit to Nodes or Fee; Save or Back ends it.
if (!draft.state.work) draft.state.work = pick(draft.settings.value);
const w = draft.state.work;

const guardianCount = computed(() => draft.guardians.value.length);
const maxThreshold = computed(() => Math.max(guardianCount.value, 2));

const problems = computed(() =>
	settingsProblems({ ...draft.settings.value, ...w }, guardianCount.value, draft.nodes.value.length).filter((p) => FIELDS.includes(p.field)),
);
const bad = (field) => problems.value.some((p) => p.field === field);
const approvalsError = computed(() => {
	const p = problems.value.find((x) => x.field === 'approvals');
	if (!p) return null;
	return p.reason === 'below_threshold'
		? 'Approvals cannot be fewer than pieces needed: an honest recovery could never collect enough pieces.'
		: 'Approvals cannot be more than the guardians.';
});
const delayWords = computed(() =>
	w.delaySec >= DELAY_BOUNDS.min && w.delaySec <= DELAY_BOUNDS.max ? durationText(w.delaySec) : 'the waiting period',
);
const boundsText = (b) => `${durationText(b.min)} … ${durationText(b.max)}`;

const reset = () => Object.assign(w, pick(defaultSettings(guardianCount.value, draft.nodes.value.length)));
const save = () => {
	draft.state.custom = { ...w };
	draft.state.work = null;
	nav.back();
};
const cancel = () => {
	draft.state.work = null;
	nav.back();
};
const openNodes = () => nav.go('nodes');
</script>

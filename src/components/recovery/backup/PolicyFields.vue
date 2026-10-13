<template>
	<div class="cb-group">
		<div class="d-flex flex-column">
			<div class="cb-setting flex-wrap">
				<div class="flex-grow-1 d-flex flex-column gap-1">
					<span class="fw-medium">Waiting period</span>
					<span class="cb-small">{{ boundsText(DELAY_BOUNDS) }}</span>
				</div>
				<DurationInput :model-value="delaySec" label="Waiting period" :invalid="bad('delaySec')" data-test="delay" @update:model-value="(v) => emit('update:delaySec', v)" />
			</div>
			<div v-if="messages && bad('delaySec')" class="cb-field-error pb-2" data-test="delay-error">The waiting period must be between {{ boundsText(DELAY_BOUNDS, ' and ') }}.</div>
		</div>
		<div class="d-flex flex-column">
			<div class="cb-setting flex-wrap">
				<div class="flex-grow-1 d-flex flex-column gap-1">
					<span class="fw-medium">Time to finish after the wait</span>
					<span class="cb-small">{{ boundsText(WINDOW_BOUNDS) }}</span>
				</div>
				<DurationInput :model-value="windowSec" label="Time to finish" :invalid="bad('windowSec')" data-test="window" @update:model-value="(v) => emit('update:windowSec', v)" />
			</div>
			<div v-if="messages && bad('windowSec')" class="cb-field-error pb-2" data-test="window-error">The time to finish must be between {{ boundsText(WINDOW_BOUNDS, ' and ') }}.</div>
		</div>
	</div>
</template>

<script setup>
import { DELAY_BOUNDS, WINDOW_BOUNDS } from '@/lib/recovery/backupPlan';
import DurationInput from './DurationInput.vue';
import { boundsText } from './backupFlow';

// A backup's waiting period and time to finish, each with the contract's
// bounds under its name (backupPlan DELAY_BOUNDS, WINDOW_BOUNDS).
const props = defineProps({
	delaySec: { type: Number, required: true },
	windowSec: { type: Number, required: true },
	/** backupPlan problems; those on delaySec or windowSec mark their field. */
	problems: { type: Array, default: () => [] },
	/** Say what is wrong under a field, not only mark it. */
	messages: { type: Boolean, default: false },
});
const emit = defineEmits(['update:delaySec', 'update:windowSec']);
const bad = (field) => props.problems.some((p) => p.field === field);
</script>

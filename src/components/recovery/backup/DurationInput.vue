<template>
	<div class="cb-duration" :class="{ invalid }">
		<input v-model.number="amount" type="number" min="1" step="1" class="form-control form-control-sm" :aria-label="label" />
		<select v-model.number="unit" class="form-select form-select-sm" :aria-label="`${label} unit`">
			<option :value="60">minutes</option>
			<option :value="3600">hours</option>
			<option :value="86400">days</option>
		</select>
	</div>
</template>

<script setup>
import { ref, watch } from 'vue';

const props = defineProps({
	/** Seconds. */
	modelValue: { type: Number, required: true },
	label: { type: String, required: true },
	invalid: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const unitOf = (sec) => (sec % 86400 === 0 ? 86400 : sec % 3600 === 0 ? 3600 : 60);
const unit = ref(unitOf(props.modelValue));
const amount = ref(Math.round(props.modelValue / unit.value));

watch([amount, unit], () => {
	const n = Number(amount.value);
	if (Number.isFinite(n) && n > 0) emit('update:modelValue', Math.round(n) * unit.value);
	else emit('update:modelValue', 0);
});
watch(
	() => props.modelValue,
	(sec) => {
		if (sec > 0 && sec !== amount.value * unit.value) {
			unit.value = unitOf(sec);
			amount.value = Math.round(sec / unit.value);
		}
	},
);
</script>

<style lang="scss" scoped>
.cb-duration {
	display: flex;
	gap: 6px;
	input {
		width: 4.5rem;
	}
	select {
		width: 7rem;
	}
	&.invalid input {
		border-color: #dc3545;
	}
}
</style>

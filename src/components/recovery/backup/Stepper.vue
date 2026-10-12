<template>
	<div class="cb-stepper" :class="{ invalid }">
		<button type="button" aria-label="Less" :disabled="modelValue <= min" @click="emit('update:modelValue', modelValue - 1)">−</button>
		<span class="cb-stepper-value">{{ modelValue }}</span>
		<button type="button" aria-label="More" :disabled="modelValue >= max" @click="emit('update:modelValue', modelValue + 1)">+</button>
	</div>
</template>

<script setup>
defineProps({
	modelValue: { type: Number, required: true },
	min: { type: Number, required: true },
	max: { type: Number, required: true },
	invalid: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);
</script>

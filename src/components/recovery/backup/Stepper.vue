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

<style lang="scss" scoped>
@import '@/scss/variables.scss';

.cb-stepper {
	display: flex;
	align-items: center;
	background: #fff;
	border-radius: 999px;
	border: 1px solid $light_grey2;
	&.invalid {
		border-color: $red;
	}
	button {
		width: 32px;
		height: 30px;
		border: 0;
		background: transparent;
		font-size: 18px;
		line-height: 1;
		&:disabled {
			color: #c9c9cc;
		}
	}
}
.cb-stepper-value {
	min-width: 26px;
	text-align: center;
	font-weight: 700;
	font-size: 15px;
}
</style>

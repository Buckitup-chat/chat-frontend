<template>
	<div class="cb-head">
		<div v-if="step" class="cb-steps">
			<span v-for="i in 3" :key="i" :class="{ on: i <= step }"></span>
		</div>
		<div class="d-flex align-items-start gap-2">
			<button v-if="back" type="button" class="cb-icon-btn" aria-label="Back" @click="onBack ? onBack() : nav.back()">
				<span class="_icon_back bg-dark"></span>
			</button>
			<div class="flex-grow-1 d-flex flex-column gap-1">
				<span v-if="step" class="cb-step-label">Step {{ step }} of 3 · {{ stepLabel }}</span>
				<span class="cb-title">{{ title }}</span>
			</div>
			<button type="button" class="cb-icon-btn" aria-label="Close" @click="nav.close()">
				<span class="_icon_times bg-dark"></span>
			</button>
		</div>
	</div>
</template>

<script setup>
import { inject } from 'vue';
import { NAV } from './backupFlow';

defineProps({
	title: { type: String, required: true },
	step: { type: Number, default: 0 },
	stepLabel: { type: String, default: '' },
	back: { type: Boolean, default: false },
	/** Replaces the plain step back, for a screen that drops its edits on the way. */
	onBack: { type: Function, default: null },
});
const nav = inject(NAV);
</script>

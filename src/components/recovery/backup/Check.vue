<template>
	<svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" :stroke="color" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M5 12l5 5 9-10"></path>
	</svg>
</template>

<script setup>
defineProps({
	size: { type: Number, default: 11 },
	color: { type: String, default: '#fff' },
});
</script>

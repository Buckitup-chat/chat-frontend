<template>
	<div class="d-flex flex-column w-100 h-100 justify-content-center align-items-center text-muted">
		<div class="_empty_logo"></div>
		<!-- <div class="mt-4 fs-5 fw-medium">Select an item from the menu to start</div> -->
	</div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';

._empty_logo {
	width: 120px;
	height: 120px;
	-webkit-mask: url('/icons/logo.svg') no-repeat center / contain;
	mask: url('/icons/logo.svg') no-repeat center / contain;
	background-color: $grey_dark; // Use existing variable
	opacity: 0.3; // Make it look like a watermark
	animation: pulse 4s infinite ease-in-out;
}

@keyframes pulse {
	0% {
		transform: scale(0.95);
		opacity: 0.2;
	}

	50% {
		transform: scale(1.05);
		opacity: 0.4;
	}

	100% {
		transform: scale(0.95);
		opacity: 0.2;
	}
}
</style>

<script setup>
</script>
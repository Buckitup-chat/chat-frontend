<template>
	<!-- On a phone a screen sits over its section's list: back returns to it. -->
	<button v-if="$breakpoint.lt('md')" type="button" class="ui-back" aria-label="Back" @click="open()">
		<i class="_icon_back"></i>
	</button>
</template>

<script setup>
import { useBreakpoint } from '@/composables/useBreakpoint';
import { useMenu } from '@/composables/useMenu';

const $breakpoint = useBreakpoint();
const { open } = useMenu();
</script>

<style lang="scss" scoped>
.ui-back {
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 40px;
	height: 40px;
	margin-left: calc(-1 * var(--space-2));
	border: 0;
	border-radius: var(--radius-pill);
	background: transparent;
	cursor: pointer;

	&:hover { background: var(--color-surface); }
	&:focus-visible { outline: 2px solid var(--color-accent); }

	i { width: 24px; height: 24px; background-color: var(--color-text); }
}
</style>

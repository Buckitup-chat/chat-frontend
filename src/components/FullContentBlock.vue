<template>
	<div class="_wrap">
		<div class="_header">
			<div class="_top">
				<UiBackToList />
				<div class="_heading">
					<slot name="header"></slot>
				</div>
			</div>

			<div class="_bottom">
				<slot name="headerbottom"></slot>
			</div>
		</div>

		<div class="_body">
			<div class="_content">
				<div class="d-flex justify-content-center w-100" :class="blockClass">
					<slot name="content"></slot>
				</div>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._wrap {
	display: flex;
	flex-direction: column;
	width: 100%;
	background: var(--color-surface);

	._header {
		padding: var(--space-2) var(--space-4);
		background-color: var(--color-bg);
		border-bottom: 1px solid var(--color-border);
		width: 100%;

		._top {
			display: flex;
			align-items: center;
			gap: var(--space-2);
			min-height: 44px;
		}

		._heading {
			flex-grow: 1;
			min-width: 0;
		}
	}

	._body {
		flex-grow: 1;
		overflow: auto;
		padding: var(--space-4);

		@include media-breakpoint-up(md) {
			padding: var(--space-8);
		}

		._content {
			display: flex;
			justify-content: center;
			width: 100%;
		}
	}
}
</style>

<script setup>
import UiBackToList from '@/components/ui/UiBackToList.vue';

const { blockClass } = defineProps({
	blockClass: { type: String },
});
</script>

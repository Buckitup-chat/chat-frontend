<template>
	<FullContentBlock v-if="$userPQ.currentUser">
		<template #header><div class="fw-bold fs-5 py-1">Restore from shares</div> </template>
		<template #content>
			<div class="_full_width_block">
				<div class="alert alert-info text-center">
					<h5>Coming Soon</h5>
					<p class="mb-0">Restore functionality for PQ accounts is under development.</p>
				</div>
			</div>
		</template>
	</FullContentBlock>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
._full_width_block {
	max-width: 50rem;
	width: 100%;
}
</style>

<script setup>
import FullContentBlock from '@/components/FullContentBlock.vue';
import { inject } from 'vue';

const $userPQ = inject('$userPQ');
</script>

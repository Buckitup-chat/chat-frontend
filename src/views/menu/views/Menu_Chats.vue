<template>
	<div class="text-center mt-4" v-if="isLoading">
		<div class="spinner-border text-primary" role="status" style="width: 1.5rem; height: 1.5rem;">
			<span class="visually-hidden">Loading...</span>
		</div>
	</div>
	<div class="fs-5 text-center mb-2 mt-4 text-muted" v-else-if="!hasUsers">Network users list is empty</div>

	<Chats_List @select="(address, opts) => select(address, opts)" :selected="selected" v-show="hasUsers" />
</template>

<script setup>
import { useMenu } from '@/composables/useMenu';

import Chats_List from '@/views/chats/Chats_List.vue';
import { ref, inject, watch, onMounted, computed } from 'vue';
import { userPQStore } from '@/store/userPQ.store';

const $route = inject('$route');
const $router = inject('$router');
const { isOpen: $menuOpened, close: closeMenu } = useMenu();
const $userPQ = userPQStore();

const selected = ref([]);

const select = (address, opts = {}) => {
	selected.value = [address];
	// The alert dot opens the dialog already asking for the comparison; the
	// intent rides the query so a reload or a shared link behaves the same.
	$router.push({
		name: 'chat',
		params: { address },
		...(opts.checkpoint ? { query: { checkpoint: '1' } } : {}),
	});
	closeMenu();
};

const isLoading = computed(() => !$userPQ.isInitialized);

const hasUsers = computed(() => $userPQ.allNetworkUsers.length > 0);

onMounted(async () => {
	if ($menuOpened.value && $route.params.address) checkSelection();
});

watch(
	() => $menuOpened.value,
	async (newVal) => {
		if (newVal && $route.params.address) checkSelection();
	},
);

watch(
	() => $route.params?.address,
	async (newVal) => {
		checkSelection();
	},
);

const checkSelection = () => {
	selected.value = [$route.params.address];
};
</script>

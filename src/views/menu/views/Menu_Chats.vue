<template>
	<div class="text-center mt-4" v-if="isLoading">
		<div class="spinner-border text-primary" role="status" style="width: 1.5rem; height: 1.5rem;">
			<span class="visually-hidden">Loading...</span>
		</div>
	</div>
	<div class="fs-5 text-center mb-2 mt-4 text-muted" v-else-if="!hasUsers">Network users list is empty</div>

	<Chats_List @select="select" :selected="selected" v-show="hasUsers" />
</template>

<script setup>
import { useMenu } from '@/composables/useMenu';

import Chats_List from '@/views/chats/Chats_List.vue';
import { ref, inject, watch, onMounted, computed } from 'vue';
import { useLiveQuery } from '@electric-sql/pglite-vue';

const $route = inject('$route');
const $router = inject('$router');
const { isOpen: $menuOpened, close: closeMenu } = useMenu();

const selected = ref([]);

const select = (address) => {
	selected.value = [address];
	$router.push({ name: 'chat', params: { address } });
	closeMenu();
};

const dbUsers = useLiveQuery(`SELECT count(*) as count from user_cards WHERE NOT deleted_flag;`);

// If rows.value is undefined, the query hasn't resolved yet
const isLoading = computed(() => {
	return dbUsers?.rows?.value === undefined;
});

const hasUsers = computed(() => {
	return (dbUsers?.rows?.value?.[0]?.count ?? 0) > 0;
});

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

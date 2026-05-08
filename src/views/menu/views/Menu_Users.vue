<template>
	<div class="fs-5 text-center mb-2 mt-2" v-if="!hasUsers">Network users list is empty</div>

	<Users_List @select="select" :selected="selected" />
</template>

<script setup>
import Users_List from '@/views/users/Users_List.vue';
import { ref, inject, watch, onMounted, computed } from 'vue';
import { useLiveQuery } from '@electric-sql/pglite-vue';

const $route = inject('$route');
const $router = inject('$router');
const $menuOpened = inject('$menuOpened');

const selected = ref([]);

const select = (address) => {
	selected.value = [address];
	$router.push({ name: 'contact', params: { address } });
	$menuOpened.value = false;
};

const dbUsers = useLiveQuery(`SELECT count(*) as count from user_cards;`);

const hasUsers = computed(() => {
	return (dbUsers?.value?.rows?.[0]?.count ?? 0) > 0;
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
    // Basic sync, ideally should check if it exists in users
	selected.value = [$route.params.address];
};
</script>
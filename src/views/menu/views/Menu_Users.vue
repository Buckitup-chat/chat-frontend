<template>
	<div class="fs-5 text-center mb-2 mt-2" v-if="!hasUsers">Network users list is empty</div>

	<Users_List @select="select" :selected="selected" />
</template>

<script setup>
import { useMenu } from '@/composables/useMenu';

import Users_List from '@/views/users/Users_List.vue';
import { ref, inject, watch, onMounted, computed } from 'vue';
import { userPQStore } from '@/store/userPQ.store';

const $route = inject('$route');
const $router = inject('$router');
const { isOpen: $menuOpened, close: closeMenu } = useMenu();

const $userPQ = userPQStore();

const selected = ref([]);

const select = (address) => {
	selected.value = [address];
	$router.push({ name: 'contact', params: { address } });
	closeMenu();
};

const hasUsers = computed(() => {
	return $userPQ.allNetworkUsers.length > 0;
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
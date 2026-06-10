<template>    
    <Rooms_List @select="select" :selected="selected" />
</template>

<script setup>
import { useMenu } from '@/composables/useMenu';

import Rooms_List from '@/views/rooms/Rooms_List.vue';
import { ref, inject, watch, onMounted } from 'vue';

const $route = inject('$route');
const $router = inject('$router');
const { isOpen: $menuOpened, close: closeMenu } = useMenu();

const selected = ref([]);

const select = (roomId) => {    
    selected.value = [roomId];
    $router.push({ name: 'room', params: { roomId } });
    closeMenu();
};

onMounted(() => {
	if ($menuOpened.value && $route.params.roomId) checkSelection();
});

watch(
	() => $menuOpened.value,
	(newVal) => {
		if (newVal && $route.params.roomId) checkSelection();
	},
);

watch(
	() => $route.params?.roomId,
	() => {
		checkSelection();
	},
);

const checkSelection = () => {
	selected.value = [$route.params.roomId];
};
</script>
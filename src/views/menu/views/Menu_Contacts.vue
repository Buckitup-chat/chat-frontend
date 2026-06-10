<template>
	<!-- <div class="fs-5 text-center mb-2 mt-2" v-if="!hasContacts">Your contacts list is empty</div> -->

	<Contacts_List @select="select" :selected="selected" />
</template>

<script setup>
import { useMenu } from '@/composables/useMenu';

import Contacts_List from '@/views/contacts/Contacts_List.vue';
import { ref, inject, watch, onMounted, computed } from 'vue';

const $route = inject('$route');
const $router = inject('$router');
const $user = inject('$user');
const { isOpen: $menuOpened, close: closeMenu } = useMenu();

const selected = ref([]);

const select = (address) => {
	selected.value = [address];
	$router.push({ name: 'contact', params: { address } });
	closeMenu();
};

onMounted(async () => {
	if ($menuOpened.value && $route.params.address) checkSelection();
});

const hasContacts = computed(() => {
	return $user.contacts.filter((contact) => !contact.hidden).length > 0;
});

watch(
	() => $menuOpened.value,
	async (newVal) => {
		if (newVal && $route.params.address) checkSelection();
	},
);

watch(
	() => $user.account?.address,
	async (newVal) => {
		selected.value = [];
	},
);

watch(
	() => $route.params?.address,
	async (newVal) => {
		checkSelection();
	},
);

const checkSelection = () => {
	const contact = $user.contacts.find((c) => c.address === $route.params.address);
	if (contact) selected.value = [$route.params.address];
};
</script>

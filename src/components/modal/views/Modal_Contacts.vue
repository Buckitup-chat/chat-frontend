<template>
	<!-- Header -->
	<div class="p-2">
		<ContactsList class="_list" @select="select" :selected="selected" :excluded="inputData.excluded" />

		<div class="d-flex justify-content-center mt-2">
			<button class="btn btn-dark w-100" :disabled="!selected.length" @click="applySelected()">Select</button>
		</div>
	</div>
</template>

<style lang="scss" scoped>
._list {
	max-height: 30rem;
	display: flex;
	flex-direction: column;
	height: 100%;
}
</style>

<script setup>
import { ref, inject } from 'vue';
import ContactsList from '@/views/contacts/Contacts_List.vue';

const $mitt = inject('$mitt');
const { inputData } = defineProps({ inputData: { type: Object } });

const selected = ref([]);

const select = (address) => {
	const idx = selected.value.findIndex((a) => a === address);
	if (idx > -1) {
		selected.value.splice(idx, 1);
	} else {
		selected.value.push(address);
	}
};

const applySelected = async () => {
	$mitt.emit('contacts::selected', selected.value);
	$mitt.emit('modal::close');
};
</script>

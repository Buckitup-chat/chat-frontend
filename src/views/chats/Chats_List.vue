<template>
	<div>
		<UserList @select="(address, opts) => emit('select', address, opts)" :selected="selected" />
	</div>
</template>

<style lang="scss" scoped></style>

<script setup>
import UserList from '../../components/UserList.vue';

const { selected } = defineProps({
	selected: { type: Array, default: () => [] },
});

const emit = defineEmits(['select']);
</script>

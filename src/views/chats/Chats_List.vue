<template>
	<div>
		<UserList @select="(address) => emit('select', address)" :selected="selected" />
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

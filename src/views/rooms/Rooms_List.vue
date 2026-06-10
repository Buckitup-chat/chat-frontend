<template>
	<div class="_rooms_list">
		<div class="_list">
			<div class="_room" @click="select(room.roomId)" v-for="room in mockRooms" :key="room.roomId" :class="{ _selected: isSelected(room.roomId) }">
				<Account_Item_PQ :account="room" class="w-100" />
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
@import '@/scss/breakpoints.scss';

._rooms_list {
	display: flex;
	flex-direction: column;
	overflow: hidden;
    flex-grow: 1;
    height: calc(100vh - 3rem);

	._list {
		flex-grow: 1;
		overflow-y: auto;

		._room {
			display: flex;
			align-items: center;
			padding: 0.5rem;
			width: 100%;
			cursor: pointer;
			border-radius: $blockRadiusSm;
			&:hover {
				background-color: lighten($black, 90%);
			}
			&._selected {
				background-color: lighten($black, 85%);
			}
		}
	}
}
</style>

<script setup>
import { ref } from 'vue';
import Account_Item_PQ from '@/components/Account_Item_PQ.vue';

const { selected } = defineProps({
	selected: { type: Array, default: () => [] },
});

const emit = defineEmits(['select']);

const mockRooms = ref([
    { roomId: 'room-1', name: 'General Chat', user_hash: 'r-001', notes: 'Public discussion' },
    { roomId: 'room-2', name: 'Development', user_hash: 'r-002', notes: 'Tech talk' },
    { roomId: 'room-3', name: 'Design', user_hash: 'r-003', notes: 'UI/UX' },
]);

const isSelected = (roomId) => {
	return selected.findIndex((a) => a === roomId) > -1;
};

const select = (roomId) => {
	emit('select', roomId);
};
</script>
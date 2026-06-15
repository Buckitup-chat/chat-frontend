<template>
	<div class="_rooms_list">
		<div class="_list px-2 py-3">
			
			<!-- Confirmed Section -->
			<div class="mb-4">
				<div class="d-flex align-items-center mb-2" style="cursor: pointer;" @click="isConfirmedOpen = !isConfirmedOpen">
					<i class="bi" :class="isConfirmedOpen ? 'bi-chevron-down' : 'bi-chevron-right'"></i>
					<span class="ms-2 fw-bold fs-6">Confirmed</span>
				</div>
				<div v-show="isConfirmedOpen" class="_rooms_container ps-2">
					<div v-if="confirmedRooms.length === 0" class="text-muted small">You have no rooms</div>
					<div 
						v-else
						class="_room" 
						@click="select(room.roomId)" 
						v-for="room in confirmedRooms" 
						:key="room.roomId" 
						:class="{ _selected: isSelected(room.roomId) }"
					>
						<Account_Item_PQ :account="room" class="w-100" />
					</div>
				</div>
			</div>

			<!-- Not Confirmed Section -->
			<div>
				<div class="d-flex align-items-center mb-2" style="cursor: pointer;" @click="isNotConfirmedOpen = !isNotConfirmedOpen">
					<i class="bi" :class="isNotConfirmedOpen ? 'bi-chevron-down' : 'bi-chevron-right'"></i>
					<span class="ms-2 fw-bold fs-6">Not Confirmed</span>
				</div>
				<div v-show="isNotConfirmedOpen" class="_rooms_container ps-2">
					<div v-if="notConfirmedRooms.length === 0" class="text-muted small">You have no rooms</div>
					<div 
						v-else
						class="_room" 
						@click="select(room.roomId)" 
						v-for="room in notConfirmedRooms" 
						:key="room.roomId" 
						:class="{ _selected: isSelected(room.roomId) }"
					>
						<Account_Item_PQ :account="room" class="w-100" />
					</div>
				</div>
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
import { ref, computed } from 'vue';
import Account_Item_PQ from '@/components/Account_Item_PQ.vue';

const { selected } = defineProps({
	selected: { type: Array, default: () => [] },
});

const emit = defineEmits(['select']);

const isConfirmedOpen = ref(true);
const isNotConfirmedOpen = ref(true);

const mockRooms = ref([
    { roomId: 'room-1', name: 'General Chat', user_hash: 'r-001', notes: 'Public discussion', isConfirmed: true },
    { roomId: 'room-2', name: 'Development', user_hash: 'r-002', notes: 'Tech talk', isConfirmed: true },
    { roomId: 'room-3', name: 'Design', user_hash: 'r-003', notes: 'UI/UX', isConfirmed: false },
    { roomId: 'room-4', name: 'Marketing', user_hash: 'r-004', notes: 'Promo requests', isConfirmed: false },
]);

const confirmedRooms = computed(() => {
	return mockRooms.value.filter(r => r.isConfirmed);
});

const notConfirmedRooms = computed(() => {
	return mockRooms.value.filter(r => !r.isConfirmed);
});

const isSelected = (roomId) => {
	return selected.findIndex((a) => a === roomId) > -1;
};

const select = (roomId) => {
	emit('select', roomId);
};
</script>
<template>
	<div class="d-flex flex-column w-100 h-100 justify-content-center align-items-center">
		<div class="fs-3 fw-bold">{{ roomName }}</div>
        <div class="text-muted mt-2">Mock Room Interface (ID: {{ $route.params.roomId }})</div>
	</div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
</style>

<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const $route = useRoute();

const mockRooms = [
    { roomId: 'room-1', name: 'General Chat', user_hash: 'r-001', notes: 'Public discussion' },
    { roomId: 'room-2', name: 'Development', user_hash: 'r-002', notes: 'Tech talk' },
    { roomId: 'room-3', name: 'Design', user_hash: 'r-003', notes: 'UI/UX' },
];

const roomName = computed(() => {
	const room = mockRooms.find((r) => r.roomId === $route.params.roomId);
    return room ? room.name : 'Unknown Room';
});
</script>
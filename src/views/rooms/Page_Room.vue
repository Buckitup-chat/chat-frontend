<template>
    <div class="w-100 h-100">
        <ChatWindow :title="roomName" :avatarHash="avatarHash" :messages="messages" :showAuthorName="true"
            @sendMessage="handleSendMessage" />
    </div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
</style>

<script setup>
import { ref, onMounted, watch, inject, computed } from 'vue';
import { useRoute } from 'vue-router';
import ChatWindow from '@/components/chat/ChatWindow.vue';

const $user = inject('$user');
const $web3 = inject('$web3');
const $swal = inject('$swal');
const $route = useRoute();
const $loader = inject('$loader');

// Optionally use existing computations
const contact = computed(() => {
    if (!$user || !$user.contacts) return null;
    return $user.contacts.find((e) => e.address === $route.params.address);
});

// Mock room info
const roomName = computed(() => {
    return `Room ${$route.params.roomId || 'General'}`;
});

const avatarHash = computed(() => {
    return $route.params.roomId || 'general-room';
});

const messages = ref([
    { id: 1, text: 'Welcome to the room!', authorName: 'Admin', isMine: false, timestamp: '09:00' },
    { id: 4, text: 'Hi', authorName: 'Me', isMine: true, timestamp: '09:20' }
]);

const handleSendMessage = (text) => {
    const now = new Date();
    const timeString = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    messages.value.push({
        id: Date.now(),
        text: text,
        authorName: 'Me',
        isMine: true,
        timestamp: timeString
    });
};
</script>
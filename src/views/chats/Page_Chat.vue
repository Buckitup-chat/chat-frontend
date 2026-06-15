<template>
    <div class="h-100 w-100">
        <ChatWindow :title="chatName" :avatarUrl="avatarUrl" :avatarHash="avatarHash" :messages="messages"
            :showAuthorName="false" @sendMessage="handleSendMessage" />
    </div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
</style>

<script setup>
import { ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import ChatWindow from '@/components/chat/ChatWindow.vue';
import { userPQStore } from '@/store/userPQ.store';

const $route = useRoute();
const $userPQ = userPQStore();

// Mock data
const chatName = computed(() => {
    const address = $route.params.address;
    if (!address) return 'User';

    // Attempt to find user name from store
    const contact = $userPQ.contacts.find((e) => e.user_hash === address) || $userPQ.getUserByHash(address);
    if (contact && contact.name) {
        return contact.name;
    }

    return address;
});

const avatarUrl = computed(() => {
    const address = $route.params.address;
    if (!address) return '';
    const contact = $userPQ.contacts.find((e) => e.user_hash === address) || $userPQ.getUserByHash(address);
    return contact?.avatar || '';
});

const avatarHash = computed(() => {
    return $route.params.address || '';
});

const messages = ref([
    { id: 1, text: 'Hi!', authorName: 'Alice', isMine: false, timestamp: '10:00' },
    { id: 2, text: 'Hi!', authorName: 'Me', isMine: true, timestamp: '10:01' },
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
<template>
    <div class="h-100 w-100">
        <ChatWindow :title="chatName" :avatarUrl="avatarUrl" :avatarHash="avatarHash" :messages="decryptedMessages"
            :showAuthorName="false" :reactions="reactionsByMsgId" @sendMessage="handleSendMessage"
            @toggleReaction="handleToggleReaction" @editMessage="handleEditMessage" />
    </div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
</style>

<script setup>
import { ref, computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import ChatWindow from '@/components/chat/ChatWindow.vue';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { useLiveQuery } from '@electric-sql/pglite-vue';

const $route = useRoute();
const $userPQ = userPQStore();
const $dialogs = useDialogsStore();

const peerHash = computed(() => $route.params.address);
const dialogHash = computed(() => $dialogs.getDialogHash(peerHash.value));

const chatName = computed(() => {
    const address = peerHash.value;
    if (!address) return 'User';

    const contact = $userPQ.contacts.find((e) => e.user_hash === address) || $userPQ.getUserByHash(address);
    if (contact && contact.name) {
        return contact.name;
    }

    return address;
});

const avatarUrl = computed(() => {
    const address = peerHash.value;
    if (!address) return '';
    const contact = $userPQ.contacts.find((e) => e.user_hash === address) || $userPQ.getUserByHash(address);
    return contact?.avatar || '';
});

const avatarHash = computed(() => peerHash.value || '');

// Live Query for Messages
const { rows: rawMessages } = useLiveQuery(
    `SELECT * FROM dialog_messages WHERE dialog_hash = $1 AND NOT deleted_flag ORDER BY owner_timestamp DESC`,
    computed(() => [dialogHash.value])
);

const decryptedMessages = ref([]);
const messageCache = new Map();
let decryptTimer = null;

watch(dialogHash, () => { messageCache.clear(); });

watch(() => rawMessages.value, (newRows, _, onCleanup) => {
    if (!newRows) return;
    if (decryptTimer) clearTimeout(decryptTimer);
    decryptTimer = setTimeout(async () => {
        const pending = [];
        for (const row of newRows) {
            if (row.deleted_flag) continue;
            const cached = messageCache.get(row.message_id);
            if (!cached || cached._contentB64 !== row.content_b64) pending.push(row);
        }

        if (pending.length > 0) {
            const name = chatName.value;
            await Promise.all(pending.map(async (row) => {
                const decrypted = await $dialogs.decryptMessageRow(row);
                const date = new Date(row.owner_timestamp * 1000);
                messageCache.set(row.message_id, {
                    id: row.message_id,
                    text: decrypted.text,
                    authorName: decrypted.isMine ? 'Me' : name,
                    isMine: decrypted.isMine,
                    timestamp: `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`,
                    _contentB64: row.content_b64,
                    _raw: row
                });
            }));
        }

        const out = [];
        for (const row of newRows) {
            if (row.deleted_flag) continue;
            const entry = messageCache.get(row.message_id);
            if (entry) out.push(entry);
        }
        decryptedMessages.value = out;
    }, 200);
    onCleanup(() => { if (decryptTimer) { clearTimeout(decryptTimer); decryptTimer = null; } });
}, { immediate: true });

// Reactions
const { rows: rawReactions } = useLiveQuery(
    `SELECT * FROM dialog_message_reactions WHERE dialog_hash = $1 AND deleted_flag = FALSE`,
    computed(() => [dialogHash.value])
);

const reactionsByMsgId = ref({});
let reactionTimer = null;

watch(() => rawReactions.value, (newRows, _, onCleanup) => {
    if (reactionTimer) clearTimeout(reactionTimer);
    reactionTimer = setTimeout(async () => {
        if (!newRows) {
            reactionsByMsgId.value = {};
            return;
        }

        const aggregated = {};
        const dialogHashVal = dialogHash.value;
        if (!dialogHashVal) return;

        await Promise.all(newRows.map(async (row) => {
            const decrypted = await $dialogs.decryptReactionRow(dialogHashVal, row);
            if (!decrypted.decrypted || !decrypted.emoji) return;

            const emoji = decrypted.emoji;
            const msgId = row.message_id;

            if (!aggregated[msgId]) aggregated[msgId] = {};
            if (!aggregated[msgId][emoji]) {
                aggregated[msgId][emoji] = { count: 0, hasMine: false };
            }

            aggregated[msgId][emoji].count++;
            if (row.reactor_hash === $userPQ.currentUserHash) {
                aggregated[msgId][emoji].hasMine = true;
            }
        }));

        reactionsByMsgId.value = aggregated;
    }, 200);
    onCleanup(() => { if (reactionTimer) { clearTimeout(reactionTimer); reactionTimer = null; } });
}, { immediate: true });

const handleToggleReaction = async (messageId, emoji) => {
    if (!peerHash.value) return;
    try {
        await $dialogs.toggleReaction(peerHash.value, messageId, emoji);
    } catch (e) {
        console.error("Failed to toggle reaction:", e);
    }
};

const handleSendMessage = async (text) => {
    if (!text.trim()) return;
    try {
        await $dialogs.sendMessage(peerHash.value, text);
    } catch (e) {
        console.error("Failed to send message:", e);
    }
};

const handleEditMessage = async (messageId, newText) => {
    if (!peerHash.value || !newText.trim()) return;
    try {
        await $dialogs.editMessage(peerHash.value, messageId, newText);
    } catch (e) {
        console.error("Failed to edit message:", e);
    }
};
</script>
<template>
    <div class="h-100 w-100">
        <ChatWindow :title="chatName" :avatarUrl="avatarUrl" :avatarHash="avatarHash" :messages="displayMessages"
            :showAuthorName="false" :reactions="displayReactions" @sendMessage="handleSendMessage"
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
import { v7 as uuidv7 } from 'uuid';

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
    `SELECT * FROM dialog_messages WHERE dialog_hash = $1 AND NOT deleted_flag ORDER BY owner_timestamp ASC`,
    computed(() => [dialogHash.value])
);

const decryptedMessages = ref([]);
const messageCache = new Map();
let decryptTimer = null;

watch(dialogHash, () => { messageCache.clear(); });

const rebuildDecryptedMessages = (newRows) => {
    const out = [];
    for (const row of newRows) {
        if (row.deleted_flag) continue;
        const entry = messageCache.get(row.message_id);
        if (entry) out.push(entry);
    }
    decryptedMessages.value = out;
};

watch(() => rawMessages.value, (newRows, _, onCleanup) => {
    if (!newRows) return;

    // Update sync status on cached entries immediately, re-render
    for (const row of newRows) {
        const cached = messageCache.get(row.message_id);
        if (cached) {
            cached._syncStatus = row.modified_columns !== null ? 'syncing' : 'synced';
        }
    }
    rebuildDecryptedMessages(newRows);

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
                const syncStatus = row.modified_columns !== null ? 'syncing' : 'synced';
                messageCache.set(row.message_id, {
                    id: row.message_id,
                    text: decrypted.text,
                    authorName: decrypted.isMine ? 'Me' : name,
                    isMine: decrypted.isMine,
                    timestamp: `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`,
                    _syncStatus: syncStatus,
                    _contentB64: row.content_b64,
                    _raw: row
                });
            }));
        }

        rebuildDecryptedMessages(newRows);
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

        // Clean up optimistic reactions whose real DB rows have arrived
        for (const item of $dialogs.optimisticItems.values()) {
            if (item.type !== 'reaction' || item.dialogHash !== dialogHashVal) continue;
            if (aggregated[item.messageId]?.[item.emoji]?.hasMine) {
                $dialogs.removeOptimisticItem(item.id);
            }
        }
    }, 200);
    onCleanup(() => { if (reactionTimer) { clearTimeout(reactionTimer); reactionTimer = null; } });
}, { immediate: true });

// Merge optimistic messages with live-query results
const displayMessages = computed(() => {
    const dbIds = new Set((rawMessages.value || []).map(r => r.message_id));
    const decryptedIds = new Set(decryptedMessages.value.map(m => m.id));
    const activeOptimistic = [];
    for (const item of $dialogs.optimisticItems.values()) {
        if (item.type !== 'message' || item.dialogHash !== dialogHash.value) continue;
        // If decrypted entry is ready, drop the optimistic placeholder
        if (dbIds.has(item.id) && decryptedIds.has(item.id)) continue;
        activeOptimistic.push({
            id: item.id,
            text: item.text,
            authorName: item.authorName,
            isMine: item.isMine,
            timestamp: item.timestamp,
            _syncStatus: item.status,
            _optimistic: true,
            ownerTimestamp: item.ownerTimestamp,
        });
    }

    return [...activeOptimistic, ...decryptedMessages.value].sort((a, b) => {
        const aTs = a._raw?.owner_timestamp || a.ownerTimestamp || 0;
        const bTs = b._raw?.owner_timestamp || b.ownerTimestamp || 0;
        return aTs - bTs;
    });
});

// Merge optimistic reactions with aggregated reactions
const displayReactions = computed(() => {
    const merged = {};
    for (const [msgId, emojis] of Object.entries(reactionsByMsgId.value)) {
        merged[msgId] = {};
        for (const [emoji, data] of Object.entries(emojis)) {
            merged[msgId][emoji] = { ...data, status: 'synced' };
        }
    }

    for (const item of $dialogs.optimisticItems.values()) {
        if (item.type !== 'reaction' || item.dialogHash !== dialogHash.value) continue;
        if (!merged[item.messageId]) merged[item.messageId] = {};
        const existing = merged[item.messageId][item.emoji];
        if (existing) {
            existing.status = item.status;
        } else {
            merged[item.messageId][item.emoji] = { count: 1, hasMine: true, status: item.status };
        }
    }

    return merged;
});

const handleToggleReaction = async (messageId, emoji) => {
    if (!peerHash.value || !dialogHash.value) return;
    const dialogHashVal = dialogHash.value;
    const optimisticId = $dialogs.addOptimisticReaction(dialogHashVal, messageId, emoji);
    try {
        await $dialogs.toggleReaction(peerHash.value, messageId, emoji, (status) => {
            $dialogs.updateOptimisticStatus(optimisticId, status);
        });
    } catch (e) {
        console.error("Failed to toggle reaction:", e);
        $dialogs.updateOptimisticStatus(optimisticId, 'error');
    }
};

const handleSendMessage = (text) => {
    if (!text.trim() || !peerHash.value || !dialogHash.value) return;
    const dialogHashVal = dialogHash.value;
    const nowSec = Math.floor(Date.now() / 1000);
    const messageId = "dmsg_" + uuidv7();

    const optimisticId = $dialogs.addOptimisticMessageWithId(dialogHashVal, messageId, text.trim(), nowSec);

    (async () => {
        try {
            await $dialogs.sendMessage(peerHash.value, text.trim(), (status) => {
                $dialogs.updateOptimisticStatus(optimisticId, status);
            }, messageId, nowSec);
        } catch (e) {
            console.error("Failed to send message:", e);
            $dialogs.updateOptimisticStatus(optimisticId, 'error');
        }
    })();
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
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
import { getDialogCollections } from '@/lib/data/collections';
import { useCollectionRows } from '@/lib/data/useCollection';
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

// Electric shape → TanStack DB collections for this dialog (lazy, per-dialog)
const dialogCollections = computed(() => (dialogHash.value ? getDialogCollections(dialogHash.value) : null));

// Live rows for messages (deleted rows are filtered in the decrypt pipeline)
const { rows: rawMessages } = useCollectionRows(computed(() => dialogCollections.value?.messages ?? null));

// Sender keys stream in independently of the messages they unlock: the peer
// creates its dialog_keys row at the same moment it sends its first message,
// so a message can arrive before the key that decrypts it.
const { rows: rawKeys } = useCollectionRows(computed(() => dialogCollections.value?.keys ?? null));

const decryptedMessages = ref([]);
const messageCache = new Map();
let decryptTimer = null;

// Async decryption started for dialog A must never write into dialog B:
// clearTimeout cannot cancel promises already in flight, so every async
// continuation checks the generation it was started under.
let dialogGeneration = 0;

watch(dialogHash, () => {
    dialogGeneration++;
    messageCache.clear();
    decryptedMessages.value = [];
    reactionsByMsgId.value = {};
});

const rebuildDecryptedMessages = (newRows) => {
    const out = [];
    for (const row of newRows) {
        if (row.deleted_flag) continue;
        const entry = messageCache.get(row.message_id);
        if (entry) out.push(entry);
    }
    decryptedMessages.value = out;
};

const scheduleDecrypt = (newRows) => {
    if (decryptTimer) clearTimeout(decryptTimer);
    const generation = dialogGeneration;
    decryptTimer = setTimeout(async () => {
        if (generation !== dialogGeneration) return;

        const pending = [];
        for (const row of newRows) {
            if (row.deleted_flag) continue;
            const cached = messageCache.get(row.message_id);
            // Undecrypted entries are retried: their key may have arrived since.
            if (!cached || !cached._decrypted || cached._contentB64 !== row.content_b64) pending.push(row);
        }

        if (pending.length > 0) {
            const name = chatName.value;
            const entries = await Promise.all(pending.map(async (row) => {
                const decrypted = await $dialogs.decryptMessageRow(row);
                const date = new Date(row.owner_timestamp * 1000);
                return [row.message_id, {
                    id: row.message_id,
                    text: decrypted.text,
                    authorName: decrypted.isMine ? 'Me' : name,
                    isMine: decrypted.isMine,
                    timestamp: `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`,
                    _syncStatus: 'synced',
                    _decrypted: decrypted.decrypted === true,
                    _contentB64: row.content_b64,
                    _raw: row
                }];
            }));
            // Apply only if the user is still looking at the same dialog
            if (generation !== dialogGeneration) return;
            for (const [id, entry] of entries) messageCache.set(id, entry);
        }

        rebuildDecryptedMessages(newRows);
    }, 200);
};

watch(() => rawMessages.value, (newRows, _, onCleanup) => {
    if (!newRows) return;

    // Rows from the shape stream are server-confirmed by definition
    for (const row of newRows) {
        const cached = messageCache.get(row.message_id);
        if (cached) {
            cached._syncStatus = 'synced';
        }
    }
    rebuildDecryptedMessages(newRows);

    scheduleDecrypt(newRows);
    onCleanup(() => { if (decryptTimer) { clearTimeout(decryptTimer); decryptTimer = null; } });
}, { immediate: true });


// Reactions (deleted rows filtered below — the shape carries the full table slice)
const { rows: rawAllReactions } = useCollectionRows(computed(() => dialogCollections.value?.reactions ?? null));
const rawReactions = computed(() => rawAllReactions.value.filter((r) => !r.deleted_flag));

const reactionsByMsgId = ref({});
let reactionTimer = null;

const aggregateReactions = (newRows) => {
    if (reactionTimer) clearTimeout(reactionTimer);
    const generation = dialogGeneration;
    reactionTimer = setTimeout(async () => {
        if (generation !== dialogGeneration) return;
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

        // The user may have switched dialogs while we were decrypting
        if (generation !== dialogGeneration) return;
        reactionsByMsgId.value = aggregated;

        // Reconcile optimistic reactions against server rows INCLUDING
        // tombstones, matched by the deterministic reaction_hash: an
        // un-react confirms as a tombstone, which carries no emoji and
        // never appears in the active aggregate.
        const serverRows = rawAllReactions.value;
        for (const item of $dialogs.optimisticItems.values()) {
            if (item.type !== 'reaction' || item.dialogHash !== dialogHashVal) continue;
            const serverRow = serverRows.find((r) => r.reaction_hash === item.reactionHash);
            if (serverRow && !serverRow.deleted_flag === item.desiredActive) {
                $dialogs.removeOptimisticItem(item.id);
            }
        }
    }, 200);
};

watch(() => rawReactions.value, (newRows, _, onCleanup) => {
    aggregateReactions(newRows);
    onCleanup(() => { if (reactionTimer) { clearTimeout(reactionTimer); reactionTimer = null; } });
}, { immediate: true });

// A sender key arriving after the messages it unlocks: re-run decryption for
// everything still waiting, otherwise those messages stay on
// "Waiting for keys..." until the page is reloaded. This is the common case
// for the peer's first message — their key row and message land together.
watch(() => rawKeys.value, () => {
    scheduleDecrypt(rawMessages.value || []);
    aggregateReactions(rawReactions.value || []);
});

// Merge optimistic messages with server rows
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

        if (item.desiredActive) {
            if (existing) {
                if (!existing.hasMine) {
                    existing.count++;
                    existing.hasMine = true;
                }
                existing.status = item.status;
            } else {
                merged[item.messageId][item.emoji] = { count: 1, hasMine: true, status: item.status };
            }
        } else if (existing && existing.hasMine) {
            // Optimistic removal: my reaction disappears before the tombstone
            // returns through the shape stream
            existing.count = Math.max(0, existing.count - 1);
            existing.hasMine = false;
            existing.status = item.status;
            if (existing.count === 0) {
                delete merged[item.messageId][item.emoji];
                if (Object.keys(merged[item.messageId]).length === 0) delete merged[item.messageId];
            }
        }
    }

    return merged;
});

const handleToggleReaction = async (messageId, emoji) => {
    if (!peerHash.value || !dialogHash.value) return;

    // React to the exact revision the user is looking at. A message that has
    // not round-tripped yet has no sign_hash — reacting to it would produce a
    // signed mutation with an invalid empty target.
    const message = decryptedMessages.value.find((m) => m.id === messageId);
    const messageSignHash = message?._raw?.sign_hash;
    if (!messageSignHash) {
        console.warn('[chat] reaction skipped: message not synced yet', messageId);
        return;
    }

    try {
        // The store owns the optimistic state (deterministic reaction_hash,
        // desired end state) — see dialogs.store toggleReaction
        await $dialogs.toggleReaction(peerHash.value, { messageId, messageSignHash, emoji });
    } catch (e) {
        console.error("Failed to toggle reaction:", e);
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
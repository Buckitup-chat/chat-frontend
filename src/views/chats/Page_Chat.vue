<template>
    <div class="h-100 w-100">
        <ChatWindow :title="chatName" :avatarUrl="avatarUrl" :avatarHash="avatarHash" :messages="displayMessages"
            :showAuthorName="false" :my-hash="$userPQ.currentUserHash" :reactions="displayReactions"
            :version-counts="versionCountByMsgId"
            :downloads="downloadsByFileId" :images="imagesByFileId"
            :availability="availabilityByFileId" :videos="videosByFileId"
            @show-history="handleShowHistory" @delete-message="handleDeleteMessage"
            @send-file="handleSendFile" @download-file="handleDownloadFile" @show-file-state="handleShowFileState" @discard-message="(id) => $dialogs.removeOptimisticItem(id)"
            @show-image="handleShowImage" @play-video="handlePlayVideo"
            @sendMessage="handleSendMessage"
            @toggleReaction="handleToggleReaction" @editMessage="handleEditMessage"
            @acknowledgeMessage="handleAcknowledge">
            <template #above-input><TransferPanel :current-peer="peerHash" /></template>
        </ChatWindow>
        <EditHistoryModal v-if="editHistory"
            :current-text="editHistory.msg.text"
            :current-sign-hash="editHistory.msg._raw?.sign_hash || ''"
            :current-time="editHistory.msg.timestamp"
            :history="editHistory.history"
            :reactions-by-version="editHistory.reactionsByVersion"
            @close="editHistory = null" />
        <FileStateModal v-if="fileState" :part="fileState.part"
            :availability="availabilityByFileId[fileState.part.fileId] || null"
            :log="backfillLog(fileState.part.fileId)"
            :from="fileState.msg?.isMine ? 'me' : chatName"
            :sent-at="fileState.msg?.timestamp || ''"
            :checking="fileStateChecking"
            @close="fileState = null" @refresh="handleFileStateAction" />
    </div>
</template>

<style lang="scss" scoped>
@import '@/scss/variables.scss';
</style>

<script setup>
import { ref, computed, watch, inject } from 'vue';
import { useRoute } from 'vue-router';
import ChatWindow from '@/components/chat/ChatWindow.vue';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { useTransfersStore } from '@/store/transfers.store';
import TransferPanel from '@/components/chat/TransferPanel.vue';
import { getDialogCollections } from '@/lib/data/collections';
import { useCollectionRows } from '@/lib/data/useCollection';
import { getCachedMedia, putCachedMedia } from '@/lib/data/mediaCache';
import { feedOrderKey } from '@/lib/data/feedOrder';
import { recordAvailability, backfillLog } from '@/lib/data/availabilityLog';
import FileStateModal from '@/components/chat/FileStateModal.vue';
import EditHistoryModal from '@/components/chat/EditHistoryModal.vue';
import { getUserCardsCollection } from '@/lib/data/collections';
import { v7 as uuidv7 } from 'uuid';

const $route = useRoute();
const $swal = inject('$swal');
const $userPQ = userPQStore();
const $dialogs = useDialogsStore();
const $transfers = useTransfersStore();

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

// Author cards are a verification dependency, not just display data: a
// message from a first-time sender parks in the gate until their card
// arrives and verifies, so a cards tick must re-run the gate and the
// decrypt pass for anything still unverified.
const { rows: rawCards } = useCollectionRows(computed(() => getUserCardsCollection()));
watch(() => rawCards.value, async () => {
    await $dialogs.retryCardAdmissions();
    if (rawMessages.value?.length) scheduleDecrypt(rawMessages.value);
});

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
        // §3.2: deletion is a signed revision, not a disappearance. The
        // tombstone stays in the feed; reactions on it stay where they were.
        if (row.deleted_flag) {
            const date = new Date(row.owner_timestamp * 1000);
            out.push({
                id: row.message_id,
                text: '',
                parts: [],
                _deleted: true,
                isMine: row.sender_hash === $userPQ.currentUserHash,
                authorName: row.sender_hash === $userPQ.currentUserHash ? 'Me' : chatName.value,
                timestamp: `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`,
                _syncStatus: 'synced',
                _raw: row,
            });
            continue;
        }
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
            // Undecrypted and unverified entries are retried: the key or the
            // author's card or a missing parent may have arrived since.
            if (!cached || !cached._decrypted || cached._verify !== 'verified'
                || cached._contentB64 !== row.content_b64) pending.push(row);
        }

        if (pending.length > 0) {
            const name = chatName.value;
            // Admission is sequential and oldest-first: parents overwhelmingly
            // predate their children, so this order admits a chain in one
            // pass instead of parking every child behind a concurrent race.
            pending.sort((a, b) => a.owner_timestamp - b.owner_timestamp);
            const entries = [];
            for (const row of pending) {
                entries.push(await (async (row) => {
                // Gate first (chat docs: invariants/02, 04): the row proves its
                // signature and causal refs before its content is treated as a
                // message. Invalid rows render as a warning, never as content —
                // showing attacker-supplied text under a peer's name is the
                // exact failure the gate exists to stop.
                const verdict = await $dialogs.admitMessageRow(row);
                // §4.3 ✓✓: arrival is a fact, so the delivered receipt goes
                // out automatically once the row verifies — unlike "read",
                // which stays a deliberate act.
                if (verdict.status === 'verified' && row.sender_hash !== $userPQ.currentUserHash && row.sign_hash) {
                    $dialogs.sendDeliveredReceipt(peerHash.value, {
                        messageId: row.message_id, messageSignHash: row.sign_hash,
                    });
                }
                const date = new Date(row.owner_timestamp * 1000);
                const timestamp = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
                const base = {
                    id: row.message_id,
                    isMine: row.sender_hash === $userPQ.currentUserHash,
                    timestamp,
                    _syncStatus: 'synced',
                    _contentB64: row.content_b64,
                    _verify: verdict.status,
                    _dagVerified: verdict.status === 'verified' ? verdict.dagVerified : false,
                    _raw: row
                };
                if (verdict.status === 'invalid') {
                    return [row.message_id, {
                        ...base,
                        text: 'Message failed verification',
                        authorName: base.isMine ? 'Me' : name,
                        _decrypted: false,
                        _verifyReason: verdict.reason,
                    }];
                }
                const decrypted = await $dialogs.decryptMessageRow(row);
                return [row.message_id, {
                    ...base,
                    text: decrypted.text,
                    parts: decrypted.parts || [],
                    authorName: decrypted.isMine ? 'Me' : name,
                    _decrypted: decrypted.decrypted === true,
                }];
                })(row));
            }
            // Apply only if the user is still looking at the same dialog
            if (generation !== dialogGeneration) return;
            for (const [id, entry] of entries) messageCache.set(id, entry);
        }

        // Reconcile stale 'waiting' snapshots: a batch admits concurrently
        // with the gate's own cascade, so a child can be drained to verified
        // inside the gate after its UI entry was already written as waiting.
        for (const entry of messageCache.values()) {
            if (entry._verify === 'waiting' && entry._raw?.sign_hash
                && $dialogs.isMessageAdmitted(entry._raw.dialog_hash, entry._raw.message_id, entry._raw.sign_hash)) {
                entry._verify = 'verified';
                entry._dagVerified = true;
            }
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


// §3.1: archived revisions per message. The count rides on the "edited"
// label; the decrypted list loads on demand when the user opens it.
const { rows: rawVersions } = useCollectionRows(computed(() => dialogCollections.value?.versions ?? null));
const versionCountByMsgId = computed(() => {
    const out = {};
    for (const v of rawVersions.value || []) out[v.message_id] = (out[v.message_id] || 0) + 1;
    return out;
});

// Archived revisions are known revisions. An edit moves the old revision
// into the versions table and gives the tip a new sign_hash — refs that
// pinned the pre-edit revision would otherwise wait forever for a row that
// no longer exists among the tips. Feeding versions through the gate lets
// those refs resolve and drains whatever was parked on them; the decrypt
// pass then reconciles any entry still marked waiting.
watch(() => rawVersions.value, async (rows) => {
    if (!rows?.length) return;
    for (const row of rows) {
        try { await $dialogs.admitMessageRow(row); }
        catch (e) { console.warn('Version admission failed:', row.message_id, e); }
    }
    if (rawMessages.value?.length) scheduleDecrypt(rawMessages.value);
}, { immediate: true });

// Screen 06: the edit history opens as its own view, differences highlighted
// inside the text, reactions pinned to the exact version they were made on.
const editHistory = ref(null); // { msg, history, reactionsByVersion }

const fmtClock = (unixSec) => {
    const d = new Date(unixSec * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const handleShowHistory = async (messageId) => {
    const msg = decryptedMessages.value.find((m) => m.id === messageId);
    if (!msg) return;
    const history = (await $dialogs.getMessageHistory(dialogHash.value, messageId))
        .map((v) => ({ ...v, time: v.ownerTimestamp ? fmtClock(v.ownerTimestamp) : '' }));

    // Reactions belong to the exact version: group verified ones by the
    // message_sign_hash they were made against, historical revisions included.
    const reactionsByVersion = {};
    for (const r of rawAllReactions.value || []) {
        if (r.message_id !== messageId || r.deleted_flag) continue;
        if (!verifiedReactionKeys.value.has(`${r.reaction_hash}|${r.owner_timestamp}`)) continue;
        // the emoji itself is encrypted; the aggregated view already decrypts
        // current-revision ones — for history the count is what matters
        (reactionsByVersion[r.message_sign_hash] ??= []).push('•');
    }
    editHistory.value = { msg, history, reactionsByVersion };
};
watch(dialogHash, () => { editHistory.value = null; });

// Reactions (deleted rows filtered below — the shape carries the full table slice)
const { rows: rawAllReactions } = useCollectionRows(computed(() => dialogCollections.value?.reactions ?? null));

// A reaction belongs to a specific message revision. Editing a message
// produces a new revision, and reactions made on the previous one are NOT
// carried over to it — reacting again moves the row to the new revision.
// Messages are versioned; reactions are not.
const currentSignHashOf = (messageId) =>
    (rawMessages.value || []).find((m) => m.message_id === messageId)?.sign_hash;

// Signature admission is async; the verified key set is refreshed per sync
// tick and the computed below filters on it, so a forged reaction never
// renders even transiently.
const verifiedReactionKeys = ref(new Set());
watch(() => rawAllReactions.value, async (rows) => {
    if (!rows) return;
    const keys = new Set();
    for (const r of rows) {
        if (r.deleted_flag) continue;
        if (await $dialogs.admitReactionRow(r)) keys.add(`${r.reaction_hash}|${r.owner_timestamp}`);
    }
    verifiedReactionKeys.value = keys;
}, { immediate: true });

const rawReactions = computed(() =>
    rawAllReactions.value.filter(
        (r) => !r.deleted_flag
            && verifiedReactionKeys.value.has(`${r.reaction_hash}|${r.owner_timestamp}`)
            && r.message_sign_hash === currentSignHashOf(r.message_id)
    )
);

// Read receipts. Plaintext by design (the server answers unread counts without
// keys), append-only, and bound to one message revision — an edited message
// needs its own acknowledgement.
const { rows: rawReceipts } = useCollectionRows(computed(() => dialogCollections.value?.receipts ?? null));

// message_id -> { mine: bool, peers: [user_hash] } for the displayed revision
// Same admission as reactions: a read receipt is a signed claim by a peer,
// and an unverified one must not flip a message to "read".
const verifiedReceiptKeys = ref(new Set());
watch(() => rawReceipts.value, async (rows) => {
    if (!rows) return;
    const keys = new Set();
    for (const r of rows) {
        if (await $dialogs.admitReceiptRow(r)) keys.add(`${r.receipt_hash}|${r.owner_timestamp}`);
    }
    verifiedReceiptKeys.value = keys;
}, { immediate: true });

const receiptsByMsgId = computed(() => {
    const me = $userPQ.currentUserHash;
    const out = {};
    for (const r of rawReceipts.value || []) {
        if (!verifiedReceiptKeys.value.has(`${r.receipt_hash}|${r.owner_timestamp}`)) continue;
        if (r.message_sign_hash !== currentSignHashOf(r.message_id)) continue;
        const entry = out[r.message_id] || (out[r.message_id] = { mine: false, peers: [], deliveredPeers: [] });
        if (r.type === 'delivered') {
            if (r.peer_hash !== me && !entry.deliveredPeers.includes(r.peer_hash)) entry.deliveredPeers.push(r.peer_hash);
            continue;
        }
        if (r.type !== 'read') continue;
        if (r.peer_hash === me) entry.mine = true;
        else if (!entry.peers.includes(r.peer_hash)) entry.peers.push(r.peer_hash);
    }
    return out;
});

// Deliberate act, never automatic: sending is driven by a button, not by the
// message appearing on screen. A receipt cannot be withdrawn (the table has no
// deleted_flag), so it must not be produced as a side effect of scrolling.
const pendingReceipts = ref(new Set());

const handleAcknowledge = async (messageId) => {
    if (!peerHash.value || !dialogHash.value) return;
    if (pendingReceipts.value.has(messageId)) return;

    const message = decryptedMessages.value.find((m) => m.id === messageId);
    const messageSignHash = message?._raw?.sign_hash;
    if (!messageSignHash) {
        console.warn('[chat] receipt skipped: message not synced yet', messageId);
        return;
    }

    pendingReceipts.value = new Set(pendingReceipts.value).add(messageId);
    try {
        await $dialogs.sendReadReceipt(peerHash.value, { messageId, messageSignHash });
    } catch (e) {
        console.error('Failed to send read receipt:', e);
        $swal.fire({
            icon: 'error',
            title: 'Confirmation not sent',
            text: e?.message || 'Could not publish the read receipt. Please try again.',
        });
    } finally {
        const next = new Set(pendingReceipts.value);
        next.delete(messageId);
        pendingReceipts.value = next;
    }
};

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
        // The confirmed state must also match the revision the intent targeted:
        // a row still pointing at the previous revision has not yet absorbed
        // this click, even though it is live.
        const serverRows = rawAllReactions.value;
        for (const item of $dialogs.optimisticItems.values()) {
            if (item.type !== 'reaction' || item.dialogHash !== dialogHashVal) continue;
            const serverRow = serverRows.find((r) => r.reaction_hash === item.reactionHash);
            if (!serverRow) continue;
            const confirmedActive =
                !serverRow.deleted_flag && serverRow.message_sign_hash === currentSignHashOf(item.messageId);
            if (confirmedActive === item.desiredActive) {
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

    // Overlay in-flight / failed edits: show the attempted text and mark its
    // state, so a rejected versioned edit is not indistinguishable from an
    // accepted one.
    const withEdits = decryptedMessages.value.map((m) => {
        const pending = pendingEdits.value.get(m.id);
        const base = pending ? { ...m, text: pending.text, _editStatus: pending.status } : { ...m };
        const receipt = receiptsByMsgId.value[m.id];
        base._acknowledgedByMe = !!receipt?.mine;
        base._acknowledgedByPeers = receipt?.peers?.length || 0;
        base._deliveredToPeers = receipt?.deliveredPeers?.length || 0;
        base._acknowledgePending = pendingReceipts.value.has(m.id);
        return base;
    });

    // Ordered by AUTHORING time (the UUIDv7 inside message_id), not by
    // owner_timestamp: that is the revision counter, an edit must raise it,
    // and sorting by it teleported edited messages to the end of the feed.
    return [...activeOptimistic, ...withEdits].sort((a, b) =>
        feedOrderKey(a.id, a._raw?.owner_timestamp || a.ownerTimestamp || 0)
        - feedOrderKey(b.id, b._raw?.owner_timestamp || b.ownerTimestamp || 0));
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

// ---------- §2.3 downloads ----------

// One batch = one composed message (screen 02); the queue store owns the
// rest — per-row pause/resume/cancel, ordering, and sending the message when
// the last live row lands.
const handleSendFile = (files, caption) => {
    $transfers.enqueueBatch(peerHash.value, files, caption).catch((e) => {
        console.error('Failed to enqueue transfers:', e);
    });
};

// §1.3: images fetch themselves — the picture IS the message, so waiting for
// a tap would leave the bubble showing a blur nobody asked to resolve.
// Decrypted bytes live in the module-level media cache: chunks are immutable,
// so re-entering the dialog reuses the picture instead of re-downloading it.
const imagesByFileId = ref({});

const fetchImage = async (part) => {
    const id = part.fileId;
    if (imagesByFileId.value[id]?.url || imagesByFileId.value[id]?.status === 'downloading') return;

    const cached = getCachedMedia(id);
    if (cached) {
        imagesByFileId.value = { ...imagesByFileId.value, [id]: { status: 'done', url: cached } };
        return;
    }

    imagesByFileId.value = { ...imagesByFileId.value, [id]: { status: 'downloading', done: 0, total: 0 } };
    try {
        const bytes = await $dialogs.fetchFile(part, {
            onProgress: (p) => {
                const cur = imagesByFileId.value[id];
                if (cur?.status === 'downloading') {
                    imagesByFileId.value = { ...imagesByFileId.value, [id]: { status: 'downloading', done: p.done, total: p.total } };
                }
            },
        });
        const url = putCachedMedia(id, bytes, part.mimeType || 'image/*');
        imagesByFileId.value = { ...imagesByFileId.value, [id]: { status: 'done', url } };
    } catch (e) {
        console.error('Image download failed:', e);
        imagesByFileId.value = { ...imagesByFileId.value, [id]: { status: 'error' } };
    }
};

// Kick off fetches for images that appeared in the rendered list.
watch(() => decryptedMessages.value, (msgs) => {
    for (const m of msgs || []) {
        for (const p of m.parts || []) {
            if (p.kind === 'image') fetchImage(p);
        }
    }
});

// The carousel lives in ChatWindow; the page only has to make sure the
// frame the user opened is actually being fetched (a failed one retries).
const handleShowImage = (part) => fetchImage(part);

// Per-dialog view state resets; the media cache underneath persists, so a
// return to this dialog repopulates instantly from it.
watch(dialogHash, () => {
    imagesByFileId.value = {};
});

// §2.4: how much of each attachment this node can serve. Checked once per
// attachment when it first appears — the answer only changes as chunks
// arrive, and a download attempt refreshes it.
const availabilityByFileId = ref({});
const availabilityAsked = new Set();

const checkAvailability = async (fileId) => {
    try {
        const a = await $dialogs.getFileAvailability(fileId);
        availabilityByFileId.value = { ...availabilityByFileId.value, [fileId]: a };
        // Screen 05 "Ход добора": what this client has observed, when.
        if (!a.unknown) recordAvailability(fileId, a.present, a.total);
    } catch (e) {
        console.warn('Availability check failed for', fileId, e);
    }
};

// ---------- screen 05: file state ----------

const fileState = ref(null); // { part, msg }
const fileStateChecking = ref(false);

const handleShowFileState = (part, msg) => {
    fileState.value = { part, msg };
    checkAvailability(part.fileId);
};

// One button, two honest meanings: complete → download; partial → re-poll
// the counts now (the closest a client can get to "prioritize this").
const handleFileStateAction = async () => {
    const st = fileState.value;
    if (!st) return;
    const a = availabilityByFileId.value[st.part.fileId];
    if (a && !a.unknown && a.present >= a.total) {
        fileState.value = null;
        await handleDownloadFile(st.part);
        return;
    }
    fileStateChecking.value = true;
    try { await checkAvailability(st.part.fileId); }
    finally { fileStateChecking.value = false; }
};

watch(() => decryptedMessages.value, (msgs) => {
    for (const m of msgs || []) {
        for (const p of m.parts || []) {
            if ((p.kind === 'file' || p.kind === 'image') && !availabilityAsked.has(p.fileId)) {
                availabilityAsked.add(p.fileId);
                checkAvailability(p.fileId);
            }
        }
    }
});

watch(dialogHash, () => {
    availabilityByFileId.value = {};
    availabilityAsked.clear();
});

// §1.4: a video opens on demand — streaming through the Service Worker when
// it is available, or as a downloaded blob when it is not.
const videosByFileId = ref({});
const videoSources = new Map();

const handlePlayVideo = async (part) => {
    const id = part.fileId;
    if (videosByFileId.value[id]?.url) return;
    videosByFileId.value = { ...videosByFileId.value, [id]: { status: 'opening' } };
    try {
        const source = await $dialogs.openVideoSource(part, {
            onProgress: (p) => {
                const cur = videosByFileId.value[id] || {};
                videosByFileId.value = {
                    ...videosByFileId.value,
                    [id]: { ...cur, status: cur.url ? cur.status : 'opening', done: p.done, total: p.total },
                };
            },
            // §1.4 "играть можно с первого куска": the prefix becomes a
            // playable src immediately; the full file replaces it when done.
            onPartial: (url) => {
                videosByFileId.value = {
                    ...videosByFileId.value,
                    [id]: { ...videosByFileId.value[id], status: 'ready', url, partial: true },
                };
            },
        });
        videoSources.set(id, source);
        videosByFileId.value = {
            ...videosByFileId.value,
            [id]: { status: 'ready', url: source.url, streaming: source.streaming, partial: false },
        };
    } catch (e) {
        console.error('Video open failed:', e);
        videosByFileId.value = { ...videosByFileId.value, [id]: { status: 'error' } };
    }
};

// Video state survives dialog switches on purpose: streaming sessions are a
// map entry in the worker, downloaded videos live in the media cache — both
// cheap to keep, and re-entering the chat replays without re-fetching.

const downloadsByFileId = ref({});

const handleDownloadFile = async (filePart) => {
    const fileId = filePart.fileId;
    downloadsByFileId.value = { ...downloadsByFileId.value, [fileId]: { status: 'downloading', done: 0, total: 0 } };
    try {
        const bytes = await $dialogs.fetchFile(filePart, {
            onProgress: (p) => {
                downloadsByFileId.value = { ...downloadsByFileId.value, [fileId]: { status: 'downloading', done: p.done, total: p.total } };
            },
        });
        // Decrypted client-side; hand the plaintext to the browser's save flow.
        const blob = new Blob([bytes], { type: filePart.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filePart.name || 'file';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        downloadsByFileId.value = { ...downloadsByFileId.value, [fileId]: { status: 'done' } };
    } catch (e) {
        console.error('Download failed:', e);
        downloadsByFileId.value = { ...downloadsByFileId.value, [fileId]: { status: 'error' } };
        // A failure usually means chunks are still travelling — re-read the
        // counts so the row can say how far along it is instead of just "failed".
        checkAvailability(fileId);
    }
};

const handleDeleteMessage = async (messageId) => {
    try {
        await $dialogs.deleteMessage(peerHash.value, messageId);
    } catch (e) {
        console.error('Failed to delete message:', e);
    }
};

const handleSendMessage = (text, replyTo = null) => {
    if (!text.trim() || !peerHash.value || !dialogHash.value) return;
    const dialogHashVal = dialogHash.value;
    const nowSec = Math.floor(Date.now() / 1000);
    const messageId = "dmsg_" + uuidv7();

    // A reply is a composed message: the quote part carries a snapshot of the
    // cited content, so it stays readable whatever happens to the original.
    const content = replyTo
        ? [{
            kind: 'quote',
            authorHash: replyTo.authorHash,
            messageId: replyTo.messageId,
            signHash: replyTo.signHash,
            snapshot: replyTo.snapshot,
        }, { kind: 'text', text: text.trim() }]
        : text.trim();

    const optimisticId = $dialogs.addOptimisticMessageWithId(dialogHashVal, messageId, text.trim(), nowSec);

    (async () => {
        try {
            await $dialogs.sendMessage(peerHash.value, content, (status) => {
                $dialogs.updateOptimisticStatus(optimisticId, status);
            }, messageId, nowSec);
        } catch (e) {
            console.error("Failed to send message:", e);
            $dialogs.updateOptimisticStatus(optimisticId, 'error');
        }
    })();
};

// A versioned edit can legitimately fail (stale base tip, node unreachable).
// The editor closes immediately on save, so without this the attempted text
// would be indistinguishable from an accepted one — only a console line.
const pendingEdits = ref(new Map()); // message_id -> { text, status, error }

const handleEditMessage = async (messageId, newText) => {
    if (!peerHash.value || !newText.trim()) return;
    const text = newText.trim();
    pendingEdits.value.set(messageId, { text, status: 'syncing' });
    pendingEdits.value = new Map(pendingEdits.value);
    try {
        await $dialogs.editMessage(peerHash.value, messageId, text);
        pendingEdits.value.delete(messageId);
        pendingEdits.value = new Map(pendingEdits.value);
    } catch (e) {
        console.error("Failed to edit message:", e);
        pendingEdits.value.set(messageId, { text, status: 'error', error: e });
        pendingEdits.value = new Map(pendingEdits.value);
        $swal.fire({
            icon: 'error',
            title: 'Edit not saved',
            text: 'The edited message could not be sent. The original text is still what others see.',
        });
    }
};

const retryEdit = (messageId) => {
    const pending = pendingEdits.value.get(messageId);
    if (pending) handleEditMessage(messageId, pending.text);
};
</script>
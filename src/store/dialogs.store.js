import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { getDialogCollections, withDialogCollections } from '@/lib/data/collections';
import { IngestError, DurabilityError } from '@/lib/data/ingest';
import { enqueueIntent, updateIntent, getIntent, intentsOf, resolveIntent, onIntentChange, markIntentAwaitingUnlock } from '@/lib/data/intents';
import { saveProjection, updateProjection, removeProjection, projectionsOf } from '@/lib/data/messageProjections';
import { signAndDispatchIntent, isUnsignedDialogIntent, IntentChangedError, withIntentSigningLock } from '@/lib/data/intentRecovery';
import {
    materializeMessageIntent, ensureOwnDialogKeyPublished, ownSenderMsgKey, trustedRowBase,
    pinActiveSession, assertSessionUnchanged, SessionFencedError,
} from '@/lib/data/messageIntent';
import { VaultLockedError } from '@/lib/data/keyCustody';
import { nextOwnerTimestamp } from '@/lib/data/time';
import { computeTails } from '@/lib/data/refs';
import { getAccepted, getAllAcceptedForRelation } from '@/lib/data/acceptedSnapshot';
import { recordOwnObservedTails, getOwnObservedTails, discardOwnObservedTails } from '@/lib/data/ownObservedTails';
import { quarantinedEntries, discardEntry, currentSessionToken, sameSessionToken, pendingEntries, awaitServerAccepted, onOutboxChange } from '@/lib/data/outbox';
import { feedOrderKey } from '@/lib/data/feedOrder';
import { loadPointer, savePointer, viewMoved, pointerDialogs, rememberPointerDialog } from '@/lib/data/checkpointAlerts';
import { createDialogGate } from '@/lib/data/dialogGate';
import { verifyReplicatedRow } from '@/lib/data/rowVerification';
import { projectionReplacement } from '@/lib/data/operationLifecycle';
import { decodeContent, contentToText, previewText, isWireMessageId, ContentDecodeError } from '@/lib/pq/content';
import {
    CHECKPOINT_VERSION, REDUCER_VERSION, TREE_VERSION,
    deriveFrontierRoot, buildViewTree, diffViewTrees, classifyChanges,
} from '@/lib/pq/checkpoint';
import { prepareUpload, uploadFile, downloadFile, fileAvailability } from '@/lib/data/fileTransfer';
import { buildImagePreview, buildVideoPreview, isImageMime, isVideoMime } from '@/lib/data/imageMeta';
import { openVideo } from '@/lib/data/videoStream';
import { getVerifiedSignPkey } from '@/lib/data/cardRegistry';
import { mergeLiveWithCached } from '@/lib/data/readCache';
import { readDialogRow, readDialogRows } from '@/lib/data/dialogCache';
import { settled } from '@/lib/data/shapeLink';
import { DialogCrypto } from '@/libs/DialogCrypto';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { decodeHexOrBase64 } from '@/libs/enigma';

const safeBase64Decode = (str, fieldName) => {
    const result = decodeHexOrBase64(str);
    if (!result) throw new Error(`${fieldName} is empty`);
    return result;
};

export const useDialogsStore = defineStore('dialogs', () => {
    const $userPQ = userPQStore();

    // Cache of derived / unwrapped keys to avoid repeated computation
    const senderMsgKeys = ref({}); // { [dialogHash_authorHash]: Uint8Array }

    // Optimistic (in-flight) items shown in UI before DB round-trip
    const optimisticItems = ref(new Map()); // id -> { type, dialogHash, status, ... }
    let optimisticCounter = 0;

    // --- dialog writes ---
    // Every write is a durable intent, signed once into an immutable snapshot
    // and sent by the account's sender (intentRecovery → outbox).

    const getSignSkeyBytes = async () => {
        const em = EncryptionManagerPQ.getInstance();
        const keys = await em.exportVaultKeys();
        return safeBase64Decode(keys.sign_skey, 'sign_skey');
    };


    // --- causal refs (refs_map) ---
    // Decrypted refs of a specific revision never change; cache by
    // (message_id, sign_hash). An edit produces a new sign_hash → new entry.
    const decryptedRefsCache = new Map();

    // Returns null for "unknown" (key not here yet / undecryptable blob) —
    // never cached, so the refs are retried once the key arrives. Caching a
    // failure as {} used to be permanent: the cache key is the immutable
    // revision, while messages DO recover on key arrival, so the two states
    // diverged forever and every later send shipped inflated tails.
    const decryptRefsOf = async (row, colls = null) => {
        const cacheKey = `${row.message_id}|${row.sign_hash}`;
        if (decryptedRefsCache.has(cacheKey)) return decryptedRefsCache.get(cacheKey);

        // Genesis and refs-less revisions legitimately have no map
        if (!row.refs_map_b64) {
            decryptedRefsCache.set(cacheKey, {});
            return {};
        }

        const key = await getSenderMsgKey(row.dialog_hash, row.sender_hash, colls);
        if (!key) return null;

        try {
            const json = await DialogCrypto.decryptContent(key, row.refs_map_b64);
            const refs = json ? JSON.parse(json) : {};
            decryptedRefsCache.set(cacheKey, refs);
            return refs;
        } catch (e) {
            console.warn('[dialogs] refs decrypt failed for', row.message_id, e);
            return null;
        }
    };

    // ---------- receive verification gate ----------
    //
    // A replicated row is not a message until it verifies (lib/data/dialogGate):
    // author card resolves, signature holds, causal refs admit. One gate per
    // dialog; verdicts feed the render path, which shows unverified rows as
    // such instead of trusting whatever Electric delivered.

    const dialogGates = new Map(); // dialogHash -> gate

    // The gate distinguishes "no key yet" (normal right after joining) from
    // "key present but the blob will not decrypt" (only reachable through a
    // sender bug, since the signature covers the ciphertext).
    const decryptRefsVerdict = async (row, colls = null) => {
        const key = await getSenderMsgKey(row.dialog_hash, row.sender_hash, colls);
        if (!key) return 'no_key';
        const refs = await decryptRefsOf(row, colls);
        return refs === null ? 'error' : refs;
    };

    const gateFor = (dialogHash) => {
        let gate = dialogGates.get(dialogHash);
        if (!gate) {
            gate = createDialogGate({
                resolveSignPkey: (userHash) => getVerifiedSignPkey(userHash),
                decryptRefs: decryptRefsVerdict,
            });
            dialogGates.set(dialogHash, gate);
        }
        return gate;
    };

    /**
     * Gate verdict for a replicated message row. See dialogGate for shapes.
     * `colls`: the dialog collections to read keys through (a transient scan
     * bundle); otherwise the registered ones.
     */
    const admitMessageRow = (row, colls = null) => gateFor(row.dialog_hash).admit(row, colls);

    // Reactions and receipts are signed rows too (invariants/02): a forged
    // reaction under a peer's name is the same attack as a forged message.
    // Verdicts are cached by (PK, owner_timestamp) — a re-signed update gets
    // a fresh check, an unchanged row does not re-run ML-DSA on every render.
    const sideRowVerdicts = new Map();

    const admitSideRow = async (row, relation, pkField) => {
        const cacheKey = `${row[pkField]}|${row.owner_timestamp}`;
        const cached = sideRowVerdicts.get(cacheKey);
        if (cached !== undefined) return cached;

        const verification = await verifyReplicatedRow(relation, row, getVerifiedSignPkey);
        if (verification.status === 'unavailable') return false; // card not here yet — retried, not cached

        const ok = verification.status === 'verified';
        sideRowVerdicts.set(cacheKey, ok);
        return ok;
    };

    /** True only for a reaction whose signature verifies against its reactor. */
    const admitReactionRow = (row) => admitSideRow(row, 'dialog_message_reactions', 'reaction_hash');

    /** True only for a receipt whose signature verifies against its peer. */
    const admitReceiptRow = (row) => admitSideRow(row, 'dialog_message_receipts', 'receipt_hash');

    /** True when the gate has admitted ANY presentation for this (message_id,
     * sign_hash) reference — a DAG-reference / "does a revision with this
     * identity exist at all" question. Not exact-row-aware: two different
     * presentations can share a reference (one reusing another's spent
     * sign_hash/sign_b64 over changed fields), so this alone must never
     * promote a *specific* cached UI entry — see isRowAdmitted below. */
    const isMessageAdmitted = (dialogHash, messageId, signHash) =>
        dialogGates.get(dialogHash)?.isAdmitted(messageId, signHash) ?? false;

    const blockedByOf = (dialogHash, row) =>
        (row?.sign_hash && dialogGates.get(dialogHash)?.getBlockedBy(row.message_id, row.sign_hash)) || null;

    const isRevisionTerminal = (dialogHash, messageId, signHash) =>
        dialogGates.get(dialogHash)?.isTerminal(messageId, signHash) ?? false;

    const isRowAdmitted = (dialogHash, row) =>
        dialogGates.get(dialogHash)?.isRowAdmitted(row) ?? false;

    /** Re-checks rows parked on absent author cards; call when user_cards sync. */
    const retryCardAdmissions = async () => {
        for (const gate of dialogGates.values()) await gate.retryAwaitingCards();
    };

    const ownSentMessageIds = new Map(); // dialogHash -> Set(messageId)
    const trackOwnSentMessage = (dialogHash, messageId) => {
        const set = ownSentMessageIds.get(dialogHash) ?? new Set();
        set.add(messageId);
        ownSentMessageIds.set(dialogHash, set);
    };


    const verifiedRefsOf = async (row, ownerHash) => {
        if (!row.refs_map_b64) return {};
        if (row.sender_hash === ownerHash) {
            const own = await getOwnObservedTails(row.message_id);
            if (own) return own;
        }
        const cacheKey = `${row.message_id}|${row.sign_hash}`;
        return decryptedRefsCache.has(cacheKey) ? decryptedRefsCache.get(cacheKey) : null;
    };

    const captureObservedTails = async (dialogHash, ownerHash) => {
        const colls = getDialogCollections(dialogHash);
        const resident = colls.messages.toArray.filter((r) => r.sign_hash);
        const loaded = resident.filter((r) => isMessageAdmitted(dialogHash, r.message_id, r.sign_hash));

        const knownIds = new Set(loaded.map((r) => r.message_id));
        const accepted = await getAllAcceptedForRelation('dialog_messages');
        const extra = accepted.filter((r) =>
            r.dialog_hash === dialogHash && r.sender_hash === ownerHash &&
            r.sign_hash && !knownIds.has(r.message_id) &&
            !isRevisionTerminal(dialogHash, r.message_id, r.sign_hash)
        );
        for (const r of extra) knownIds.add(r.message_id);

        const pending = await pendingEntries(ownerHash);
        const extraPending = [];
        for (const entry of pending) {
            if (entry.relation !== 'dialog_messages') continue;
            for (const mutation of entry.mutations) {
                const row = mutation?.modified ?? mutation?.changes ?? null;
                if (!row || row.dialog_hash !== dialogHash || row.sender_hash !== ownerHash) continue;
                if (!row.sign_hash || knownIds.has(row.message_id)) continue;
                if (isRevisionTerminal(dialogHash, row.message_id, row.sign_hash)) continue;
                knownIds.add(row.message_id);
                extraPending.push(row);
            }
        }

        const withRefs = await Promise.all(
            [...loaded, ...extra, ...extraPending].map(async (r) => ({
                message_id: r.message_id,
                sign_hash: r.sign_hash,
                refs: await verifiedRefsOf(r, ownerHash),
            }))
        );
        return computeTails(withRefs);
    };

    const formatTimestamp = (ts) => {
        const d = new Date(ts * 1000);
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    };

    const addOptimisticMessage = (dialogHash, text) => {
        const id = `opt_msg_${++optimisticCounter}_${Date.now()}`;
        return addOptimisticMessageWithId(dialogHash, id, text);
    };

    const addOptimisticMessageWithId = (dialogHash, id, text, ownerTimestamp = null) => {
        const nowSec = ownerTimestamp || Math.floor(Date.now() / 1000);
        optimisticItems.value.set(id, {
            type: 'message',
            id,
            dialogHash,
            text,
            authorName: 'Me',
            isMine: true,
            timestamp: formatTimestamp(nowSec),
            ownerTimestamp: nowSec,
            status: 'sending',
        });
        return id;
    };

    // Optimistic reaction records the DESIRED end state and the deterministic
    // reaction_hash. Reconciliation matches server rows (including tombstones)
    // by hash — an un-react confirms as a tombstone, which carries no emoji,
    // so matching by emoji alone could never confirm removals.
    // One optimistic item per reaction (dialog|message|emoji): the latest toggle
    // replaces it. Its reaction_hash needs the key, so it is filled in at signing.
    const addOptimisticReaction = (dialogHash, messageId, emoji, logicalKey, desiredActive) => {
        for (const [staleId, item] of optimisticItems.value) {
            if (item.type === 'reaction' && item.logicalKey === logicalKey) {
                optimisticItems.value.delete(staleId);
            }
        }
        const id = `opt_react_${++optimisticCounter}_${Date.now()}`;
        optimisticItems.value.set(id, {
            type: 'reaction',
            id,
            dialogHash,
            messageId,
            emoji,
            logicalKey,
            reactionHash: null,
            desiredActive,
            status: 'sending',
        });
        return id;
    };

    const updateOptimisticStatus = (id, status) => {
        const item = optimisticItems.value.get(id);
        if (item) item.status = status;
    };

    const sessionProjections = new Map();

    const setProjectionSignHash = (owner, messageId, signHash) => {
        const item = optimisticItems.value.get(messageId);
        if (item) item.signHash = signHash;
        const tracked = sessionProjections.get(messageId);
        if (tracked) tracked.signHash = signHash;
        updateProjection(owner, messageId, { signHash }).catch((e) =>
            console.error('[dialogs] could not record the signed revision on the projection of', messageId, e));
    };

    const messageIdOfRow = (m) => (m?.modified ?? m?.changes)?.message_id;

    const lifecycleOfProjections = async (owner, ids) => {
        const want = new Set(ids);
        const out = new Map();
        const [pending, quarantined, intents] = await Promise.all([
            pendingEntries(owner), quarantinedEntries(owner), intentsOf(owner),
        ]);
        for (const e of pending) {
            if (e.relation !== 'dialog_messages') continue;
            for (const m of e.mutations || []) {
                const id = messageIdOfRow(m);
                if (!want.has(id)) continue;
                const accepted = e.status === 'server_accepted_pending_reconcile' || !!e.reconciledAt;
                out.set(id, { status: accepted ? 'synced' : 'queued', signHash: (m.modified ?? m.changes)?.sign_hash ?? null });
            }
        }
        for (const e of quarantined) {
            if (e.relation !== 'dialog_messages') continue;
            for (const m of e.mutations || []) {
                const id = messageIdOfRow(m);
                if (want.has(id)) out.set(id, { status: 'error', signHash: (m.modified ?? m.changes)?.sign_hash ?? null });
            }
        }
        for (const i of intents.entries) {
            if (i.relation !== 'dialog_messages') continue;
            const id = i.intent?.messageId ?? i.intent?.row?.message_id;
            if (!want.has(id) || out.has(id)) continue;
            const signed = i.intent?.signedMutation;
            out.set(id, { status: signed ? 'queued' : 'awaiting_recovery', signHash: (signed?.modified ?? signed?.changes)?.sign_hash ?? null });
        }
        for (const id of want) {
            if (out.has(id)) continue;
            const accepted = await getAccepted('dialog_messages', id, owner);
            if (accepted?.sign_hash) out.set(id, { status: 'synced', signHash: accepted.sign_hash });
        }
        return out;
    };

    const refreshProjectionStatuses = async (owner) => {
        const hydrated = [...optimisticItems.value.values()].filter((i) => i.type === 'message' && i.hydrated);
        if (!hydrated.length) return;
        const lifecycle = await lifecycleOfProjections(owner, hydrated.map((i) => i.id));
        if ($userPQ.currentUserHash !== owner) return;
        for (const item of hydrated) {
            const state = lifecycle.get(item.id);
            if (!state) continue;
            item.status = state.status;
            if (state.signHash) item.signHash = state.signHash;
        }
    };

    const hydration = { owner: null, done: false, attempt: 0, timer: null, running: null };
    const HYDRATION_RETRY_MS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];

    const scheduleHydrationRetry = (owner) => {
        if (hydration.timer || hydration.owner !== owner) return;
        const delay = HYDRATION_RETRY_MS[hydration.attempt];
        if (delay === undefined) {
            console.error('[dialogs] message projections could not be restored after repeated attempts');
            return;
        }
        hydration.attempt++;
        hydration.timer = setTimeout(() => {
            hydration.timer = null;
            void hydrateProjections(owner);
        }, delay);
    };

    const hydrateProjections = (owner) => {
        if (!owner || $userPQ.currentUserHash !== owner) return Promise.resolve();
        if (hydration.owner === owner && hydration.running) return hydration.running;
        hydration.owner = owner;
        hydration.running = (async () => {
            let unresolved = 0;
            try {
                const { projections } = await projectionsOf(owner);
                if ($userPQ.currentUserHash !== owner) return;
                const pending = projections.filter((p) => !optimisticItems.value.has(p.messageId));
                const lifecycle = pending.length ? await lifecycleOfProjections(owner, pending.map((p) => p.messageId)) : new Map();
                if ($userPQ.currentUserHash !== owner) return;
                for (const p of pending) {
                    const state = lifecycle.get(p.messageId);
                    if (!state) { unresolved++; continue; }
                    sessionProjections.set(p.messageId, { dialogHash: p.dialogHash, signHash: state.signHash ?? p.signHash ?? null });
                    optimisticItems.value.set(p.messageId, {
                        type: 'message', id: p.messageId, dialogHash: p.dialogHash, text: p.text,
                        authorName: 'Me', isMine: true, timestamp: formatTimestamp(p.ownerTimestamp),
                        ownerTimestamp: p.ownerTimestamp, status: state.status,
                        signHash: state.signHash ?? p.signHash ?? null, hydrated: true,
                    });
                }
                hydration.done = unresolved === 0;
                if (hydration.done) hydration.attempt = 0;
            } catch (e) {
                console.warn('[dialogs] message projections not restorable yet — retrying:', e?.message ?? e);
                hydration.done = false;
            } finally {
                hydration.running = null;
            }
            if (!hydration.done) scheduleHydrationRetry(owner);
        })();
        return hydration.running;
    };

    const ensureProjectionsHydrated = () => {
        const owner = $userPQ.currentUserHash;
        if (!owner || (hydration.owner === owner && hydration.done)) return Promise.resolve();
        return hydrateProjections(owner);
    };

    const retireProjections = async (dialogHash, canonicalRows) => {
        const owner = $userPQ.currentUserHash;
        if (!owner) return;
        const candidates = new Map(sessionProjections);
        for (const item of optimisticItems.value.values()) {
            if (item.type === 'message') candidates.set(item.id, { dialogHash: item.dialogHash });
        }
        for (const [id, p] of candidates) {
            if (p.dialogHash !== dialogHash) continue;
            const row = canonicalRows.get(id);
            if (!row) continue;
            const decision = await projectionReplacement('dialog_messages', id, owner, row, getVerifiedSignPkey)
                .catch((e) => {
                    console.warn('[dialogs] projection kept — its lifecycle could not be read:', id, e?.message ?? e);
                    return { replace: false };
                });
            if (!decision.replace || $userPQ.currentUserHash !== owner) continue;
            optimisticItems.value.delete(id);
            if (!sessionProjections.has(id)) continue;
            sessionProjections.delete(id);
            removeProjection(id).catch((e) =>
                console.error('[dialogs] retired projection not removed from disk (retired again after the next reload):', id, e));
        }
    };

    const retireReactionProjections = async (ids, rowOfReaction) => {
        const owner = $userPQ.currentUserHash;
        if (!owner) return;
        for (const id of ids) {
            const item = optimisticItems.value.get(id);
            if (item?.type !== 'reaction') continue;
            const decision = await projectionReplacement(
                'dialog_message_reactions', item.reactionHash, owner, rowOfReaction(item.reactionHash), getVerifiedSignPkey
            ).catch(() => ({ replace: false }));
            if (decision.replace && $userPQ.currentUserHash === owner && optimisticItems.value.get(id) === item) {
                optimisticItems.value.delete(id);
            }
        }
    };

    let projectionRefresh = null;
    const scheduleProjectionRefresh = (changedOwner) => {
        const owner = $userPQ.currentUserHash;
        if (!owner || changedOwner !== owner || projectionRefresh) return;
        projectionRefresh = Promise.resolve()
            .then(() => (hydration.done ? null : hydrateProjections(owner)))
            .then(() => refreshProjectionStatuses(owner))
            .catch((e) => console.warn('[dialogs] projection status refresh failed:', e))
            .finally(() => { projectionRefresh = null; });
    };
    const acceptanceRevision = ref(0);
    onOutboxChange((changedOwner) => {
        if (changedOwner === $userPQ.currentUserHash) acceptanceRevision.value++;
        scheduleProjectionRefresh(changedOwner);
    });
    onIntentChange(scheduleProjectionRefresh);

    const removeOptimisticItem = (id) => {
        optimisticItems.value.delete(id);
    };

    const discardQuarantinedFor = async (relation, matchField, matchValue) => {
        const userHash = $userPQ.currentUserHash;
        if (!userHash) return;
        for (const entry of await quarantinedEntries(userHash)) {
            if (entry.relation !== relation) continue;
            const row = entry.mutations[0]?.modified ?? entry.mutations[0]?.changes;
            if (row?.[matchField] === matchValue) await discardEntry(entry.id);
        }
    };

    const discardMessageLifecycle = async (messageId) => {
        await removeProjection(messageId);
        sessionProjections.delete(messageId);
        await discardQuarantinedFor('dialog_messages', 'message_id', messageId);
        const owner = $userPQ.currentUserHash;
        if (!owner) return;
        for (const i of (await intentsOf(owner)).entries) {
            if (i.relation !== 'dialog_messages') continue;
            if ((i.intent?.messageId ?? i.intent?.row?.message_id) === messageId) await resolveIntent(i.id, { outcome: 'discarded' });
        }
    };

    const discardReactionLifecycle = async (item) => {
        const owner = $userPQ.currentUserHash;
        if (owner) {
            for (const entry of (await intentsOf(owner)).entries) {
                const intent = entry.intent;
                if (intent?.kind !== 'reaction' || `${intent.dialogHash}|${intent.messageId}|${intent.emoji}` !== item.logicalKey) continue;
                await withIntentSigningLock(entry.id, async () => {
                    const fresh = await getIntent(entry.id);
                    if (fresh && isUnsignedDialogIntent(fresh.intent)) await resolveIntent(entry.id, { outcome: 'discarded' });
                });
            }
        }
        if (item.reactionHash) await discardQuarantinedFor('dialog_message_reactions', 'reaction_hash', item.reactionHash);
    };

    const discardFailedItem = (id) => {
        const item = optimisticItems.value.get(id);
        removeOptimisticItem(id);
        if (!item) return;
        const cleanup = item.type === 'message'
            ? discardMessageLifecycle(id)
            : item.type === 'reaction'
                ? discardReactionLifecycle(item)
                : null;
        cleanup?.catch((e) => console.warn('[dialogs] could not discard quarantined entry for', id, e));
    };

    const getDialogHash = (peerHash) => {
        if (!$userPQ.currentUserHash) return null;
        return DialogCrypto.computeDialogHash($userPQ.currentUserHash, peerHash);
    };

    // In-flight guard for dialog-key creation. Keyed by the PK of the row
    // being created, (dialog_hash, sender_hash): dialog_hash alone identifies
    // the DIALOG, which holds two key rows — one per direction — and is the
    // same value for both participants, so it does not identify "my" row.
    // Without this, two rapid first messages both see the row missing and both
    // publish a key: the sender_msg_key is deterministic, but its wrapping is
    // not (ML-KEM encapsulation and the GCM nonce are random), so the loser is
    // NOT an idempotent retry and fails permanently on the PK conflict.
    const pendingDialogInit = new Map();

    const initDialogKeys = async (peerHash) => {
        const dialogHash = getDialogHash(peerHash);
        if (!dialogHash) throw new Error("Not logged in");

        // Capture once: reading the store repeatedly could straddle an account
        // switch and desync the guard key from the row being written.
        const myHash = $userPQ.currentUserHash;
        const initKey = `${dialogHash}|${myHash}`;

        const inFlight = pendingDialogInit.get(initKey);
        if (inFlight) return inFlight;

        const promise = initDialogKeysUnguarded(peerHash, dialogHash, myHash);
        pendingDialogInit.set(initKey, promise);
        try {
            return await promise;
        } finally {
            if (pendingDialogInit.get(initKey) === promise) {
                pendingDialogInit.delete(initKey);
            }
        }
    };

    /**
     * Get or initialize keys for a dialog with a peer.
     * Always call through initDialogKeys — never directly.
     */
    const initDialogKeysUnguarded = async (peerHash, dialogHash, myHash) => {
        const cacheKey = `${dialogHash}_${myHash}`;

        if (senderMsgKeys.value[cacheKey]) return dialogHash;

        const token = pinActiveSession(myHash, 'initDialogKeys:start');
        await ensureOwnDialogKeyPublished(peerHash, dialogHash, myHash, token);
        senderMsgKeys.value[cacheKey] = await ownSenderMsgKey(peerHash);
        return dialogHash;
    };

    /**
     * Get a senderMsgKey (either ours or peer's)
     */
    const pendingKeys = {};

    const getSenderMsgKey = async (dialogHash, authorHash, colls = null) => {
        const cacheKey = `${dialogHash}_${authorHash}`;
        if (senderMsgKeys.value[cacheKey]) return senderMsgKeys.value[cacheKey];
        if (pendingKeys[cacheKey]) return pendingKeys[cacheKey];

        const promise = (async () => {
            const dialogColls = colls ?? getDialogCollections(dialogHash);
            const rowKey = `${dialogHash}|${authorHash}`;
            let liveRow;
            let preloadFailed = false;
            try {
                const keysState = await settled(dialogColls.keys);
                if (keysState.state === 'failed') throw keysState.error;
                liveRow = dialogColls.keys.get(rowKey);
            } catch {
                preloadFailed = true;
                try {
                    liveRow = dialogColls.keys.get(rowKey);
                } catch {
                    liveRow = undefined;
                }
            }
            const keyRow = liveRow ?? (preloadFailed ? await readDialogRow('dialog_keys', rowKey) : null);
            if (!keyRow || keyRow.dialog_hash !== dialogHash || keyRow.sender_hash !== authorHash) return null;
            if ((await verifyReplicatedRow('dialog_keys', keyRow, getVerifiedSignPkey)).status !== 'verified') return null;
            if (keyRow.deleted_flag) return null;

            // Is it our own key?
            if (authorHash === $userPQ.currentUserHash) {
                const em = EncryptionManagerPQ.getInstance();
                const keys = await em.exportVaultKeys();
                const signSkey = safeBase64Decode(keys.sign_skey, 'sign_skey');
                const kemSkey = safeBase64Decode(keys.crypt_skey, 'crypt_skey');

                const senderMsgKey = DialogCrypto.deriveSenderMsgKey(
                    signSkey, kemSkey, keys.evm_skey, keyRow.peer_hash
                );
                senderMsgKeys.value[cacheKey] = senderMsgKey;
                return senderMsgKey;
            }

            // It's a peer's key, we need to decap and unwrap — only one wrapped for us
            if (keyRow.peer_hash !== $userPQ.currentUserHash) return null;
            const em = EncryptionManagerPQ.getInstance();
            const keys = await em.exportVaultKeys();
            const cryptSkey = safeBase64Decode(keys.crypt_skey, 'crypt_skey');

            const unwrapped = await DialogCrypto.unwrapSenderMsgKey(
                cryptSkey,
                keyRow.peer_kem_wrap_key_b64,
                keyRow.peer_wrapped_msg_key_b64
            );

            senderMsgKeys.value[cacheKey] = unwrapped;
            return unwrapped;
        })();

        pendingKeys[cacheKey] = promise;
        promise.finally(() => { delete pendingKeys[cacheKey]; });
        return promise;
    };

     const captureMessageIntent = async (peerHash, content, messageId = null, ownerTimestamp = null, kind = 'message') => {
        const parts = typeof content === 'string' ? [{ kind: 'text', text: content }] : content;
        if (!messageId) {
            const { v7 } = await import('uuid');
            messageId = "dmsg_" + v7();
        }

        const ownerHash = $userPQ.currentUserHash;
        const dialogHash = getDialogHash(peerHash);
        if (!dialogHash) throw new Error('Not logged in');
        const token = pinActiveSession(ownerHash, 'captureMessageIntent:start');
        const nowSec = ownerTimestamp || nextOwnerTimestamp();

        const observedTails = await captureObservedTails(dialogHash, ownerHash);
        assertSessionUnchanged(token, 'captureMessageIntent:beforeCommit');

        await recordOwnObservedTails(messageId, observedTails, ownerHash);

        const notStored = () => new Error('This action could not be stored for sending. Nothing was sent — try again.');
        if (kind === 'message') {
            try {
                await saveProjection({
                    messageId, owner: ownerHash, relation: 'dialog_messages', dialogHash, peerHash,
                    ownerTimestamp: nowSec, createdAt: Date.now(), text: contentToText(parts), signHash: null,
                });
            } catch (e) {
                console.error('[dialogs] message projection not durable — the send is refused:', e);
                await discardOwnObservedTails(messageId, ownerHash);
                throw notStored();
            }
            sessionProjections.set(messageId, { dialogHash, signHash: null });
        }

        const payload = { kind, relation: 'dialog_messages', peerHash, dialogHash, messageId, ownerHash, ownerTimestamp: nowSec, parts, observedTails };
        const intentId = await enqueueIntent(payload, ownerHash, 'dialog_messages');
        if (intentId === null) {
            await discardOwnObservedTails(messageId, ownerHash);
            if (kind === 'message') {
                sessionProjections.delete(messageId);
                await removeProjection(messageId).catch((e) => console.error('[dialogs] orphan projection left behind (never shown):', messageId, e));
            }
            throw notStored();
        }
        trackOwnSentMessage(dialogHash, messageId);
        return { intentId, payload, token };
    };

    const intentAwaitsRecovery = async (intentId, ownerHash) => {
        const entry = await getIntent(intentId).catch(() => null);
        return !!entry && entry.userHash === ownerHash && entry.intent?.resolved !== true;
    };

    const dispatchMessageIntent = async (intentId, payload, token, onStatus) => {
        const reportOutcome = (acceptance) => acceptance.then((outcome) => {
            try {
                assertSessionUnchanged(token, 'dispatchMessageIntent:acceptanceCallback');
            } catch {
                return;
            }
            if (outcome.kind === 'accepted') onStatus?.('synced');
            else onStatus?.('error', outcome.kind === 'rejected' ? outcome.error : 'discarded before delivery');
        });
        let durableOutboxId = null;
        try {
            assertSessionUnchanged(token, 'dispatchMessageIntent:start');
            onStatus?.('syncing');
            const readyRow = await materializeMessageIntent(payload, token);
            assertSessionUnchanged(token, 'dispatchMessageIntent:beforeSigning');
            const signSkey = await getSignSkeyBytes().catch((e) => {
                throw new VaultLockedError(String(e?.message ?? e));
            });
            assertSessionUnchanged(token, 'dispatchMessageIntent:afterSignSkey');
            const handle = await signAndDispatchIntent(intentId, readyRow, signSkey, {
                token,
                onDurable: (outboxId) => { durableOutboxId = outboxId; },
                onSigned: (mutation) => {
                    const signHash = (mutation?.modified ?? mutation?.changes)?.sign_hash;
                    if (signHash) setProjectionSignHash(payload.ownerHash, payload.messageId, signHash);
                },
            });
            if (handle.phase === 'accepted') {
                try {
                    assertSessionUnchanged(token, 'dispatchMessageIntent:beforeAcceptedCallback');
                } catch {
                    return;
                }
                onStatus?.('synced');
            } else {
                reportOutcome(handle.outboxId ? awaitServerAccepted(handle.outboxId, payload.ownerHash) : handle.acceptance);
            }
        } catch (e) {
            if (e instanceof VaultLockedError) {
                console.warn('[dialogs] dispatchMessageIntent awaiting unlock:', e.message);
                onStatus?.('awaiting_unlock', e);
                return;
            }
            if (e instanceof SessionFencedError) {
                console.warn('[dialogs] dispatchMessageIntent aborted (session fenced):', e.message);
                onStatus?.('error', e);
                return;
            }
            if (durableOutboxId && !(e instanceof IngestError && e.permanent)) {
                console.warn('[dialogs] dispatchMessageIntent queued for retry:', e);
                onStatus?.('queued', e);
                reportOutcome(awaitServerAccepted(durableOutboxId, payload.ownerHash));
                return;
            }
            const permanent = e?.permanent === true || e instanceof DurabilityError;
            if (!durableOutboxId && !permanent && await intentAwaitsRecovery(intentId, payload.ownerHash)) {
                console.warn('[dialogs] dispatchMessageIntent left for recovery:', e);
                onStatus?.('awaiting_recovery', e);
                return;
            }
            console.error('[dialogs] dispatchMessageIntent failed:', e);
            onStatus?.('error', e);
        }
    };

    const sendMessage = async (peerHash, content, onStatus, messageId = null, ownerTimestamp = null, kind = 'message') => {
        const { intentId, payload, token } = await captureMessageIntent(peerHash, content, messageId, ownerTimestamp, kind);
        dispatchMessageIntent(intentId, payload, token, onStatus);
        return payload.messageId;
    };

    const writeChains = new Map();
    const chainRuns = new Map();
    const captureLocks = new Map();
    const signedOf = new Map();

    const serialized = (locks, key, fn) => {
        const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
        const settledRun = run.then(() => undefined, () => undefined);
        locks.set(key, settledRun);
        settledRun.then(() => { if (locks.get(key) === settledRun) locks.delete(key); });
        return run;
    };

    const lastIntentOf = async (owner, belongs) => {
        const { entries } = await intentsOf(owner);
        return entries.filter((e) => belongs(e.intent)).at(-1) ?? null;
    };

    /**
     * Folds `change` into a stored intent nobody has started signing, under
     * the intent's signing lock. 'signed' when it is past that point.
     */
    const updateUnsignedIntent = (intentId, change) => withIntentSigningLock(intentId, async () => {
        const fresh = await getIntent(intentId);
        if (!fresh || !isUnsignedDialogIntent(fresh.intent)) return 'signed';
        return (await updateIntent(intentId, change(fresh.intent))) ? 'updated' : 'failed';
    });

    /** Builds, signs and hands over one stored dialog intent; null when there was nothing to write. */
    const dispatchDialogIntent = async (intentId, token, onSigned) => {
        for (let attempt = 0; ; attempt++) {
            assertSessionUnchanged(token, 'dispatchDialogIntent:start');
            const entry = await getIntent(intentId);
            if (!entry) throw new Error(`intent ${intentId} not found — nothing to sign or replay`);
            const stored = entry.intent;
            const unsigned = isUnsignedDialogIntent(stored);
            try {
                const readyRow = unsigned ? await materializeMessageIntent(stored, token) : stored;
                if (readyRow === null) {
                    await resolveIntent(intentId, { outcome: 'noop' });
                    return null;
                }
                const signSkey = await getSignSkeyBytes().catch((e) => { throw new VaultLockedError(String(e?.message ?? e)); });
                return await signAndDispatchIntent(intentId, readyRow, signSkey, { token, onSigned, builtFrom: unsigned ? stored : undefined });
            } catch (e) {
                if (e instanceof IntentChangedError && attempt < 5) continue; // a later action changed it: build that
                // Under the intent's lock: a toggle folded in meanwhile is not overwritten.
                if (e instanceof VaultLockedError) {
                    await withIntentSigningLock(intentId, () => markIntentAwaitingUnlock(intentId, token.userHash)).catch(() => false);
                }
                throw e;
            }
        }
    };

    /** Runs an intent's dispatch in its chain, once; resolves after its acceptance. */
    const runOnChain = (chainKey, intentId, token, onSigned) => {
        const running = chainRuns.get(intentId);
        if (running) return running;
        const run = serialized(writeChains, chainKey, async () => {
            const handle = await dispatchDialogIntent(intentId, token, (mutation) => {
                const row = mutation?.changes ?? mutation?.modified;
                signedOf.set(intentId, { signHash: row?.sign_hash ?? null, ownerTimestamp: row?.owner_timestamp ?? null });
                onSigned?.(row);
            });
            if (handle) await handle.acceptance;
            return handle;
        });
        chainRuns.set(intentId, run);
        const forget = () => { if (chainRuns.get(intentId) === run) chainRuns.delete(intentId); };
        run.then(forget, forget);
        return run;
    };

    // The action is stored: a locked vault only defers it to the unlock, whose
    // recovery finishes it — not a failure, and nothing to do again.
    const awaitsUnlock = (run) => run.then(() => false, (e) => {
        if (e instanceof VaultLockedError) return true;
        throw e;
    });

    const messageChainOf = (messageId) => (intent) =>
        ((intent?.kind === 'edit' || intent?.kind === 'delete') && intent.messageId === messageId)
        || (intent?.kind === 'ready-row' && intent.relation === 'dialog_messages' && intent.row?.message_id === messageId);

    /** This account's own message, as far as it is known here without any key. */
    const ownMessageBase = async (dialogHash, messageId, myHash, token, step) => {
        const current = await trustedRowBase('dialog_messages', messageId, myHash, dialogHash);
        assertSessionUnchanged(token, `${step}:afterBase`);
        if (!current) throw new Error('Message not found');
        if (current.sender_hash !== myHash) throw new Error(`Cannot ${step === 'editMessage' ? 'edit' : 'delete'}: not owner`);
        return current;
    };

    /**
     * Edit a message (owner only). Stored first — the new content and the
     * refs observed now; an edit not yet signed takes a newer one's content.
     */
    const editMessage = async (peerHash, messageId, newText) => {
        const myHash = $userPQ.currentUserHash;
        const token = pinActiveSession(myHash, 'editMessage:start');
        const dialogHash = getDialogHash(peerHash);
        await ownMessageBase(dialogHash, messageId, myHash, token, 'editMessage');
        const parts = typeof newText === 'string' ? [{ kind: 'text', text: newText }] : newText;
        const chainKey = `msg:${messageId}`;

        const intentId = await serialized(captureLocks, chainKey, async () => {
            const observedTails = await captureObservedTails(dialogHash, myHash);
            assertSessionUnchanged(token, 'editMessage:beforeCommit');
            const last = await lastIntentOf(myHash, messageChainOf(messageId));
            if (last?.intent?.kind === 'edit' && isUnsignedDialogIntent(last.intent)) {
                // The pending edit keeps its own refs; only its content is the newer one.
                const outcome = await updateUnsignedIntent(last.id, (intent) => ({ ...intent, parts }));
                if (outcome === 'updated') return last.id;
                if (outcome === 'failed') throw new Error('This edit could not be stored for sending. Nothing was sent — try again.');
            }
            const id = await enqueueIntent(
                { kind: 'edit', relation: 'dialog_messages', peerHash, dialogHash, messageId, ownerHash: myHash, parts, observedTails },
                myHash,
                'dialog_messages'
            );
            if (id === null) throw new Error('This action could not be stored for sending. Nothing was sent — try again.');
            return id;
        });

        if (await awaitsUnlock(runOnChain(chainKey, intentId, token))) {
            return { messageId, status: 'awaiting_unlock', signHash: null, ownerTimestamp: null };
        }
        const signed = signedOf.get(intentId);
        return { messageId, status: 'dispatched', signHash: signed?.signHash ?? null, ownerTimestamp: signed?.ownerTimestamp ?? null };
    };

    // ---------- file transport (§1.5, §2.1–2.3) ----------

    // §4.1: file_id + enc_secret persist BEFORE the first PUT — file_id alone
    // cannot resume, since a fresh secret would make re-sent chunks
    // undecryptable next to the ones already stored.
    const pendingUploadKey = (fileId) => `bkp:pending-upload:${fileId}`;

    /**
     * Uploads a file and sends the message referencing it. Progress is in
     * chunks (§2.1 — chunks, not guessed percentages). Returns the fileId.
     */
    /**
     * Uploads one attachment and returns its content part.
     *
     * An image or video announces its shape (aspect ratio + ThumbHash) so
     * the receiver lays it out before downloading; anything that will not
     * decode travels as a plain file rather than claiming a preview it does
     * not have. Previews are computed here, from the plaintext — the device
     * never sees it, so nowhere else can compute them.
     */
    const uploadAttachment = async (fileMeta, { onProgress, signal, prepared: preparedIn, resuming = false } = {}) => {
        const { name, mimeType, bytes, createdAt, blob } = fileMeta;
        const uploaderHash = $userPQ.currentUserHash;
        const signSkey = await getSignSkeyBytes();

        // The queue mints the pair up front so pause/resume re-enter with the
        // same file_id + enc_secret; a direct call mints its own.
        const prepared = preparedIn ?? prepareUpload((await import('uuid')).v7());
        try {
            localStorage.setItem(pendingUploadKey(prepared.fileId), JSON.stringify({
                encSecretB64: prepared.encSecretB64, name, size: bytes.length,
            }));
        } catch { /* private mode: resume across reloads degrades, upload still works */ }

        const up = await uploadFile({
            bytes, uploaderHash, signSkey, ...prepared, resuming, onProgress, signal,
        });

        const common = {
            name,
            size: bytes.length,
            mimeType: mimeType || 'application/octet-stream',
            createdAt: createdAt || Math.floor(Date.now() / 1000),
            fileId: up.fileId,
            encSecretB64: up.encSecretB64,
        };
        const video = blob && isVideoMime(mimeType);
        const preview = blob && (isImageMime(mimeType) || video)
            ? await (video ? buildVideoPreview(blob) : buildImagePreview(blob)).catch(() => null)
            : null;
        return preview
            ? { kind: video ? 'video' : 'image', ...preview, ...common }
            : { kind: 'file', ...common };
    };

    /** Playable source for a video part; streams when a worker is available. */
    const openVideoSource = (part, opts) => openVideo(part, opts);

    /** How much of an attachment this node can serve (§2.4). */
    const getFileAvailability = (fileId) => fileAvailability(fileId);

    /** Downloads and decrypts an attachment; progress in chunks (§2.3). */
    const fetchFile = (filePart, { onProgress, signal } = {}) =>
        downloadFile({ fileId: filePart.fileId, encSecretB64: filePart.encSecretB64, onProgress, signal });

    /**
     * Deletes own message (§3.2): a new revision with deleted_flag and no
     * content. Stored first with the refs observed now; built in the
     * message's chain, so after an edit still on its way it is that edit's
     * successor, never a sibling of the same parent.
     */
    const deleteMessage = async (peerHash, messageId) => {
        const myHash = $userPQ.currentUserHash;
        const token = pinActiveSession(myHash, 'deleteMessage:start');
        const dialogHash = getDialogHash(peerHash);
        await ownMessageBase(dialogHash, messageId, myHash, token, 'deleteMessage');
        const chainKey = `msg:${messageId}`;
        const intentId = await serialized(captureLocks, chainKey, async () => {
            const observedTails = await captureObservedTails(dialogHash, myHash);
            assertSessionUnchanged(token, 'deleteMessage:beforeCommit');
            const id = await enqueueIntent(
                { kind: 'delete', relation: 'dialog_messages', peerHash, dialogHash, messageId, ownerHash: myHash, observedTails },
                myHash,
                'dialog_messages'
            );
            if (id === null) throw new Error('This action could not be stored for sending. Nothing was sent — try again.');
            return id;
        });
        return { messageId, status: (await awaitsUnlock(runOnChain(chainKey, intentId, token))) ? 'awaiting_unlock' : 'dispatched' };
    };

    /**
     * Decrypt a message row
     */
    const decryptMessageRow = async (row, colls = null) => {
        try {
            const key = await getSenderMsgKey(row.dialog_hash, row.sender_hash, colls);
            if (!key) return { ...row, decrypted: false, text: "Waiting for keys..." };

            const jsonStr = await DialogCrypto.decryptContent(key, row.content_b64);
            // Deletion tombstones carry empty content by design (07: an empty
            // content_b64 is only valid alongside deleted_flag) — not a format error.
            const parts = jsonStr ? decodeContent(jsonStr) : [];

            return {
                ...row,
                decrypted: true,
                parts,
                text: contentToText(parts),
                isMine: row.sender_hash === $userPQ.currentUserHash
            };
        } catch (e) {
            const unsupported = e instanceof ContentDecodeError;
            if (!unsupported) console.error("Decrypt error", e);
            return {
                ...row,
                decrypted: false,
                parts: [],
                text: unsupported ? "Unsupported message format" : "Decryption failed",
            };
        }
    };

    /**
     * Version history of a message (§3.1): archived revisions from the
     * versions shape plus the current tip, newest first.
     *
     * Every revision is signature-checked before its content is shown as a
     * past version — history is cryptographic lineage, not a cache
     * (invariants/03_data_versioning.md), and a forged "old version" planted
     * in the feed would be the perfect place to put words in someone's mouth.
     * Unverifiable revisions surface as such rather than being dropped:
     * a gap in history is itself information.
     */
    const getMessageHistory = async (dialogHash, messageId) => {
        const colls = getDialogCollections(dialogHash);
        let rows;
        try {
            const versionsState = await settled(colls.versions);
            if (versionsState.state === 'failed') throw versionsState.error;
            rows = colls.versions.toArray.filter((v) => v.message_id === messageId);
        } catch {
            const live = colls.versions.toArray.filter((v) => v.message_id === messageId);
            const cached = (await readDialogRows('dialog_messages_versions', dialogHash))
                .filter((r) => r.message_id === messageId);
            rows = mergeLiveWithCached('dialog_messages_versions', live, cached, (r) => `${r.message_id}|${r.sign_hash}`);
        }

        const out = [];
        for (const row of rows) {
            const verified = (await verifyReplicatedRow('dialog_messages_versions', row, getVerifiedSignPkey)).status === 'verified';
            let text = '';
            let decrypted = false;
            if (verified && row.content_b64) {
                try {
                    const key = await getSenderMsgKey(row.dialog_hash, row.sender_hash);
                    if (key) {
                        const json = await DialogCrypto.decryptContent(key, row.content_b64);
                        text = json ? contentToText(decodeContent(json)) : '';
                        decrypted = true;
                    }
                } catch { /* rendered as undecrypted below */ }
            }
            out.push({
                signHash: row.sign_hash,
                ownerTimestamp: row.owner_timestamp,
                deletedFlag: !!row.deleted_flag,
                verified,
                text: verified ? (decrypted ? text : 'Waiting for keys…') : 'Unverifiable revision',
            });
        }
        // Newest first; the current tip is already on screen and is not repeated here.
        out.sort((a, b) => b.ownerTimestamp - a.ownerTimestamp);
        return out;
    };

    // ---------- checkpoint alerts on the dialogs list ----------
    //
    // A checkpoint marks a state the user confirmed; the dialogs list flags the
    // dialogs that have moved since. The flag is advisory — it is computed from
    // the rows as stored, without re-running the receive gate, because a dot is
    // a hint to look, not an assertion about authenticity. Opening the dialog
    // runs the verified comparison (compare/diffDialogCheckpoint) and that is
    // what the user is shown.
    //
    // The view root is the right signal: history that changed without changing
    // what is displayed (an edit reverted by another edit, a losing fork) is
    // not something to interrupt anyone about.

    /** peerHash -> { changed, createdAt } for dialogs holding a checkpoint. */
    const checkpointAlerts = ref(new Map());

    // Session caches are keyed by dialog/peer, not by account. Alerts,
    // derived sender keys and decrypted refs from account A must not leak
    // into account B's session — a peer present in both lists would show A's
    // alert dot until B's own sweep caught up.
    watch(() => $userPQ.currentUserHash, () => {
        checkpointAlerts.value = new Map();
        senderMsgKeys.value = {};
        decryptedRefsCache.clear();
        dialogGates.clear();
        ownSentMessageIds.clear();
        optimisticItems.value = new Map();
        sessionProjections.clear();
        if (hydration.timer) clearTimeout(hydration.timer);
        Object.assign(hydration, { owner: null, done: false, attempt: 0, timer: null, running: null });
        if ($userPQ.currentUserHash) void hydrateProjections($userPQ.currentUserHash);
    });
    if ($userPQ.currentUserHash) void hydrateProjections($userPQ.currentUserHash);

    /** Peers whose latest checkpoint no longer matches the dialog. */
    const alertingPeers = computed(() => {
        const out = new Set();
        for (const [peer, alert] of checkpointAlerts.value) if (alert.changed) out.add(peer);
        return out;
    });

    // Finds the newest checkpoint this user signed, decoding only messages the
    // previous scan had not reached yet. Checkpoints are immutable, so a known
    // one never has to be found again; `scannedTo` keeps dialogs that never had
    // one from being decrypted end to end on every visit.
    // `isAdmitted(row)`: whether the dialog gate admitted this exact revision.
    // A checkpoint is read only from one; a raw, waiting, blocked or invalid
    // row is never decrypted for it and holds the watermark like an
    // undecrypted one, so it is looked at again once admitted.
    const findLatestCheckpoint = async (dialogHash, rows, pointer, colls = null, isAdmitted = () => false, me = $userPQ.currentUserHash) => {
        const mine = rows
            .filter((r) => r.sender_hash === me && !r.deleted_flag && r.content_b64)
            .map((r) => ({ row: r, order: feedOrderKey(r.message_id, r.owner_timestamp) }))
            .filter((e) => e.order > pointer.scannedTo)
            .sort((a, b) => b.order - a.order);

        // The watermark advances only past rows that actually decrypted. A row
        // that failed (its dialog key has not arrived yet) must be rescanned,
        // and `order > scannedTo` is the only thing that brings a row back —
        // advancing past a failure would blind this dialog's alerts for good.
        let sawUndecrypted = false;
        let found = null;
        for (const { row } of mine) {
            if (!isAdmitted(row)) { sawUndecrypted = true; continue; }
            const decoded = await decryptMessageRow(row, colls);
            if (!decoded.decrypted) { sawUndecrypted = true; continue; }
            const part = (decoded.parts || []).find((x) => x.kind === 'checkpoint');
            if (!part) continue;
            // Roots from other checkpoint semantics are incomparable with
            // locally derived ones — adopting such a pointer lights a
            // "changed" dot that no state can ever put out (§32: unknown
            // versions are unverifiable, never unequal).
            if (part.version !== CHECKPOINT_VERSION || part.reducerVersion !== REDUCER_VERSION || part.treeVersion !== TREE_VERSION) continue;
            // newest first: the first decrypted hit wins; rows below it are
            // older and cannot beat it, so they never need decoding at all
            found = {
                messageId: row.message_id,
                viewRoot: part.viewRoot,
                frontierRoot: part.frontierRoot,
                createdAt: part.createdAt,
            };
            break;
        }
        const scannedTo = sawUndecrypted || !mine.length
            ? pointer.scannedTo
            : Math.max(pointer.scannedTo, mine[0].order);
        return { checkpoint: found ?? pointer.checkpoint, scannedTo };
    };

    /**
     * Refreshes one dialog's alert. Returns null when the dialog holds no
     * checkpoint of this user's — nothing was confirmed, so nothing can differ.
     */
    const refreshCheckpointAlert = async (peerHash) => {
        const dialogHash = getDialogHash(peerHash);
        if (!dialogHash) return null;

        const me = $userPQ.currentUserHash;
        const stored = await loadPointer(me, dialogHash);

        // Both the read AND the decryption run inside the transient bundle:
        // decryptMessageRow's key lookup opens dialog collections too, and
        // letting it fall back to getDialogCollections would re-register the
        // dialog in the LRU through the back door — the exact effect
        // withDialogCollections exists to prevent.
        // Every await below may outlive the session: nothing is written for
        // `me` once another account is open.
        const stillMine = () => $userPQ.currentUserHash === me;
        const { rows, pointer } = await withDialogCollections(dialogHash, async (colls) => {
            await colls.messages.preload().catch(() => { });
            if (!stillMine()) return { rows: [], pointer: stored };
            const loaded = colls.messages.toArray.filter((r) => r.sign_hash);
            const ordered = [...loaded].sort((a, b) => feedOrderKey(a.message_id, a.owner_timestamp) - feedOrderKey(b.message_id, b.owner_timestamp));
            for (const row of ordered) await admitMessageRow(row, colls);
            const admitted = loaded.filter((r) => isRowAdmitted(dialogHash, r));
            const isAdmitted = (r) => isRowAdmitted(dialogHash, r);
            return { rows: admitted, pointer: await findLatestCheckpoint(dialogHash, loaded, stored, colls, isAdmitted, me) };
        });
        if (!stillMine()) return null;
        if (pointer.scannedTo !== stored.scannedTo || pointer.checkpoint !== stored.checkpoint) {
            await savePointer(me, dialogHash, pointer);
        } else if (pointer.checkpoint) {
            // Unchanged pointer ≠ registered dialog: the index entry can be
            // lost independently (a failed write), and this visit is its
            // only way back — the sweep never looks at unindexed dialogs.
            await rememberPointerDialog(me, dialogHash);
        }
        if (!stillMine()) return null;
        if (!pointer.checkpoint) {
            checkpointAlerts.value.delete(peerHash);
            return null;
        }

        const alert = {
            changed: viewMoved(rows, pointer.checkpoint.viewRoot, pointer.checkpoint.messageId),
            createdAt: pointer.checkpoint.createdAt,
            messageId: pointer.checkpoint.messageId,
        };
        // reassign: a Map mutation is not reactive on its own
        if (!stillMine()) return null;
        checkpointAlerts.value = new Map(checkpointAlerts.value).set(peerHash, alert);
        return alert;
    };

    /**
     * Scans dialogs for checkpoints whose state has moved (the dialogs list
     * calls this on open). Strictly sequential: each dialog's collections open
     * an Electric shape, and a parallel sweep would put one long-poll per
     * dialog on the wire at once. Dialogs not already warm are released again
     * so the scan does not evict the open dialog from the registry.
     */
    let scanInFlight = null;
    // One dialog must not wedge the sweep: a cold shape's preload can stall
    // (no first commit to resolve on), and a stuck refresh would hold
    // scanInFlight forever — every later tick returns the same dead promise
    // and no alert ever updates again. The budget bounds one dialog's cost;
    // the sweep moves on and the next tick tries that dialog afresh.
    const REFRESH_BUDGET_MS = 15_000;
    const scanCheckpointAlerts = async (peerHashes) => {
        if (scanInFlight) return scanInFlight;
        scanInFlight = (async () => {
            // The list hands over every replicated card — on a shared backend
            // that is hundreds of strangers. An alert is only possible where
            // this account has a checkpoint pointer, and those dialogs are
            // indexed; everything else is skipped without opening a shape.
            const indexed = await pointerDialogs($userPQ.currentUserHash);
            // null = the index could not be read (locked storage, transient
            // failure). Skipping the tick keeps the 30s retry alive; treating
            // it as "empty" would silently disable every alert for the session.
            if (indexed === null) return;
            for (const peerHash of peerHashes) {
                if (!peerHash || peerHash === $userPQ.currentUserHash) continue;
                const dialogHash = getDialogHash(peerHash);
                if (!dialogHash || !indexed.has(dialogHash)) continue;
                let budget;
                try {
                    await Promise.race([
                        refreshCheckpointAlert(peerHash),
                        new Promise((_, reject) => { budget = setTimeout(
                            () => reject(new Error('refresh budget exceeded')), REFRESH_BUDGET_MS); }),
                    ]);
                } catch (e) {
                    console.warn('[dialogs] checkpoint alert scan failed for', peerHash, e);
                } finally {
                    clearTimeout(budget);
                }
            }
        })().finally(() => { scanInFlight = null; });
        return scanInFlight;
    };

    // ---------- signed DAG checkpoint (src/lib/pq/checkpoint.ts) ----------
    //
    // A checkpoint attests "this device held this causally complete local
    // state and it materialized to this view". It rides an ordinary message
    // (content type "checkpoint"), so signing, transport, versioning and the
    // receive gate all apply unchanged and the server sees a normal row.

    const loadDialogRows = async (dialogHash) => {
        const colls = getDialogCollections(dialogHash);
        await colls.messages.preload().catch(() => { });
        await colls.versions.preload().catch(() => { });
        return {
            current: colls.messages.toArray.filter((r) => r.sign_hash),
            versions: colls.versions.toArray.filter((r) => r.sign_hash),
        };
    };

    // Reducer dialog-state-v1: the winning revision per message is the
    // server-materialized current row (edits archive their predecessor), so
    // the reduction is "gate-admitted current rows as they stand" — the same
    // selection the feed renders. Tombstones stay in the state as deleted:
    // a delete is a view change, not a disappearance.
    const computeDialogViewState = async (dialogHash) => {
        const { current } = await loadDialogRows(dialogHash);
        const state = {};
        const unadmitted = [];
        for (const row of current) {
            // message_id is signed but a peer signs whatever they like; the
            // server's Ecto type stops out-of-grammar ids from replicating,
            // and this is the client half: such a row is unadmitted, never a
            // trie key (buildViewTree throws on non-ASCII by design).
            if (!isWireMessageId(row.message_id)) {
                unadmitted.push(row.message_id);
                continue;
            }
            const verdict = await admitMessageRow(row);
            if (verdict.status === 'verified') {
                state[row.message_id] = { signHash: row.sign_hash, deleted: !!row.deleted_flag };
            } else {
                unadmitted.push(row.message_id);
            }
        }
        return { state, rows: current, unadmitted };
    };

    // The single tail rule (pq_dialogs.md §Tail calculation): every signed
    // revision is a candidate, deleted ones included — a tombstone is a
    // revision like any edit, so its pair enters the tail set and the fact
    // of deletion propagates causally.
    const computeDialogFrontier = async (rows) => {
        const candidates = rows.filter((r) => r.sign_hash);
        const withRefs = await Promise.all(candidates.map(async (r) => ({
            message_id: r.message_id,
            sign_hash: r.sign_hash,
            refs: await decryptRefsOf(r),
        })));
        return {
            frontier: computeTails(withRefs),
            undecryptableRefs: withRefs.filter((w) => w.refs === null).map((w) => w.message_id),
        };
    };

    /**
     * Creates and sends a checkpoint over the dialog's current state.
     * Fails (INCOMPLETE_CAUSAL_HISTORY) while anything is unadmitted or any
     * refs blob is still undecryptable: a checkpoint must not attest history
     * the device has not fully verified (spec §7 — head hashes alone can
     * reference data never seen locally).
     */
    const createDialogCheckpoint = async (peerHash) => {
        const ownerHash = $userPQ.currentUserHash;
        const dialogHash = getDialogHash(peerHash);
        if (!dialogHash) throw new Error('Not logged in');
        const token = pinActiveSession(ownerHash, 'createDialogCheckpoint:start');
        const { state, rows, unadmitted } = await computeDialogViewState(dialogHash);
        const gate = gateFor(dialogHash);
        const waiting = gate.stats().pending;
        const { frontier, undecryptableRefs } = await computeDialogFrontier(rows);
        if (unadmitted.length || waiting || undecryptableRefs.length) {
            const err = new Error('INCOMPLETE_CAUSAL_HISTORY');
            err.details = { unadmitted, waiting, undecryptableRefs };
            throw err;
        }

        // The server's Ecto types make an out-of-grammar message_id
        // unreplicable, so this is a tripwire, not a reachable path: if the
        // grammars ever diverge, fail here — at signing, visibly — rather
        // than publish a checkpoint whose own decoder rejects it.
        const badFrontier = Object.keys(frontier).filter((mid) => !isWireMessageId(mid));
        if (badFrontier.length) {
            const err = new Error('INCOMPLETE_CAUSAL_HISTORY');
            err.details = { unadmitted: badFrontier, waiting: 0, undecryptableRefs: [] };
            throw err;
        }
        const part = {
            kind: 'checkpoint',
            version: CHECKPOINT_VERSION,
            reducerVersion: REDUCER_VERSION,
            treeVersion: TREE_VERSION,
            frontierRoot: deriveFrontierRoot(frontier),
            viewRoot: buildViewTree(state).root,
            frontier,
            createdAt: Math.floor(Date.now() / 1000),
        };
        // ADR §11: the alert is cleared and the pointer saved only once the
        // send settles — a checkpoint whose carrier never left the device must
        // not report "signed" while silencing the very alert it was meant to
        // re-arm. A transient failure stays durable in the outbox; if its
        // replay lands later, the next scan adopts the row as usual.
        let settle;
        const sent = new Promise((resolve, reject) => { settle = { resolve, reject }; });
        const messageId = await sendMessage(peerHash, [part], (status, cause) => {
            if (status === 'synced') settle.resolve();
            else if (status === 'error' || status === 'queued' || status === 'awaiting_recovery') settle.reject(new Error('CHECKPOINT_SEND_FAILED', { cause }));
        }, null, null, 'checkpoint');
        await sent;
        // Two independent fences on purpose: the session token catches a
        // relogin that reuses the same hash, the plain hash compare catches
        // an account switch even where session tokens are not wired (and
        // costs nothing where they are). A checkpoint's pointer written
        // under the new account's keys would be an unquenchable alert for a
        // carrier that account does not have.
        if (!sameSessionToken(token, currentSessionToken()) || $userPQ.currentUserHash !== ownerHash) {
            console.warn('[dialogs] checkpoint sent, but the active session changed before pointer/alert write — skipping it for the now-inactive session');
            return { messageId, part };
        }
        // The new checkpoint is the pointer now: the dialog matches what was just
        // confirmed, so its alert clears without waiting for the next scan.
        checkpointAlerts.value = new Map(checkpointAlerts.value).set(peerHash, { changed: false, createdAt: part.createdAt, messageId });
        await savePointer(ownerHash, dialogHash, {
            checkpoint: { messageId, viewRoot: part.viewRoot, frontierRoot: part.frontierRoot, createdAt: part.createdAt },
            scannedTo: feedOrderKey(messageId, part.createdAt),
        }).catch(() => { });
        return { messageId, part };
    };

    /**
     * Protocol-level checks of a received checkpoint part. The carrying row's
     * ML-DSA signature and authorship were already enforced by the gate — an
     * unadmitted row never reaches this code — so this validates the inner
     * commitments (§19): versions, frontier_root consistency, and whether the
     * attested revisions are locally known.
     */
    const verifyDialogCheckpoint = async (peerHash, part) => {
        if (part.version !== CHECKPOINT_VERSION) {
            return { status: 'unsupported_version', component: 'checkpoint_version', version: String(part.version) };
        }
        // Unknown reducer/tree: the signature stands, the view is simply not
        // reproducible here — never INVALID (§32).
        if (part.reducerVersion !== REDUCER_VERSION) {
            return { status: 'unsupported_version', component: 'reducer_version', version: part.reducerVersion };
        }
        if (part.treeVersion !== TREE_VERSION) {
            return { status: 'unsupported_version', component: 'tree_version', version: part.treeVersion };
        }
        if (deriveFrontierRoot(part.frontier) !== part.frontierRoot) {
            return { status: 'invalid', reason: 'frontier_root does not match the frontier set' };
        }

        const dialogHash = getDialogHash(peerHash);
        const { current, versions } = await loadDialogRows(dialogHash);
        // Only gate-admitted rows count as known — sign_hash is a derived
        // column not covered by the signature (verifyDialogRow.ts), so a raw
        // read here would let a planted row with an invented sign_hash turn
        // incomplete_history into valid. Same admission rule as diff.
        const known = new Set();
        for (const row of [...current, ...versions]) {
            const verdict = await admitMessageRow(row);
            if (verdict.status === 'verified') known.add(row.sign_hash);
        }
        const missing = Object.entries(part.frontier)
            .filter(([, sh]) => !known.has(sh))
            .map(([mid, sh]) => `${mid}|${sh}`);
        if (missing.length) return { status: 'incomplete_history', missingEventIds: missing };
        return { status: 'valid' };
    };

    /**
     * O(1) comparison of the checkpoint against the current admitted state
     * (§20-21). view.equal is null when reducer/tree versions differ — roots
     * from different semantics are incomparable, not unequal.
     */
    const compareDialogCheckpoint = async (peerHash, part, { pointerMessageId } = {}) => {
        const dialogHash = getDialogHash(peerHash);
        const { state, rows } = await computeDialogViewState(dialogHash);
        // The message carrying the checkpoint replicates like any other row,
        // but it did not exist when the roots were computed — leaving it in
        // makes every checkpoint immediately disagree with itself, in both
        // the view (an extra leaf) and the frontier (it becomes the new tail).
        if (pointerMessageId) delete state[pointerMessageId];
        const scopedRows = pointerMessageId
            ? rows.filter((r) => r.message_id !== pointerMessageId)
            : rows;
        const { frontier } = await computeDialogFrontier(scopedRows);

        const historyEqual = deriveFrontierRoot(frontier) === part.frontierRoot;
        const versionEqual = part.version === CHECKPOINT_VERSION;
        const reducerVersionEqual = part.reducerVersion === REDUCER_VERSION;
        const treeVersionEqual = part.treeVersion === TREE_VERSION;
        const viewEqual = versionEqual && reducerVersionEqual && treeVersionEqual
            ? buildViewTree(state).root === part.viewRoot
            : null;

        const verdict =
            viewEqual === null ? 'VIEW_UNVERIFIABLE'
                : historyEqual && viewEqual ? 'EXACT_MATCH'
                    : !historyEqual && viewEqual ? 'HISTORY_CHANGED_VIEW_EQUAL'
                        : !historyEqual ? 'VIEW_CHANGED'
                            // same causally-closed history + same reducer MUST
                            // reproduce the same view (Invariant 3)
                            : 'INCONSISTENT_VIEW';

        return {
            verdict,
            history: { equal: historyEqual },
            view: { equal: viewEqual },
            reducerVersionEqual,
            treeVersionEqual,
        };
    };

    /**
     * Reconstructs the view as of the checkpoint's frontier and diffs it
     * against the current view (§22-24). The old state is rebuilt from the
     * causal closure: revisions reachable from the frontier through refs and
     * parent_sign_hash chains, taking the newest reachable revision per
     * message. Archived revisions come from dialog_messages_versions and are
     * gate-verified like everything else.
     */
    const diffDialogCheckpoint = async (peerHash, part) => {
        // Protocol guard, not a UI courtesy: every caller — present and
        // future — gets the honest verdict for foreign semantics instead of
        // a diff built from incomparable roots.
        if (part.version !== CHECKPOINT_VERSION || part.reducerVersion !== REDUCER_VERSION || part.treeVersion !== TREE_VERSION) {
            return { status: 'unsupported_version' };
        }
        const dialogHash = getDialogHash(peerHash);
        const { state: newState, rows } = await computeDialogViewState(dialogHash);
        const { current, versions } = await loadDialogRows(dialogHash);

        const bySignHash = new Map();
        for (const row of [...versions, ...current]) {
            const verdict = await admitMessageRow(row);
            if (verdict.status === 'verified') bySignHash.set(row.sign_hash, row);
        }

        const missing = [];
        const bestByMessage = new Map(); // message_id -> row (max owner_timestamp reachable)
        const visited = new Set();
        const queue = Object.entries(part.frontier).map(([mid, sh]) => ({ mid, sh }));
        while (queue.length) {
            const { mid, sh } = queue.pop();
            if (visited.has(sh)) continue;
            visited.add(sh);
            const row = bySignHash.get(sh);
            if (!row) { missing.push(`${mid}|${sh}`); continue; }
            const best = bestByMessage.get(row.message_id);
            if (!best || row.owner_timestamp > best.owner_timestamp) bestByMessage.set(row.message_id, row);
            if (row.parent_sign_hash) queue.push({ mid: row.message_id, sh: row.parent_sign_hash });
            const refs = await decryptRefsOf(row);
            if (refs) for (const [rmid, rsh] of Object.entries(refs)) queue.push({ mid: rmid, sh: rsh });
        }
        if (missing.length) return { status: 'incomplete_history', missingEventIds: missing };

        const oldState = {};
        for (const [mid, row] of bestByMessage) {
            oldState[mid] = { signHash: row.sign_hash, deleted: !!row.deleted_flag };
        }

        const diff = diffViewTrees(buildViewTree(oldState), buildViewTree(newState));
        const { frontier } = await computeDialogFrontier(rows);
        return {
            status: 'ok',
            currentFrontier: frontier,
            changes: classifyChanges(diff),
        };
    };

    // What a specific revision looked like — for showing the change itself,
    // not just naming it. Archived revisions come from the versions shape;
    // decryption follows the same path the feed uses.
    const revisionPreview = async (dialogHash, signHash) => {
        const { current, versions } = await loadDialogRows(dialogHash);
        const row = [...current, ...versions].find((r) => r.sign_hash === signHash);
        if (!row) return { text: 'Revision not synced', decrypted: false };
        // The version collection is keyed by (message_id, sign_hash) and
        // sign_hash is a derived column: a row whose column lies about its
        // signature would occupy the honest revision's slot. Same rule as
        // getMessageHistory — verify before showing anything as "what it said".
        if ((await verifyReplicatedRow('dialog_messages', row, getVerifiedSignPkey)).status !== 'verified') {
            return { text: 'Unverifiable revision', decrypted: false };
        }
        if (!row.content_b64) return { text: '', decrypted: true, deleted: !!row.deleted_flag };
        try {
            const key = await getSenderMsgKey(row.dialog_hash, row.sender_hash);
            if (!key) return { text: 'Waiting for keys…', decrypted: false };
            const json = await DialogCrypto.decryptContent(key, row.content_b64);
            return { text: json ? previewText(decodeContent(json)) : '', decrypted: true };
        } catch {
            return { text: 'Undecryptable content', decrypted: false };
        }
    };

    /**
     * diffDialogCheckpoint hydrated for display: each change carries the
     * concrete before/after content (or attachment label) alongside the
     * revision hashes, plus the author for attribution.
     *
     * The pointer (the checkpoint's own position in the feed) splits the
     * result: behind it the checkpoint attested a bounded set, and any
     * revision of it — a late insert, an edit, a delete — is history changing
     * under the user's feet, detailed one by one. Ahead of it the dialog just
     * continues without limit, so new messages collapse into `futureAdded`
     * (a count and the first id to jump to), never a list.
     */
    const describeCheckpointDiff = async (peerHash, part, { pointerMessageId } = {}) => {
        const dialogHash = getDialogHash(peerHash);
        const diff = await diffDialogCheckpoint(peerHash, part);
        if (diff.status !== 'ok') return diff;

        const pointerKey = feedOrderKey(pointerMessageId, part.createdAt);
        const past = [];
        const futureAdds = [];
        for (const c of diff.changes) {
            if (c.messageId === pointerMessageId) continue; // the pointer itself
            if (c.type === 'MESSAGE_ADDED' && feedOrderKey(c.messageId, part.createdAt) >= pointerKey) {
                futureAdds.push(c);
            } else {
                past.push(c);
            }
        }
        futureAdds.sort((a, b) => feedOrderKey(a.messageId, 0) - feedOrderKey(b.messageId, 0));

        const msgColl = getDialogCollections(dialogHash).messages;
        const changes = [];
        for (const c of past) {
            const currentRow = msgColl.get(c.messageId) || null;
            const entry = { ...c, senderHash: currentRow?.sender_hash ?? null };
            if (c.type === 'MESSAGE_ADDED') {
                entry.newText = currentRow ? (await revisionPreview(dialogHash, currentRow.sign_hash)).text : '';
            } else if (c.type === 'MESSAGE_EDITED') {
                entry.oldText = (await revisionPreview(dialogHash, c.oldVersion)).text;
                entry.newText = (await revisionPreview(dialogHash, c.newVersion)).text;
            } else if (c.type === 'MESSAGE_DELETED') {
                entry.oldText = (await revisionPreview(dialogHash, c.oldVersion)).text;
            } else if (c.type === 'MESSAGE_RESTORED') {
                entry.newText = (await revisionPreview(dialogHash, c.newVersion)).text;
            }
            changes.push(entry);
        }
        return {
            ...diff,
            changes,
            futureAdded: { count: futureAdds.length, firstMessageId: futureAdds[0]?.messageId ?? null },
        };
    };

    /**
     * Toggle reaction. Owns its optimistic state: computes the deterministic
     * reaction_hash and desired end state, registers the optimistic item, and
     * syncs in the background. `messageSignHash` must be the sign_hash of the
     * message revision the user is looking at — reacting to an unsynced
     * revision is an error, not a signed mutation with an empty hash.
     */
    // A toggle is stored before any key is touched, as the desired end state
    // on the revision the user reacted to; `active` is the state the user
    // sees. Until that intent is signed, further toggles of the same reaction
    // flip it in place — one record, its final state, across a reload too.
    // Once signed, the next toggle is a revision of its own, built on it.
    const toggleReaction = async (peerHash, { messageId, messageSignHash, emoji, active }) => {
        if (!messageSignHash) {
            throw new Error('Cannot react: message revision is not synced yet');
        }
        if (typeof active !== 'boolean') {
            throw new TypeError('toggleReaction: the displayed state of the reaction (active) is required');
        }
        const myHash = $userPQ.currentUserHash;
        const token = pinActiveSession(myHash, 'toggleReaction:start');
        const dialogHash = getDialogHash(peerHash);
        const logicalKey = `${dialogHash}|${messageId}|${emoji}`;
        const chainKey = `rx:${logicalKey}`;
        const isThisReaction = (intent) => intent?.kind === 'reaction'
            && intent.dialogHash === dialogHash && intent.messageId === messageId && intent.emoji === emoji;

        const { intentId, desiredActive } = await serialized(captureLocks, chainKey, async () => {
            const last = await lastIntentOf(myHash, isThisReaction);
            // Coalesced only onto the same target revision: a toggle on another
            // revision is another action.
            if (last && isUnsignedDialogIntent(last.intent) && last.intent.messageSignHash === messageSignHash) {
                let desired = null;
                const outcome = await updateUnsignedIntent(last.id, (intent) => {
                    desired = !intent.desiredActive;
                    return { ...intent, desiredActive: desired };
                });
                if (outcome === 'updated') return { intentId: last.id, desiredActive: desired };
                if (outcome === 'failed') throw new Error('This reaction could not be stored for sending. Nothing was sent — try again.');
            }
            assertSessionUnchanged(token, 'toggleReaction:beforeCommit');
            const desired = !active;
            const id = await enqueueIntent(
                { kind: 'reaction', relation: 'dialog_message_reactions', peerHash, dialogHash, messageId, messageSignHash, emoji, desiredActive: desired, ownerHash: myHash },
                myHash,
                'dialog_message_reactions'
            );
            if (id === null) throw new Error('This action could not be stored for sending. Nothing was sent — try again.');
            return { intentId: id, desiredActive: desired };
        });

        const optimisticId = addOptimisticReaction(dialogHash, messageId, emoji, logicalKey, desiredActive);
        updateOptimisticStatus(optimisticId, 'syncing');
        const run = runOnChain(chainKey, intentId, token, (row) => {
            for (const item of optimisticItems.value.values()) {
                if (item.type === 'reaction' && item.logicalKey === logicalKey) item.reactionHash = row?.reaction_hash ?? item.reactionHash;
            }
        });
        run.then(
            (handle) => {
                if (!handle) {
                    removeOptimisticItem(optimisticId);
                    return;
                }
                handle.acceptance.then((outcome) => updateOptimisticStatus(optimisticId, outcome.kind === 'accepted' ? 'synced' : 'error'));
            },
            (e) => {
                if (e instanceof VaultLockedError) {
                    updateOptimisticStatus(optimisticId, 'awaiting_unlock');
                    return;
                }
                console.error('[dialogs] toggleReaction failed:', e);
                if (e?.permanent) removeOptimisticItem(optimisticId);
                else updateOptimisticStatus(optimisticId, 'error');
            }
        );
        return optimisticId;
    };

    /**
     * Publish a "read" receipt for a specific message revision.
     *
     * Deliberate, never automatic: the product requires the user to confirm
     * they have reviewed this version of the history by pressing a button, so
     * this is NOT called on render. Receipts are irreversible by design — the
     * table has no deleted_flag — which is exactly why the acknowledgement
     * must be an explicit act.
     *
     * Bound to message_sign_hash: an edited message is a new revision and
     * needs its own acknowledgement.
     */
    const receiptOps = new Map();

    const rowOfMutation = (m) => m?.modified ?? m?.changes ?? null;
    const isReceiptEntry = (receiptHash) => (entry) =>
        entry.relation === 'dialog_message_receipts'
        && (entry.mutations || []).some((m) => rowOfMutation(m)?.receipt_hash === receiptHash);

    const knownReceipt = async (receiptHash, myHash) => {
        if (await getAccepted('dialog_message_receipts', receiptHash, myHash)) return { kind: 'exists' };
        const cached = await readDialogRow('dialog_message_receipts', receiptHash);
        if (cached && cached.peer_hash === myHash && await admitReceiptRow(cached)) return { kind: 'exists' };
        const { entries: intents } = await intentsOf(myHash);
        const intent = intents.find((e) => e.relation === 'dialog_message_receipts' && e.intent?.row?.receipt_hash === receiptHash);
        if (intent) return { kind: 'intent', intent };
        if ((await pendingEntries(myHash)).some(isReceiptEntry(receiptHash))) return { kind: 'queued' };
        if ((await quarantinedEntries(myHash)).some(isReceiptEntry(receiptHash))) return { kind: 'rejected' };
        return null;
    };

    const sendReceipt = async (peerHash, { messageId, messageSignHash }, type) => {
        if (!messageSignHash) {
            throw new Error('Cannot acknowledge: message revision is not synced yet');
        }
        const myHash = $userPQ.currentUserHash;
        const receiptHash = DialogCrypto.computeReceiptHash(messageId, messageSignHash, myHash, type);
        const opKey = `${myHash}|${receiptHash}`;
        const inFlight = receiptOps.get(opKey);
        if (inFlight) return inFlight;
        const op = sendReceiptOnce(peerHash, { messageId, messageSignHash }, type, myHash, receiptHash)
            .finally(() => { if (receiptOps.get(opKey) === op) receiptOps.delete(opKey); });
        receiptOps.set(opKey, op);
        return op;
    };

    const sendReceiptOnce = async (peerHash, { messageId, messageSignHash }, type, myHash, receiptHash) => {
        const token = pinActiveSession(myHash, 'sendReceipt:start');
        const dialogHash = getDialogHash(peerHash);

        const dialogColls = getDialogCollections(dialogHash);
        await dialogColls.receipts.preload().catch(() => {});
        // Already acknowledged: the deterministic hash makes this a no-op
        // rather than a duplicate insert the server would reject.
        if (dialogColls.receipts.get(receiptHash)) return receiptHash;

        const known = await knownReceipt(receiptHash, myHash);
        if (known?.kind === 'exists' || known?.kind === 'queued') return receiptHash;
        if (known?.kind === 'rejected') {
            throw new Error('This receipt was rejected earlier — retry or discard it in the failed-writes banner.');
        }
        assertSessionUnchanged(token, 'sendReceipt:beforeCommit');
        const intentId = known?.kind === 'intent'
            ? known.intent.id
            : await enqueueIntent({
                kind: 'receipt', relation: 'dialog_message_receipts', peerHash, dialogHash, ownerHash: myHash,
                row: {
                    receipt_hash: receiptHash,
                    dialog_hash: dialogHash,
                    message_id: messageId,
                    peer_hash: myHash,
                    type,
                    message_sign_hash: messageSignHash,
                    owner_timestamp: nextOwnerTimestamp(null),
                },
            }, myHash, 'dialog_message_receipts');
        if (intentId === null) throw new Error('This action could not be stored for sending. Nothing was sent — try again.');
        await dispatchDialogIntent(intentId, token);
        return receiptHash;
    };

    const sendReadReceipt = (peerHash, ref) => sendReceipt(peerHash, ref, 'read');

    /**
     * §4.3: "delivered" is a fact about arrival, so unlike "read" it goes out
     * automatically — the moment a verified message lands on this device.
     * The deterministic receipt hash makes repeats no-ops.
     */
    const sendDeliveredReceipt = (peerHash, ref) =>
        sendReceipt(peerHash, ref, 'delivered').catch((e) => {
            // Delivery acknowledgement is best-effort background traffic;
            // failing it must not surface as a user-facing error.
            console.warn('[dialogs] delivered receipt failed:', e?.message || e);
        });

    /** Revisions the current user has explicitly acknowledged. */
    const isRevisionAcknowledged = (dialogHash, messageId, messageSignHash) => {
        if (!messageSignHash) return false;
        const receiptHash = DialogCrypto.computeReceiptHash(
            messageId, messageSignHash, $userPQ.currentUserHash, 'read'
        );
        return !!getDialogCollections(dialogHash).receipts.get(receiptHash);
    };

    const decryptReactionRow = async (dialogHash, row) => {
        try {
            const key = await getSenderMsgKey(dialogHash, row.reactor_hash);
            if (!key) return { ...row, decrypted: false, emoji: '?' };

            const emoji = await DialogCrypto.decryptContent(key, row.type_b64);
            return { ...row, decrypted: true, emoji };
        } catch (e) {
            console.error("Decrypt reaction error", e);
            return { ...row, decrypted: false, emoji: '?' };
        }
    };

    return {
        getDialogHash,
        initDialogKeys,
        getSenderMsgKey,
        sendMessage,
        captureMessageIntent,
        dispatchMessageIntent,
        editMessage,
        decryptMessageRow,
        deleteMessage,
        uploadAttachment,
        fetchFile,
        getFileAvailability,
        openVideoSource,
        getMessageHistory,
        createDialogCheckpoint,
        verifyDialogCheckpoint,
        compareDialogCheckpoint,
        diffDialogCheckpoint,
        describeCheckpointDiff,
        checkpointAlerts,
        alertingPeers,
        scanCheckpointAlerts,
        refreshCheckpointAlert,
        admitMessageRow,
        isMessageAdmitted,
        blockedByOf,
        isRowAdmitted,
        admitReactionRow,
        admitReceiptRow,
        retryCardAdmissions,
        toggleReaction,
        sendReadReceipt,
        sendDeliveredReceipt,
        isRevisionAcknowledged,
        decryptReactionRow,
        optimisticItems,
        addOptimisticMessage,
        addOptimisticMessageWithId,
        addOptimisticReaction,
        updateOptimisticStatus,
        retireProjections,
        retireReactionProjections,
        acceptanceRevision,
        ensureProjectionsHydrated,
        removeOptimisticItem,
        discardFailedItem,
    };
});

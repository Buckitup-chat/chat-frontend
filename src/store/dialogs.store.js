import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { getDialogCollections, withDialogCollections } from '@/lib/data/collections';
import { OWNER_FIELD } from '@/lib/data/ingest';
import { enqueueIntent, updateIntent } from '@/lib/data/intents';
import { signAndDispatchIntent } from '@/lib/data/intentRecovery';
import {
    materializeMessageIntent, ensureOwnDialogKeyPublished, ownSenderMsgKey,
    pinActiveSession, assertSessionUnchanged, SessionFencedError, VaultLockedError,
} from '@/lib/data/messageIntent';
import { nextOwnerTimestamp } from '@/lib/data/time';
import { computeTails } from '@/lib/data/refs';
import { getAccepted, getAllAcceptedForRelation, freshestOf } from '@/lib/data/acceptedSnapshot';
import { recordOwnObservedTails, getOwnObservedTails, discardOwnObservedTails } from '@/lib/data/ownObservedTails';
import { quarantinedEntries, discardEntry, currentSessionToken, sameSessionToken } from '@/lib/data/outbox';
import { feedOrderKey } from '@/lib/data/feedOrder';
import { loadPointer, savePointer, viewMoved, pointerDialogs, rememberPointerDialog } from '@/lib/data/checkpointAlerts';
import { createDialogGate } from '@/lib/data/dialogGate';
import { verifyMessageRow, verifySideRow } from '@/lib/pq/verifyDialogRow';
import { encodeContent, decodeContent, contentToText, previewText, isWireMessageId, ContentDecodeError } from '@/lib/pq/content';
import {
    CHECKPOINT_VERSION, REDUCER_VERSION, TREE_VERSION,
    deriveFrontierRoot, buildViewTree, diffViewTrees, classifyChanges,
} from '@/lib/pq/checkpoint';
import { prepareUpload, uploadFile, downloadFile, fileAvailability } from '@/lib/data/fileTransfer';
import { buildImagePreview, buildVideoPreview, isImageMime, isVideoMime } from '@/lib/data/imageMeta';
import { openVideo } from '@/lib/data/videoStream';
import { getVerifiedSignPkey } from '@/lib/data/cardRegistry';
import { api } from '@/api/client';
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

    // --- direct write path (TanStack migration, PR C) ---
    // One logical write = one signed mutation posted straight to /ingest_each.
    // The shape stream returns the server-confirmed row, which drops the
    // optimistic UI entry. The legacy PGlite push queue is no longer involved
    // for dialog tables.

    const getSignSkeyBytes = async () => {
        const em = EncryptionManagerPQ.getInstance();
        const keys = await em.exportVaultKeys();
        return safeBase64Decode(keys.sign_skey, 'sign_skey');
    };

    // Every dialog write is followed by a shape barrier: the next operation
    // (an edit basing on the tip, a second message needing the key row, a
    // reaction toggle) reads the collection as its base, and an HTTP 200 only
    // proves the Postgres commit — not that Electric delivered it.
    const pushRow = async (relation, row, mutationType = 'insert') => {
        const owner = row[OWNER_FIELD[relation]] ?? '';
        const readyRow = { kind: 'ready-row', relation, row, mutationType };
        const intentId = await enqueueIntent(readyRow, owner, relation);
        if (intentId === null) {
            throw new Error('This action could not be stored for sending. Nothing was sent — try again.');
        }
        const signSkey = await getSignSkeyBytes();
        return signAndDispatchIntent(intentId, readyRow, signSkey);
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
    const decryptRefsOf = async (row) => {
        const cacheKey = `${row.message_id}|${row.sign_hash}`;
        if (decryptedRefsCache.has(cacheKey)) return decryptedRefsCache.get(cacheKey);

        // Genesis and refs-less revisions legitimately have no map
        if (!row.refs_map_b64) {
            decryptedRefsCache.set(cacheKey, {});
            return {};
        }

        const key = await getSenderMsgKey(row.dialog_hash, row.sender_hash);
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
    const decryptRefsVerdict = async (row) => {
        const key = await getSenderMsgKey(row.dialog_hash, row.sender_hash);
        if (!key) return 'no_key';
        const refs = await decryptRefsOf(row);
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

    /** Gate verdict for a replicated message row. See dialogGate for shapes. */
    const admitMessageRow = (row) => gateFor(row.dialog_hash).admit(row);

    // Reactions and receipts are signed rows too (invariants/02): a forged
    // reaction under a peer's name is the same attack as a forged message.
    // Verdicts are cached by (PK, owner_timestamp) — a re-signed update gets
    // a fresh check, an unchanged row does not re-run ML-DSA on every render.
    const sideRowVerdicts = new Map();

    const admitSideRow = async (row, authorField, pkField) => {
        const cacheKey = `${row[pkField]}|${row.owner_timestamp}`;
        const cached = sideRowVerdicts.get(cacheKey);
        if (cached !== undefined) return cached;

        const authorHash = row[authorField];
        const signPkey = await getVerifiedSignPkey(authorHash);
        if (!signPkey) return false; // card not here yet — retried, not cached

        const ok = verifySideRow(row, signPkey).status === 'ok';
        sideRowVerdicts.set(cacheKey, ok);
        return ok;
    };

    /** True only for a reaction whose signature verifies against its reactor. */
    const admitReactionRow = (row) => admitSideRow(row, 'reactor_hash', 'reaction_hash');

    /** True only for a receipt whose signature verifies against its peer. */
    const admitReceiptRow = (row) => admitSideRow(row, 'peer_hash', 'receipt_hash');

    const getVerifiedMessageBase = async (dialogHash, messageId) => {
        const msgColl = getDialogCollections(dialogHash).messages;
        await msgColl.preload();
        const shapeRow = msgColl.get(messageId) || null;
        const verifiedShapeRow = shapeRow && (await admitMessageRow(shapeRow)).status === 'verified' ? shapeRow : null;
        return freshestOf(verifiedShapeRow, await getAccepted('dialog_messages', messageId));
    };

    const getVerifiedReactionBase = async (dialogHash, reactionHash) => {
        const shapeRow = getDialogCollections(dialogHash).reactions.get(reactionHash) || null;
        const verifiedShapeRow = shapeRow && (await admitReactionRow(shapeRow)) ? shapeRow : null;
        return freshestOf(verifiedShapeRow, await getAccepted('dialog_message_reactions', reactionHash));
    };

    /** True when the gate has already admitted this exact revision — used by
     * the render path to reconcile a stale 'waiting' snapshot after a batch:
     * a child admitted before its parent parks, the parent's arrival drains
     * it inside the gate, and the UI entry written earlier must catch up. */
    const isMessageAdmitted = (dialogHash, messageId, signHash) =>
        dialogGates.get(dialogHash)?.isAdmitted(messageId, signHash) ?? false;

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

    // The tails the current user observes right now — the refs_map plaintext
    // for an outgoing message or edit (pq_dialogs.md §Tail calculation).
    const computeObservedTails = async (dialogHash) => {
        const colls = getDialogCollections(dialogHash);
        await colls.messages.preload().catch(() => {});
        const loaded = colls.messages.toArray.filter((r) => !r.deleted_flag && r.sign_hash);

        const ownIds = ownSentMessageIds.get(dialogHash);
        const extra = [];
        if (ownIds?.size) {
            const knownIds = new Set(loaded.map((r) => r.message_id));
            for (const id of [...ownIds]) {
                if (knownIds.has(id)) { ownIds.delete(id); continue; }
                const accepted = await getAccepted('dialog_messages', id);
                if (accepted && !accepted.deleted_flag && accepted.sign_hash) extra.push(accepted);
            }
        }

        const withRefs = await Promise.all(
            [...loaded, ...extra].map(async (r) => ({
                message_id: r.message_id,
                sign_hash: r.sign_hash,
                refs: await decryptRefsOf(r),
            }))
        );
        return computeTails(withRefs);
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
        const resident = colls.messages.toArray.filter((r) => !r.deleted_flag && r.sign_hash);
        const loaded = resident.filter((r) => isMessageAdmitted(dialogHash, r.message_id, r.sign_hash));

        const knownIds = new Set(loaded.map((r) => r.message_id));
        const accepted = await getAllAcceptedForRelation('dialog_messages');
        const extra = accepted.filter((r) =>
            r.dialog_hash === dialogHash && r.sender_hash === ownerHash &&
            !r.deleted_flag && r.sign_hash && !knownIds.has(r.message_id)
        );

        const withRefs = await Promise.all(
            [...loaded, ...extra].map(async (r) => ({
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
    const addOptimisticReaction = (dialogHash, messageId, emoji, reactionHash, desiredActive) => {
        for (const [staleId, item] of optimisticItems.value) {
            if (item.type === 'reaction' && item.reactionHash === reactionHash) {
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
            reactionHash,
            desiredActive,
            status: 'sending',
        });
        return id;
    };

    const updateOptimisticStatus = (id, status) => {
        const item = optimisticItems.value.get(id);
        if (item) item.status = status;
    };

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

    const discardFailedItem = (id) => {
        const item = optimisticItems.value.get(id);
        removeOptimisticItem(id);
        if (!item) return;
        const cleanup = item.type === 'message'
            ? discardQuarantinedFor('dialog_messages', 'message_id', id)
            : item.type === 'reaction'
                ? discardQuarantinedFor('dialog_message_reactions', 'reaction_hash', item.reactionHash)
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
            await dialogColls.keys.preload().catch(() => {});
            const keyRow = dialogColls.keys.get(`${dialogHash}|${authorHash}`);
            if (!keyRow || keyRow.deleted_flag) return null;

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

            // It's a peer's key, we need to decap and unwrap
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

        const payload = { kind, relation: 'dialog_messages', peerHash, dialogHash, messageId, ownerHash, ownerTimestamp: nowSec, parts, observedTails };
        const intentId = await enqueueIntent(payload, ownerHash, 'dialog_messages');
        if (intentId === null) {
            await discardOwnObservedTails(messageId, ownerHash);
            throw new Error('This action could not be stored for sending. Nothing was sent — try again.');
        }
        trackOwnSentMessage(dialogHash, messageId);
        return { intentId, payload, token };
    };

    const dispatchMessageIntent = async (intentId, payload, token, onStatus) => {
        try {
            assertSessionUnchanged(token, 'dispatchMessageIntent:start');
            onStatus?.('syncing');
            const readyRow = await materializeMessageIntent(payload, token);
            assertSessionUnchanged(token, 'dispatchMessageIntent:beforeSigning');
            const signSkey = await getSignSkeyBytes().catch((e) => {
                throw new VaultLockedError(String(e?.message ?? e));
            });
            assertSessionUnchanged(token, 'dispatchMessageIntent:afterSignSkey');
            const handle = await signAndDispatchIntent(intentId, readyRow, signSkey, { token });
            if (handle.phase === 'accepted') {
                try {
                    assertSessionUnchanged(token, 'dispatchMessageIntent:beforeAcceptedCallback');
                } catch {
                    return;
                }
                onStatus?.('synced');
            } else {
                handle.acceptance.then((outcome) => {
                    try {
                        assertSessionUnchanged(token, 'dispatchMessageIntent:acceptanceCallback');
                    } catch {
                        return;
                    }
                    if (outcome.kind === 'accepted') onStatus?.('synced');
                    else onStatus?.('error', outcome.kind === 'rejected' ? outcome.error : 'discarded before delivery');
                });
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
            console.error('[dialogs] dispatchMessageIntent failed:', e);
            onStatus?.('error', e);
        }
    };

    const sendMessage = async (peerHash, content, onStatus, messageId = null, ownerTimestamp = null, kind = 'message') => {
        const { intentId, payload, token } = await captureMessageIntent(peerHash, content, messageId, ownerTimestamp, kind);
        dispatchMessageIntent(intentId, payload, token, onStatus);
        return payload.messageId;
    };

    const editIntents = new Map();
    const editQueues = new Map();
    const editClaimLocks = new Map();

    const runEditWrite = async (messageId, ctx) => {
        const intent = editIntents.get(messageId);
        if (!intent || intent.written) return null;
        intent.written = true;

        try {
            const msgColl = getDialogCollections(ctx.dialogHash).messages;
            await msgColl.preload().catch(() => {});
            const shapeRow = msgColl.get(messageId) || null;
            const verifiedShapeRow = shapeRow && (await admitMessageRow(shapeRow)).status === 'verified' ? shapeRow : null;
            const freshBase = freshestOf(verifiedShapeRow, await getAccepted('dialog_messages', messageId));
            const parentSignHash = freshBase ? freshBase.sign_hash : intent.parentSignHash;
            const ownerTimestamp = freshBase ? nextOwnerTimestamp(freshBase.owner_timestamp) : intent.ownerTimestamp;
            const row = {
                message_id: messageId,
                dialog_hash: ctx.dialogHash,
                sender_hash: ctx.senderHash,
                content_b64: intent.contentB64,
                deleted_flag: false,
                refs_map_b64: intent.refsMapB64,
                parent_sign_hash: parentSignHash,
                owner_timestamp: ownerTimestamp,
            };
            if (parentSignHash !== intent.parentSignHash || ownerTimestamp !== intent.ownerTimestamp) {
                const persisted = await updateIntent(intent.intentId, { kind: 'ready-row', relation: 'dialog_messages', mutationType: 'update', row });
                if (!persisted) console.warn('[dialogs] could not persist the refreshed base for', messageId);
            }

            const signSkey = await getSignSkeyBytes();
            let dispatchedSignHash = null;
            const handle = await signAndDispatchIntent(intent.intentId, {
                kind: 'ready-row',
                relation: 'dialog_messages',
                mutationType: 'update',
                row,
            }, signSkey, {
                onSigned: (mutation) => { dispatchedSignHash = mutation.changes?.sign_hash ?? null; },
            });
            await handle.acceptance;
            return { signHash: dispatchedSignHash, ownerTimestamp: row.owner_timestamp };
        } catch (e) {
            if (!e?.permanent && editIntents.get(messageId) === intent) {
                intent.written = false;
            }
            throw e;
        } finally {
            if (editIntents.get(messageId) === intent && intent.written) {
                editIntents.delete(messageId);
            }
        }
    };

    /**
     * Edit a message (owner only)
     */
    const editMessage = async (peerHash, messageId, newText) => {
        const dialogHash = await initDialogKeys(peerHash);
        const myKey = await getSenderMsgKey(dialogHash, $userPQ.currentUserHash);

        // A version chain is built from the tip — whichever is fresher of the
        // gate-verified shape row and this account's own accepted-snapshot
        // (§4.5/§R3): our last accepted write may not be visible in the shape
        const current = await getVerifiedMessageBase(dialogHash, messageId);
        if (!current) throw new Error('Message not found');
        if (current.sender_hash !== $userPQ.currentUserHash) {
            throw new Error('Cannot edit: not owner');
        }

        const newParts = typeof newText === 'string' ? [{ kind: 'text', text: newText }] : newText;
        const contentB64 = await DialogCrypto.encryptContent(myKey, encodeContent(newParts));
        // Refs are recomputed at edit time — the tails may have changed since
        // the original authoring; the old refs stay archived with the old
        // revision in dialog_messages_versions (spec: §Behavior on edit)
        const refsMap = await computeObservedTails(dialogHash);
        const refsMapB64 = await DialogCrypto.encryptContent(myKey, JSON.stringify(refsMap));

        // §3.1 + §3.12: claiming "is there already a coalescable intent for
        // this message" and durably enqueuing/updating it must be one atomic
        // step — both edits in a concurrent burst reach this point only after
        // several independent awaits (key derivation, encryption, tails), so
        // without a lock here two calls could both read editIntents.get() as
        // empty and both enqueue a fresh durable intent; whichever loses the
        // final editIntents.set() becomes an ORPHAN that nothing ever
        // resolves, and recovery (§3.6) would sign and send it separately
        // after a reload — a phantom edit nobody coalesced away.
        //
        // This lock covers ONLY the durable claim decision, not dispatch:
        // runEditWrite starts running (and flips written=true) the moment it
        // is queued, lock or no lock, so holding the lock across queueing too
        // would let the first call's own dispatch start and claim written=true
        // before the SECOND call's claim even begins — permanently defeating
        // coalescing (every burst would degrade to "second one is unrelated").
        // Releasing the lock right after the durable decision gives a truly
        // concurrent sibling a chance to claim before that happens.
        const claim = editClaimLocks.get(messageId) ?? Promise.resolve();
        const claimed = claim.then(async () => {
            const existingIntent = editIntents.get(messageId);
            const parentSignHash = existingIntent ? existingIntent.parentSignHash : current.sign_hash;
            const ownerTimestamp = existingIntent
                ? existingIntent.ownerTimestamp
                : nextOwnerTimestamp(current.owner_timestamp);

            const storedRow = {
                message_id: messageId,
                dialog_hash: dialogHash,
                sender_hash: $userPQ.currentUserHash,
                content_b64: contentB64,
                deleted_flag: false,
                refs_map_b64: refsMapB64,
                parent_sign_hash: parentSignHash,
                owner_timestamp: ownerTimestamp,
            };

            if (existingIntent && !existingIntent.written) {
                // Coalesce: update the durable intent in place. No queue
                // registration here — the dispatch already queued by
                // whichever call created this intent will read this content
                // when it runs.
                const persisted = await updateIntent(existingIntent.intentId, { kind: 'ready-row', relation: 'dialog_messages', mutationType: 'update', row: storedRow });
                if (!persisted) {
                    throw new Error('This edit could not be stored for sending. Nothing was sent — try again.');
                }
                editIntents.set(messageId, { ...existingIntent, contentB64, refsMapB64, parentSignHash, ownerTimestamp });
                return { fresh: false };
            }

            // Fresh: durably enqueue. This call owns the one dispatch this
            // burst gets — but does not queue it yet (see below, outside the
            // lock).
            const intentId = await enqueueIntent(
                { kind: 'ready-row', relation: 'dialog_messages', mutationType: 'update', row: storedRow },
                $userPQ.currentUserHash,
                'dialog_messages'
            );
            if (intentId === null) {
                throw new Error('This action could not be stored for sending. Nothing was sent — try again.');
            }
            editIntents.set(messageId, { intentId, contentB64, refsMapB64, parentSignHash, ownerTimestamp, written: false });
            return { fresh: true };
        });
        editClaimLocks.set(messageId, claimed.then(() => undefined, () => undefined));
        const { fresh } = await claimed;

        // An edit is an HTTP `update`: the server replaces the tip and
        // archives the previous revision in dialog_messages_versions.
        // Chained onto whatever is still running for this message (e.g. an
        // earlier, already-in-flight write this one did not coalesce into)
        // — never two writes for the same message at once, even unrelated
        // ones. A coalescing call does not queue anything of its own; it
        // just waits on whatever is already there.
        const ctx = { dialogHash, senderHash: $userPQ.currentUserHash };
        let dispatchedWrite = editQueues.get(messageId);
        // "fresh" claims queue their own write. A coalescing claim normally
        // rides the live one — but after a transient failure the intent
        // survives while the write is gone, and waiting on nothing would
        // silently drop the newer text (the durable outbox would then replay
        // the OLD revision). No live write ⇒ dispatch here too.
        if (fresh || !dispatchedWrite) {
            const previousWrite = dispatchedWrite ?? Promise.resolve();
            const nextWrite = previousWrite.then(
                () => runEditWrite(messageId, ctx),
                () => runEditWrite(messageId, ctx)
            );
            const settledWrite = nextWrite.then(() => undefined, () => undefined);
            editQueues.set(messageId, nextWrite);
            settledWrite.then(() => {
                if (editQueues.get(messageId) === nextWrite) editQueues.delete(messageId);
            });
            dispatchedWrite = nextWrite;
        }

        const dispatched = (await dispatchedWrite) ?? {};
        return { messageId, signHash: dispatched.signHash ?? null, ownerTimestamp: dispatched.ownerTimestamp ?? null };
    };

    // ---------- file transport (§1.5, §2.1–2.3) ----------

    // §4.1: file_id + enc_secret persist BEFORE the first PUT — file_id alone
    // cannot resume, since a fresh secret would make re-sent chunks
    // undecryptable next to the ones already stored.
    const pendingUploadKey = (fileId) => `bkp:pending-upload:${fileId}`;

    /**
     * Uploads a file and sends the message referencing it. Progress is in
     * chunks (§2.1 — "куски, а не проценты-догадки"). Returns the fileId.
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
     * Deletes own message (§3.2): a new signed revision with deleted_flag and
     * empty content — the empty plaintext IS the tombstone (07: an empty
     * content_b64 is only valid alongside deleted_flag). The previous
     * revision is archived server-side like any edit; refs are recomputed at
     * deletion time per pq_dialogs §dialog_messages.
     */
    const deleteMessage = async (peerHash, messageId) => {
        const dialogHash = await initDialogKeys(peerHash);
        // A tombstone is a new version of the message: same chain, same rule
        // as an edit (§4.5/§R3 — freshest of gate-verified shape row and own
        // accepted-snapshot).
        const myKey = await getSenderMsgKey(dialogHash, $userPQ.currentUserHash);

        const current = await getVerifiedMessageBase(dialogHash, messageId);
        if (!current) throw new Error('Message not found');
        if (current.sender_hash !== $userPQ.currentUserHash) {
            throw new Error('Cannot delete: not owner');
        }

        const refsMap = await computeObservedTails(dialogHash);
        const refsMapB64 = await DialogCrypto.encryptContent(myKey, JSON.stringify(refsMap));

        await pushRow('dialog_messages', {
            message_id: messageId,
            dialog_hash: dialogHash,
            sender_hash: $userPQ.currentUserHash,
            // null, not '': Ecto casts an empty string to nil, so the server
            // signs "null" where '' was signed — verified live, '' gets 422
            // invalid_signature while null is accepted.
            content_b64: null,
            deleted_flag: true,
            refs_map_b64: refsMapB64,
            parent_sign_hash: current.sign_hash,
            owner_timestamp: nextOwnerTimestamp(current.owner_timestamp),
        }, 'update');
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
        await colls.versions.preload().catch(() => {});
        const rows = colls.versions.toArray.filter((v) => v.message_id === messageId);

        const out = [];
        for (const row of rows) {
            const signPkey = await getVerifiedSignPkey(row.sender_hash);
            const verified = !!signPkey && verifyMessageRow(row, signPkey).status === 'ok';
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
    });

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
    const findLatestCheckpoint = async (dialogHash, rows, pointer, colls = null) => {
        const mine = rows
            .filter((r) => r.sender_hash === $userPQ.currentUserHash && !r.deleted_flag && r.content_b64)
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
        const { rows, pointer } = await withDialogCollections(dialogHash, async (colls) => {
            await colls.messages.preload().catch(() => { });
            const loaded = colls.messages.toArray.filter((r) => r.sign_hash);
            return { rows: loaded, pointer: await findLatestCheckpoint(dialogHash, loaded, stored, colls) };
        });
        if (pointer.scannedTo !== stored.scannedTo || pointer.checkpoint !== stored.checkpoint) {
            await savePointer(me, dialogHash, pointer);
        } else if (pointer.checkpoint) {
            // Unchanged pointer ≠ registered dialog: the index entry can be
            // lost independently (a failed write), and this visit is its
            // only way back — the sweep never looks at unindexed dialogs.
            await rememberPointerDialog(me, dialogHash);
        }
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

    const computeDialogFrontier = async (rows) => {
        // Same candidate rule as computeObservedTails (pq_dialogs.md §Tail
        // calculation): the checkpoint's frontier commits to the frontier the
        // dialog's refs_map actually describe. A row admitted here but not
        // there (a tombstone) would become a permanent frontier member no
        // refs_map ever references, skewing the root on identical state.
        const candidates = rows.filter((r) => !r.deleted_flag && r.sign_hash);
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
     * the device has not fully verified (ТЗ §7 — head hashes alone can
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
            else if (status === 'error') settle.reject(new Error('CHECKPOINT_SEND_FAILED', { cause }));
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
        const signPkey = await getVerifiedSignPkey(row.sender_hash);
        if (!signPkey || verifyMessageRow(row, signPkey).status !== 'ok') {
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
    // Per-reaction_hash serialization with coalescing.
    //
    // Rapid clicks must not each derive their state from the server row: the
    // shape has not caught up, so every click would compute the same
    // "desiredActive" and fire duplicate inserts of one deterministic PK. The
    // effective state is therefore server state overlaid with the latest
    // in-flight intent, and only the FINAL intent is actually written —
    // intermediate clicks collapse.
    //
    // An intent outlives its own write. Dropping it the moment the write
    // starts left the interval between "request sent" and "shape caught up"
    // unguarded: a click arriving there saw neither a server row nor an
    // intent, concluded the reaction was off, and re-sent "on" — so a second
    // click during a slow write silently repeated the first instead of
    // undoing it. The intent is therefore cleared only once the write has
    // settled, and `written` stops a queued duplicate from re-sending it.
    const reactionIntents = new Map(); // reaction_hash -> { desiredActive, messageSignHash, written }
    const reactionQueues = new Map();  // reaction_hash -> Promise
    const reactionDispatches = new Map(); // reaction_hash -> Promise<DeliveryHandle>

    const runReactionWrite = async (reactionHash, ctx) => {
        const intent = reactionIntents.get(reactionHash);
        if (!intent || intent.written) return reactionDispatches.get(reactionHash);
        intent.written = true;

        const { dialogHash, messageId, emoji, myKey, myHash } = ctx;
        // Re-read after the previous write for this reaction: the row may now
        // exist (or have moved to another revision). §4.5/§R3: prefer
        // whichever is fresher of the gate-verified shape row and our own
        // accepted-snapshot — the shape may not have caught up with our
        const existing = await getVerifiedReactionBase(dialogHash, reactionHash);

        const base = {
            reaction_hash: reactionHash,
            dialog_hash: dialogHash,
            message_id: messageId,
            // A reaction belongs to a specific message revision. Reacting on a
            // newer revision moves the row to it (product decision 2026-08-11).
            message_sign_hash: intent.messageSignHash,
            reactor_hash: myHash,
        };

        // A retraction still needs an encrypted, non-empty type_b64: the
        // backend's own changeset requires the field present (Ecto treats an
        // empty binary as blank), so a literal '' is rejected 422 forever and
        // the reaction can never be removed. Encrypt an empty emoji instead.
        const typeB64 = await DialogCrypto.encryptContent(myKey, intent.desiredActive ? emoji : '');
        const row = {
            ...base,
            type_b64: typeB64,
            deleted_flag: !intent.desiredActive,
            owner_timestamp: nextOwnerTimestamp(existing?.owner_timestamp ?? null),
        };

        // Existing row (even a tombstone, even on another revision) → update.
        const dispatch = pushRow('dialog_message_reactions', row, existing ? 'update' : 'insert');
        reactionDispatches.set(reactionHash, dispatch);
        try {
            const handle = await dispatch;
            await handle.acceptance;
            return handle;
        } catch (e) {
            // Transient: the write may still land, and the UI keeps showing the
            // desired state, so the intent has to stay to keep the next click
            // inverting from what the user sees. Permanent: fall through and
            // drop it, back to server truth.
            if (!e?.permanent && reactionIntents.get(reactionHash) === intent) {
                intent.written = false;
            }
            throw e;
        } finally {
            // Only if nobody clicked again: a newer click replaced the entry,
            // and that one still needs to be written.
            if (reactionIntents.get(reactionHash) === intent && intent.written) {
                reactionIntents.delete(reactionHash);
            }
        }
    };

    const toggleReaction = async (peerHash, { messageId, messageSignHash, emoji }) => {
        if (!messageSignHash) {
            throw new Error('Cannot react: message revision is not synced yet');
        }

        const dialogHash = await initDialogKeys(peerHash);
        const myHash = $userPQ.currentUserHash;
        const myKey = await getSenderMsgKey(dialogHash, myHash);

        const reactionHash = DialogCrypto.computeReactionHash(myKey, messageId, myHash, emoji);

        const existing = await getVerifiedReactionBase(dialogHash, reactionHash);
        // Active only if the row is live AND attached to the revision being
        // displayed: after an edit the old reaction is not shown, so clicking
        // means "react on this revision", not "remove".
        const serverActive = !!existing
            && !existing.deleted_flag
            && existing.message_sign_hash === messageSignHash;

        const pending = reactionIntents.get(reactionHash);
        const effectiveActive = pending ? pending.desiredActive : serverActive;
        const desiredActive = !effectiveActive;

        reactionIntents.set(reactionHash, { desiredActive, messageSignHash, written: false });

        const optimisticId = addOptimisticReaction(dialogHash, messageId, emoji, reactionHash, desiredActive);

        const previous = reactionQueues.get(reactionHash) ?? Promise.resolve();
        const ctx = { dialogHash, messageId, emoji, myKey, myHash };
        const next = previous.then(
            () => runReactionWrite(reactionHash, ctx),
            () => runReactionWrite(reactionHash, ctx)
        );

        const settled = next.then(() => undefined, () => undefined);
        reactionQueues.set(reactionHash, settled);
        settled.then(() => {
            if (reactionQueues.get(reactionHash) === settled) reactionQueues.delete(reactionHash);
        });

        next.then(
            (handle) => {
                if (!handle) {
                    console.warn('[dialogs] toggleReaction: no dispatch to track acceptance from');
                    updateOptimisticStatus(optimisticId, 'error');
                    return;
                }
                if (handle.phase === 'accepted') {
                    updateOptimisticStatus(optimisticId, 'synced');
                    return;
                }
                handle.acceptance.then((outcome) => {
                    updateOptimisticStatus(optimisticId, outcome.kind === 'accepted' ? 'synced' : 'error');
                });
            },
            (e) => {
                console.error('[dialogs] toggleReaction failed:', e);
                if (e?.permanent) {
                    // The server will never accept this toggle — roll the
                    // OPTIMISTIC state back so the UI stops showing an action
                    // that did not happen. This is not the same decision as
                    removeOptimisticItem(optimisticId);
                } else {
                    // Transient: the write may still land later, so keep it
                    // visible — but as an explicit error, not as 'syncing'.
                    updateOptimisticStatus(optimisticId, 'error');
                }
            }
        );

        updateOptimisticStatus(optimisticId, 'syncing');
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
    const sendReceipt = async (peerHash, { messageId, messageSignHash }, type) => {
        if (!messageSignHash) {
            throw new Error('Cannot acknowledge: message revision is not synced yet');
        }

        const dialogHash = await initDialogKeys(peerHash);
        const myHash = $userPQ.currentUserHash;

        const receiptHash = DialogCrypto.computeReceiptHash(messageId, messageSignHash, myHash, type);

        const dialogColls = getDialogCollections(dialogHash);
        await dialogColls.receipts.preload().catch(() => {});
        const existing = dialogColls.receipts.get(receiptHash);
        // Already acknowledged: the deterministic hash makes this a no-op
        // rather than a duplicate insert the server would reject.
        if (existing) return receiptHash;

        await pushRow('dialog_message_receipts', {
            receipt_hash: receiptHash,
            dialog_hash: dialogHash,
            message_id: messageId,
            peer_hash: myHash,
            type,
            message_sign_hash: messageSignHash,
            owner_timestamp: nextOwnerTimestamp(null),
        });

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
        removeOptimisticItem,
        discardFailedItem,
    };
});

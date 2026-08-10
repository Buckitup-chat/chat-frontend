import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { getUserCardsCollection, getDialogCollections } from '@/lib/data/collections';
import { sendMutationsWithRetry } from '@/lib/data/ingest';
import { nextOwnerTimestamp } from '@/lib/data/time';
import { computeTails } from '@/lib/data/refs';
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

    const pushRow = async (relation, row, mutationType = 'insert') => {
        const signSkey = await getSignSkeyBytes();
        const mutation = api.createGenericMutation(relation, row, signSkey, mutationType);
        return sendMutationsWithRetry([mutation], signSkey);
    };

    // --- causal refs (refs_map) ---
    // Decrypted refs of a specific revision never change; cache by
    // (message_id, sign_hash). An edit produces a new sign_hash → new entry.
    const decryptedRefsCache = new Map();

    const decryptRefsOf = async (row) => {
        const cacheKey = `${row.message_id}|${row.sign_hash}`;
        if (decryptedRefsCache.has(cacheKey)) return decryptedRefsCache.get(cacheKey);
        let refs = {};
        try {
            if (row.refs_map_b64) {
                const key = await getSenderMsgKey(row.dialog_hash, row.sender_hash);
                if (key) {
                    const json = await DialogCrypto.decryptContent(key, row.refs_map_b64);
                    refs = json ? JSON.parse(json) : {};
                }
            }
        } catch (e) {
            console.warn('[dialogs] refs decrypt failed for', row.message_id, e);
        }
        decryptedRefsCache.set(cacheKey, refs);
        return refs;
    };

    // The tails the current user observes right now — the refs_map plaintext
    // for an outgoing message or edit (pq_dialogs.md §Tail calculation).
    const computeObservedTails = async (dialogHash) => {
        const colls = getDialogCollections(dialogHash);
        await colls.messages.preload().catch(() => {});
        const loaded = colls.messages.toArray.filter((r) => !r.deleted_flag && r.sign_hash);
        const withRefs = await Promise.all(
            loaded.map(async (r) => ({
                message_id: r.message_id,
                sign_hash: r.sign_hash,
                refs: await decryptRefsOf(r),
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

    const addOptimisticReaction = (dialogHash, messageId, emoji) => {
        const id = `opt_react_${++optimisticCounter}_${Date.now()}`;
        optimisticItems.value.set(id, {
            type: 'reaction',
            id,
            dialogHash,
            messageId,
            emoji,
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

    const getDialogHash = (peerHash) => {
        if (!$userPQ.currentUserHash) return null;
        return DialogCrypto.computeDialogHash($userPQ.currentUserHash, peerHash);
    };

    /**
     * Get or initialize keys for a dialog with a peer
     */
    const initDialogKeys = async (peerHash) => {
        const dialogHash = getDialogHash(peerHash);
        if (!dialogHash) throw new Error("Not logged in");

        // Try to get my own keys from the dialog collection
        const dialogColls = getDialogCollections(dialogHash);
        await dialogColls.keys.preload().catch(() => {});
        const myKeyRow = dialogColls.keys.get(`${dialogHash}|${$userPQ.currentUserHash}`);

        if (!myKeyRow || myKeyRow.deleted_flag) {
            console.log(`Generating new dialog keys for dialog: ${dialogHash}`);
            
            // Generate keys
            const em = EncryptionManagerPQ.getInstance();
            const keys = await em.exportVaultKeys();
            
            const signSkey = safeBase64Decode(keys.sign_skey, 'sign_skey');
            const kemSkey = safeBase64Decode(keys.crypt_skey, 'crypt_skey');
            
            const senderMsgKey = DialogCrypto.deriveSenderMsgKey(
                signSkey, kemSkey, keys.evm_skey, peerHash
            );
            
            // Get peer's user card (Electric-synced collection) for crypt_pkey
            const cards = getUserCardsCollection();
            await cards.preload();
            const peerCard = cards.get(peerHash) || null;
            if (!peerCard || !peerCard.crypt_pkey) {
                throw new Error("Peer crypt_pkey not found");
            }

            const peerCryptPkey = safeBase64Decode(peerCard.crypt_pkey, 'peerCard.crypt_pkey');

            // Wrap for peer
            const { peerKemWrapKeyB64, peerWrappedMsgKeyB64 } = await DialogCrypto.wrapSenderMsgKey(senderMsgKey, peerCryptPkey);

            const keysRow = {
                dialog_hash: dialogHash,
                sender_hash: $userPQ.currentUserHash,
                peer_hash: peerHash,
                peer_kem_wrap_key_b64: peerKemWrapKeyB64,
                peer_wrapped_msg_key_b64: peerWrappedMsgKeyB64,
                owner_timestamp: Math.floor(Date.now() / 1000),
                deleted_flag: false,
                sign_b64: null
            };

            // Own sender key is deterministically re-derivable from vault
            // secrets, so no local persistence is needed — the signed row
            // just has to reach the server for the peer (and other devices).
            await pushRow('dialog_keys', keysRow);

            // Cache it
            senderMsgKeys.value[`${dialogHash}_${$userPQ.currentUserHash}`] = senderMsgKey;
        } else {
            // Already initialized, ensure it's in memory cache
            if (!senderMsgKeys.value[`${dialogHash}_${$userPQ.currentUserHash}`]) {
                const em = EncryptionManagerPQ.getInstance();
                const keys = await em.exportVaultKeys();
                const signSkey = safeBase64Decode(keys.sign_skey, 'sign_skey');
                const kemSkey = safeBase64Decode(keys.crypt_skey, 'crypt_skey');
                
                const senderMsgKey = DialogCrypto.deriveSenderMsgKey(
                    signSkey, kemSkey, keys.evm_skey, peerHash
                );
                senderMsgKeys.value[`${dialogHash}_${$userPQ.currentUserHash}`] = senderMsgKey;
            }
        }
        return dialogHash;
    };

    /**
     * Get a senderMsgKey (either ours or peer's)
     */
    const pendingKeys = {};

    const getSenderMsgKey = async (dialogHash, authorHash) => {
        const cacheKey = `${dialogHash}_${authorHash}`;
        if (senderMsgKeys.value[cacheKey]) return senderMsgKeys.value[cacheKey];
        if (pendingKeys[cacheKey]) return pendingKeys[cacheKey];

        const promise = (async () => {
            const dialogColls = getDialogCollections(dialogHash);
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

    /**
     * Send a message (optimistic: returns immediately, syncs in background)
     */
    const sendMessage = async (peerHash, text, onStatus, messageId = null, ownerTimestamp = null) => {
        if (!messageId) {
            const { v7 } = await import('uuid');
            messageId = "dmsg_" + v7();
        }

        const nowSec = ownerTimestamp || Math.floor(Date.now() / 1000);

        (async () => {
            onStatus?.('sending');
            try {
                const dialogHash = await initDialogKeys(peerHash);
                const myKey = await getSenderMsgKey(dialogHash, $userPQ.currentUserHash);

                const contentJson = JSON.stringify({ type: "text", text: text });
                const contentB64 = await DialogCrypto.encryptContent(myKey, contentJson);

                // Causal refs: the DAG tails observed at send time ({} only
                // for the genesis message, when nothing is loaded yet)
                const refsMap = await computeObservedTails(dialogHash);
                const refsMapB64 = await DialogCrypto.encryptContent(myKey, JSON.stringify(refsMap));

                onStatus?.('syncing');
                await pushRow('dialog_messages', {
                    message_id: messageId,
                    dialog_hash: dialogHash,
                    sender_hash: $userPQ.currentUserHash,
                    content_b64: contentB64,
                    deleted_flag: false,
                    refs_map_b64: refsMapB64,
                    parent_sign_hash: null,
                    owner_timestamp: nowSec,
                });
                onStatus?.('synced');
            } catch (e) {
                console.error('[dialogs] sendMessage failed:', e);
                onStatus?.('error');
            }
        })();

        return messageId;
    };

    /**
     * Edit a message (owner only)
     */
    const editMessage = async (peerHash, messageId, newText) => {
        const dialogHash = await initDialogKeys(peerHash);
        const myKey = await getSenderMsgKey(dialogHash, $userPQ.currentUserHash);

        // The server-confirmed row (with its sign_hash) lives in the dialog collection
        const msgColl = getDialogCollections(dialogHash).messages;
        await msgColl.preload().catch(() => {});
        const current = msgColl.get(messageId) || null;
        if (!current) throw new Error('Message not found');
        if (current.sender_hash !== $userPQ.currentUserHash) {
            throw new Error('Cannot edit: not owner');
        }

        const contentJson = JSON.stringify({ type: "text", text: newText });
        const contentB64 = await DialogCrypto.encryptContent(myKey, contentJson);
        // Refs are recomputed at edit time — the tails may have changed since
        // the original authoring; the old refs stay archived with the old
        // revision in dialog_messages_versions (spec: §Behavior on edit)
        const refsMap = await computeObservedTails(dialogHash);
        const refsMapB64 = await DialogCrypto.encryptContent(myKey, JSON.stringify(refsMap));

        // An edit is an HTTP `update`: the server replaces the tip and archives
        // the previous revision in dialog_messages_versions. The timestamp must
        // be strictly newer than the tip's, even inside the same second.
        await pushRow('dialog_messages', {
            message_id: messageId,
            dialog_hash: dialogHash,
            sender_hash: $userPQ.currentUserHash,
            content_b64: contentB64,
            deleted_flag: false,
            refs_map_b64: refsMapB64,
            parent_sign_hash: current.sign_hash,
            owner_timestamp: nextOwnerTimestamp(current.owner_timestamp),
        }, 'update');

        return messageId;
    };

    /**
     * Decrypt a message row
     */
    const decryptMessageRow = async (row) => {
        try {
            const key = await getSenderMsgKey(row.dialog_hash, row.sender_hash);
            if (!key) return { ...row, decrypted: false, text: "Waiting for keys..." };

            const jsonStr = await DialogCrypto.decryptContent(key, row.content_b64);
            const parsed = jsonStr ? JSON.parse(jsonStr) : { text: "" };
            
            return {
                ...row,
                decrypted: true,
                text: parsed.text || "",
                type: parsed.type || "text",
                isMine: row.sender_hash === $userPQ.currentUserHash
            };
        } catch (e) {
            console.error("Decrypt error", e);
            return { ...row, decrypted: false, text: "Decryption failed" };
        }
    };

    /**
     * Toggle reaction (optimistic: returns immediately, syncs in background)
     */
    const toggleReaction = async (peerHash, messageId, emoji, onStatus) => {
        (async () => {
            onStatus?.('sending');
            try {
                const dialogHash = await initDialogKeys(peerHash);
                const myKey = await getSenderMsgKey(dialogHash, $userPQ.currentUserHash);

                const reactionHash = DialogCrypto.computeReactionHash(
                    myKey, messageId, $userPQ.currentUserHash, emoji
                );

                const dialogColls = getDialogCollections(dialogHash);
                const messageSignHash = dialogColls.messages.get(messageId)?.sign_hash || '';

                // reaction_hash is a deterministic PK: once a row exists — even
                // as a tombstone after un-reacting — every later toggle must be
                // an `update`. Re-inserting the same PK is rejected by the
                // server, which used to be masked and left reactions
                // impossible to re-add.
                const existing = dialogColls.reactions.get(reactionHash);
                const active = !!existing && !existing.deleted_flag;

                onStatus?.('syncing');
                const base = {
                    reaction_hash: reactionHash,
                    dialog_hash: dialogHash,
                    message_id: messageId,
                    message_sign_hash: messageSignHash,
                    reactor_hash: $userPQ.currentUserHash,
                };
                if (existing) {
                    const typeB64 = active ? '' : await DialogCrypto.encryptContent(myKey, emoji);
                    await pushRow('dialog_message_reactions', {
                        ...base,
                        type_b64: typeB64,
                        deleted_flag: active,
                        owner_timestamp: nextOwnerTimestamp(existing.owner_timestamp),
                    }, 'update');
                } else {
                    const typeB64 = await DialogCrypto.encryptContent(myKey, emoji);
                    await pushRow('dialog_message_reactions', {
                        ...base,
                        type_b64: typeB64,
                        deleted_flag: false,
                        owner_timestamp: nextOwnerTimestamp(null),
                    });
                }
                onStatus?.('synced');
            } catch (e) {
                console.error('[dialogs] toggleReaction failed:', e);
                onStatus?.('error');
            }
        })();
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
        editMessage,
        decryptMessageRow,
        toggleReaction,
        decryptReactionRow,
        optimisticItems,
        addOptimisticMessage,
        addOptimisticMessageWithId,
        addOptimisticReaction,
        updateOptimisticStatus,
        removeOptimisticItem,
    };
});

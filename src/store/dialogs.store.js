import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { localDB } from '@/utils/db/localDBv2';
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

        // Try to get my own keys from DB
        let { rows: myKeys } = await localDB.db.query(
            `SELECT * FROM dialog_keys WHERE dialog_hash = $1 AND sender_hash = $2 AND NOT deleted_flag`,
            [dialogHash, $userPQ.currentUserHash]
        );

        if (myKeys.length === 0) {
            console.log(`Generating new dialog keys for dialog: ${dialogHash}`);
            
            // Generate keys
            const em = EncryptionManagerPQ.getInstance();
            const keys = await em.exportVaultKeys();
            
            const signSkey = safeBase64Decode(keys.sign_skey, 'sign_skey');
            const kemSkey = safeBase64Decode(keys.crypt_skey, 'crypt_skey');
            
            const senderMsgKey = DialogCrypto.deriveSenderMsgKey(
                signSkey, kemSkey, keys.evm_skey, peerHash
            );
            
            // Get peer's user card to find their crypt_pkey
            const peerCard = await localDB.getUser(peerHash);
            if (!peerCard || !peerCard.crypt_pkey) {
                throw new Error("Peer crypt_pkey not found");
            }

            const peerCryptPkey = safeBase64Decode(peerCard.crypt_pkey, 'peerCard.crypt_pkey');

            // Wrap for peer
            const { peerKemWrapKeyB64, peerWrappedMsgKeyB64 } = await DialogCrypto.wrapSenderMsgKey(senderMsgKey, peerCryptPkey);

            await localDB.upsertDialogKeysLocal({
                dialog_hash: dialogHash,
                sender_hash: $userPQ.currentUserHash,
                peer_hash: peerHash,
                peer_kem_wrap_key_b64: peerKemWrapKeyB64,
                peer_wrapped_msg_key_b64: peerWrappedMsgKeyB64,
                owner_timestamp: Math.floor(Date.now() / 1000),
                deleted_flag: false,
                sign_b64: null // Will be auto-signed by sendPendingDialogChanges
            });

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
            // Is it our own key?
            if (authorHash === $userPQ.currentUserHash) {
                const { rows: keysRows } = await localDB.db.query(
                    `SELECT peer_hash FROM dialog_keys WHERE dialog_hash = $1 AND sender_hash = $2 AND NOT deleted_flag`,
                    [dialogHash, authorHash]
                );
                if (keysRows.length === 0) return null;
                
                const em = EncryptionManagerPQ.getInstance();
                const keys = await em.exportVaultKeys();
                const signSkey = safeBase64Decode(keys.sign_skey, 'sign_skey');
                const kemSkey = safeBase64Decode(keys.crypt_skey, 'crypt_skey');
                
                const senderMsgKey = DialogCrypto.deriveSenderMsgKey(
                    signSkey, kemSkey, keys.evm_skey, keysRows[0].peer_hash
                );
                senderMsgKeys.value[cacheKey] = senderMsgKey;
                return senderMsgKey;
            }

            // It's a peer's key, we need to decap and unwrap
            const { rows: keysRows } = await localDB.db.query(
                `SELECT peer_kem_wrap_key_b64, peer_wrapped_msg_key_b64 FROM dialog_keys WHERE dialog_hash = $1 AND sender_hash = $2 AND NOT deleted_flag`,
                [dialogHash, authorHash]
            );

            if (keysRows.length === 0) return null;

            const em = EncryptionManagerPQ.getInstance();
            const keys = await em.exportVaultKeys();
            const cryptSkey = safeBase64Decode(keys.crypt_skey, 'crypt_skey');

            const unwrapped = await DialogCrypto.unwrapSenderMsgKey(
                cryptSkey,
                keysRows[0].peer_kem_wrap_key_b64,
                keysRows[0].peer_wrapped_msg_key_b64
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

                const refsMap = {};
                const refsMapB64 = await DialogCrypto.encryptContent(myKey, JSON.stringify(refsMap));

                onStatus?.('syncing');
                await localDB.upsertDialogMessageLocal({
                    message_id: messageId,
                    dialog_hash: dialogHash,
                    sender_hash: $userPQ.currentUserHash,
                    content_b64: contentB64,
                    deleted_flag: false,
                    refs_map_b64: refsMapB64,
                    parent_sign_hash: null,
                    owner_timestamp: nowSec,
                    sign_b64: null,
                    sign_hash: null
                });
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

        const { rows } = await localDB.db.query(
            `SELECT dialog_hash, sender_hash, sign_hash FROM dialog_messages WHERE message_id = $1`,
            [messageId]
        );
        if (rows.length === 0) throw new Error('Message not found');
        if (rows[0].sender_hash !== $userPQ.currentUserHash) {
            throw new Error('Cannot edit: not owner');
        }

        const contentJson = JSON.stringify({ type: "text", text: newText });
        const contentB64 = await DialogCrypto.encryptContent(myKey, contentJson);
        const refsMap = {};
        const refsMapB64 = await DialogCrypto.encryptContent(myKey, JSON.stringify(refsMap));

        await localDB.upsertDialogMessageLocal({
            message_id: messageId,
            dialog_hash: dialogHash,
            sender_hash: $userPQ.currentUserHash,
            content_b64: contentB64,
            deleted_flag: false,
            refs_map_b64: refsMapB64,
            parent_sign_hash: rows[0].sign_hash,
            owner_timestamp: Math.floor(Date.now() / 1000),
            sign_b64: null,
            sign_hash: null
        });

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

                const { rows: msgRows } = await localDB.db.query(
                    `SELECT sign_hash FROM dialog_messages WHERE message_id = $1`,
                    [messageId]
                );
                const messageSignHash = msgRows[0]?.sign_hash || '';

                const { rows } = await localDB.db.query(
                    `SELECT deleted_flag FROM dialog_message_reactions WHERE reaction_hash = $1`,
                    [reactionHash]
                );

                const exists = rows.length > 0 && !rows[0].deleted_flag;

                onStatus?.('syncing');
                if (exists) {
                    await localDB.upsertDialogReactionLocal({
                        reaction_hash: reactionHash,
                        dialog_hash: dialogHash,
                        message_id: messageId,
                        message_sign_hash: messageSignHash,
                        reactor_hash: $userPQ.currentUserHash,
                        type_b64: '',
                        deleted_flag: true,
                        owner_timestamp: Math.floor(Date.now() / 1000),
                        sign_b64: null
                    });
                } else {
                    const typeB64 = await DialogCrypto.encryptContent(myKey, emoji);
                    await localDB.upsertDialogReactionLocal({
                        reaction_hash: reactionHash,
                        dialog_hash: dialogHash,
                        message_id: messageId,
                        message_sign_hash: messageSignHash,
                        reactor_hash: $userPQ.currentUserHash,
                        type_b64: typeB64,
                        deleted_flag: false,
                        owner_timestamp: Math.floor(Date.now() / 1000),
                        sign_b64: null
                    });
                }
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

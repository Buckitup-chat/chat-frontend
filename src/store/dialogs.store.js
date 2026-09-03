import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { getUserCardsCollection, getDialogCollections } from '@/lib/data/collections';
import { sendMutationsAndAwaitShape } from '@/lib/data/ingest';
import { nextOwnerTimestamp } from '@/lib/data/time';
import { computeTails } from '@/lib/data/refs';
import { createDialogGate } from '@/lib/data/dialogGate';
import { verifyMessageRow, verifySideRow } from '@/lib/pq/verifyDialogRow';
import { encodeContent, decodeContent, contentToText, ContentDecodeError } from '@/lib/pq/content';
import { prepareUpload, uploadFile, downloadFile } from '@/lib/data/fileTransfer';
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
        const signSkey = await getSignSkeyBytes();
        const mutation = api.createGenericMutation(relation, row, signSkey, mutationType);
        return sendMutationsAndAwaitShape([mutation], signSkey);
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

    /** Re-checks rows parked on absent author cards; call when user_cards sync. */
    const retryCardAdmissions = async () => {
        for (const gate of dialogGates.values()) await gate.retryAwaitingCards();
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

    // Optimistic reaction records the DESIRED end state and the deterministic
    // reaction_hash. Reconciliation matches server rows (including tombstones)
    // by hash — an un-react confirms as a tombstone, which carries no emoji,
    // so matching by emoji alone could never confirm removals.
    const addOptimisticReaction = (dialogHash, messageId, emoji, reactionHash, desiredActive) => {
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
        // Try to get my own keys from the dialog collection.
        // A preload FAILURE means "state unknown", not "row absent" — swallowing
        // it here used to trigger a key write on a mere read error. Let it
        // throw; the send path surfaces it as an error and retries later.
        const dialogColls = getDialogCollections(dialogHash);
        await dialogColls.keys.preload();
        const myKeyRow = dialogColls.keys.get(`${dialogHash}|${myHash}`);

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
                sender_hash: myHash,
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
            senderMsgKeys.value[`${dialogHash}_${myHash}`] = senderMsgKey;
        } else {
            // Already initialized, ensure it's in memory cache
            if (!senderMsgKeys.value[`${dialogHash}_${myHash}`]) {
                const em = EncryptionManagerPQ.getInstance();
                const keys = await em.exportVaultKeys();
                const signSkey = safeBase64Decode(keys.sign_skey, 'sign_skey');
                const kemSkey = safeBase64Decode(keys.crypt_skey, 'crypt_skey');
                
                const senderMsgKey = DialogCrypto.deriveSenderMsgKey(
                    signSkey, kemSkey, keys.evm_skey, peerHash
                );
                senderMsgKeys.value[`${dialogHash}_${myHash}`] = senderMsgKey;
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
    // `content` is a plain string (text message) or ContentPart[] — a reply
    // is [quotePart, textPart], per the composed-message convention.
    const sendMessage = async (peerHash, content, onStatus, messageId = null, ownerTimestamp = null) => {
        const parts = typeof content === 'string' ? [{ kind: 'text', text: content }] : content;
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

                // Canonical wire form (07_content_polymorphism.md): bare
                // string for text, array for composed — never the legacy
                // {"type":"text"} shape this client used to emit.
                const contentB64 = await DialogCrypto.encryptContent(myKey, encodeContent(parts));

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

        // The server-confirmed row (with its sign_hash) lives in the dialog
        // collection. A preload failure is "state unknown" — it must not be
        // collapsed into "message not found" (which would mislead the user
        // and could mask a mere connectivity blip as a missing message).
        const msgColl = getDialogCollections(dialogHash).messages;
        await msgColl.preload();
        const current = msgColl.get(messageId) || null;
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

    // ---------- file transport (§1.5, §2.1–2.3) ----------

    // §4.1: file_id + enc_secret persist BEFORE the first PUT — file_id alone
    // cannot resume, since a fresh secret would make re-sent chunks
    // undecryptable next to the ones already stored.
    const pendingUploadKey = (fileId) => `bkp:pending-upload:${fileId}`;

    /**
     * Uploads a file and sends the message referencing it. Progress is in
     * chunks (§2.1 — "куски, а не проценты-догадки"). Returns the fileId.
     */
    const sendFileMessage = async (peerHash, fileMeta, { caption = '', onProgress, onStatus, signal } = {}) => {
        const { name, mimeType, bytes, createdAt } = fileMeta;
        const uploaderHash = $userPQ.currentUserHash;
        const signSkey = await getSignSkeyBytes();

        const { v7 } = await import('uuid');
        const prepared = prepareUpload(v7());
        try {
            localStorage.setItem(pendingUploadKey(prepared.fileId), JSON.stringify({
                encSecretB64: prepared.encSecretB64, name, size: bytes.length,
            }));
        } catch { /* private mode: resume across reloads degrades, upload still works */ }

        onStatus?.('uploading');
        const up = await uploadFile({
            bytes, uploaderHash, signSkey, ...prepared, onProgress, signal,
        });

        const parts = [{
            kind: 'file',
            name,
            size: bytes.length,
            mimeType: mimeType || 'application/octet-stream',
            createdAt: createdAt || Math.floor(Date.now() / 1000),
            fileId: up.fileId,
            encSecretB64: up.encSecretB64,
        }];
        if (caption.trim()) parts.push({ kind: 'text', text: caption.trim() });

        await new Promise((resolve, reject) => {
            sendMessage(peerHash, parts, (status) => {
                onStatus?.(status);
                if (status === 'synced') resolve();
                if (status === 'error') reject(new Error('message send failed'));
            });
        });

        try { localStorage.removeItem(pendingUploadKey(up.fileId)); } catch { /* already best-effort */ }
        return up.fileId;
    };

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
        const myKey = await getSenderMsgKey(dialogHash, $userPQ.currentUserHash);

        const msgColl = getDialogCollections(dialogHash).messages;
        await msgColl.preload();
        const current = msgColl.get(messageId) || null;
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
            content_b64: '',
            deleted_flag: true,
            refs_map_b64: refsMapB64,
            parent_sign_hash: current.sign_hash,
            owner_timestamp: nextOwnerTimestamp(current.owner_timestamp),
        }, 'update');
    };

    /**
     * Decrypt a message row
     */
    const decryptMessageRow = async (row) => {
        try {
            const key = await getSenderMsgKey(row.dialog_hash, row.sender_hash);
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

    const runReactionWrite = async (reactionHash, ctx) => {
        const intent = reactionIntents.get(reactionHash);
        if (!intent || intent.written) return;
        intent.written = true;

        const { dialogHash, messageId, emoji, myKey, myHash } = ctx;
        const dialogColls = getDialogCollections(dialogHash);
        // Re-read after the barrier of the previous write: the row may now
        // exist (or have moved to another revision).
        const existing = dialogColls.reactions.get(reactionHash);

        const base = {
            reaction_hash: reactionHash,
            dialog_hash: dialogHash,
            message_id: messageId,
            // A reaction belongs to a specific message revision. Reacting on a
            // newer revision moves the row to it (product decision 2026-08-11).
            message_sign_hash: intent.messageSignHash,
            reactor_hash: myHash,
        };

        const typeB64 = intent.desiredActive ? await DialogCrypto.encryptContent(myKey, emoji) : '';
        const row = {
            ...base,
            type_b64: typeB64,
            deleted_flag: !intent.desiredActive,
            owner_timestamp: nextOwnerTimestamp(existing?.owner_timestamp ?? null),
        };

        // Existing row (even a tombstone, even on another revision) → update
        try {
            await pushRow('dialog_message_reactions', row, existing ? 'update' : 'insert');
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

        const dialogColls = getDialogCollections(dialogHash);
        const existing = dialogColls.reactions.get(reactionHash);
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
            () => updateOptimisticStatus(optimisticId, 'synced'),
            (e) => {
                console.error('[dialogs] toggleReaction failed:', e);
                if (e?.permanent) {
                    // The server will never accept this toggle — roll the
                    // optimistic state back so the UI stops showing an action
                    // that did not happen.
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
    const sendReadReceipt = async (peerHash, { messageId, messageSignHash }) => {
        if (!messageSignHash) {
            throw new Error('Cannot acknowledge: message revision is not synced yet');
        }

        const dialogHash = await initDialogKeys(peerHash);
        const myHash = $userPQ.currentUserHash;
        const type = 'read';

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
        editMessage,
        decryptMessageRow,
        deleteMessage,
        sendFileMessage,
        fetchFile,
        getMessageHistory,
        admitMessageRow,
        admitReactionRow,
        admitReceiptRow,
        retryCardAdmissions,
        toggleReaction,
        sendReadReceipt,
        isRevisionAcknowledged,
        decryptReactionRow,
        optimisticItems,
        addOptimisticMessage,
        addOptimisticMessageWithId,
        addOptimisticReaction,
        updateOptimisticStatus,
        removeOptimisticItem,
    };
});

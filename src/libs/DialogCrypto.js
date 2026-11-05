import { sha3_256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes } from '@noble/hashes/utils';
import {
    dialogHash,
    wrapSenderMsgKey,
    unwrapSenderMsgKey,
    encryptContent,
    decryptContent,
    reactionHash,
    receiptHash,
} from '@buckitup/pq-client/dialogs';

// The app's entry to the dialog cryptography of @buckitup/pq-client/dialogs.
export class DialogCrypto {
    /**
     * Compute dialog_hash from two user hashes
     * @param {string} userA
     * @param {string} userB
     * @returns {string} dialog_hash
     */
    static computeDialogHash(userA, userB) {
        return dialogHash(userA, userB);
    }

    /**
     * Helper to encode strings to Uint8Array
     */
    static strToBytes(str) {
        return new TextEncoder().encode(str);
    }

    /**
     * Derive the sender_msg_key using HKDF-SHA3-256
     */
    static deriveSenderMsgKey(signSkey, kemSkey, contactSkey, peerUserHash) {
        // Convert peer_user_hash string to bytes
        const peerHashBytes = this.strToBytes(peerUserHash);
        
        // IKM = sign_skey || kem_skey || contact_skey || peer_user_hash
        // Convert hex contactSkey to bytes if it's hex, or handle raw bytes
        const contactSkeyBytes = typeof contactSkey === 'string' ? hexToBytes(contactSkey) : contactSkey;
        
        const IKM = new Uint8Array(
            signSkey.length + kemSkey.length + contactSkeyBytes.length + peerHashBytes.length
        );
        IKM.set(signSkey, 0);
        IKM.set(kemSkey, signSkey.length);
        IKM.set(contactSkeyBytes, signSkey.length + kemSkey.length);
        IKM.set(peerHashBytes, signSkey.length + kemSkey.length + contactSkeyBytes.length);

        const salt = this.strToBytes("buckitup/dialog-mk/v1");

        // HKDF Extract
        const PRK = hmac(sha3_256, salt, IKM);
        
        // HKDF Expand (for 256 bits = 32 bytes)
        const info = new Uint8Array([...this.strToBytes("dialog-mk"), 0x01]);
        const senderMsgKey = hmac(sha3_256, PRK, info); // Exactly 32 bytes
        
        return senderMsgKey;
    }

    /**
     * Encap and wrap the sender_msg_key for the peer
     * @param {Uint8Array} senderMsgKey
     * @param {Uint8Array} peerCryptPkey
     * @returns {Promise<{ peerKemWrapKeyB64: string, peerWrappedMsgKeyB64: string }>}
     */
    static async wrapSenderMsgKey(senderMsgKey, peerCryptPkey) {
        const row = await wrapSenderMsgKey(senderMsgKey, peerCryptPkey);
        return { peerKemWrapKeyB64: row.peer_kem_wrap_key_b64, peerWrappedMsgKeyB64: row.peer_wrapped_msg_key_b64 };
    }

    /**
     * Decap and unwrap the sender_msg_key sent by peer
     * @param {Uint8Array} ownCryptSkey
     * @param {string} peerKemWrapKeyB64
     * @param {string} peerWrappedMsgKeyB64
     * @returns {Promise<Uint8Array>}
     */
    static unwrapSenderMsgKey(ownCryptSkey, peerKemWrapKeyB64, peerWrappedMsgKeyB64) {
        return unwrapSenderMsgKey(ownCryptSkey, peerKemWrapKeyB64, peerWrappedMsgKeyB64);
    }

    /**
     * Encrypt message content (AES-256-GCM)
     * @param {Uint8Array} senderMsgKey
     * @param {string} plaintextJson
     * @returns {Promise<string>} content_b64 (nonce || ciphertext)
     */
    static encryptContent(senderMsgKey, plaintextJson) {
        return encryptContent(senderMsgKey, plaintextJson);
    }

    /**
     * Decrypt message content (AES-256-GCM); "" for a deleted message
     * @param {Uint8Array} senderMsgKey
     * @param {string | null | undefined} contentB64Str
     * @returns {Promise<string>}
     */
    static decryptContent(senderMsgKey, contentB64Str) {
        return decryptContent(senderMsgKey, contentB64Str);
    }

    /**
     * Compute Reaction Hash (Keyed MAC)
     * @returns {string} reaction_hash
     */
    static computeReactionHash(senderMsgKey, messageId, reactorHash, typePlaintext) {
        return reactionHash(senderMsgKey, messageId, reactorHash, typePlaintext);
    }

    /**
     * Compute Receipt Hash
     * @returns {string} receipt_hash
     */
    static computeReceiptHash(messageId, messageSignHash, peerHash, type) {
        return receiptHash(messageId, messageSignHash, peerHash, type);
    }
}

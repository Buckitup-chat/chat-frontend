import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { sha3_256, sha3_512 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { randomBytes } from '@noble/post-quantum/utils.js';

import { arrayToBase64, decodeHexOrBase64 } from './enigma';

export interface WrappedSenderMsgKey {
    peerKemWrapKeyB64: string;
    peerWrappedMsgKeyB64: string;
}

export class DialogCrypto {
    /**
     * Compute dialog_hash from two user hashes
     * @param {string} userA
     * @param {string} userB
     * @returns {string} dialog_hash
     */
    static computeDialogHash(userA: string, userB: string): string {
        const sorted = [userA, userB].sort();
        const hash = sha3_512(this.strToBytes(sorted[0] + sorted[1]));
        return "di_" + bytesToHex(hash);
    }

    /**
     * Helper to encode strings to Uint8Array
     */
    static strToBytes(str: string): Uint8Array {
        return new TextEncoder().encode(str);
    }

    /**
     * Derive the sender_msg_key using HKDF-SHA3-256
     */
    static deriveSenderMsgKey(signSkey: Uint8Array, kemSkey: Uint8Array, contactSkey: string | Uint8Array, peerUserHash: string): Uint8Array {
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
     * @returns {Promise<{ peerKemWrapKey: Uint8Array, peerWrappedMsgKey: Uint8Array }>}
     */
    static async wrapSenderMsgKey(senderMsgKey: Uint8Array, peerCryptPkey: Uint8Array): Promise<WrappedSenderMsgKey> {
        // ML-KEM-1024 Encap
        const { cipherText: peerKemWrapKey, sharedSecret } = ml_kem1024.encapsulate(peerCryptPkey);

        // Derive wrap_key via HKDF-SHA3-256
        const salt = this.strToBytes("buckitup/dialog-wrap/v1");
        const PRK = hmac(sha3_256, salt, sharedSecret);
        const info = new Uint8Array([...this.strToBytes("wrap"), 0x01]);
        const wrapKey = hmac(sha3_256, PRK, info);

        // AES-256-GCM Encrypt
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const cryptoKey = await crypto.subtle.importKey(
            'raw', wrapKey, 'AES-GCM', false, ['encrypt']
        );

        const ciphertextBuf = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce },
            cryptoKey,
            senderMsgKey
        );

        const peerWrappedMsgKey = new Uint8Array(nonce.length + ciphertextBuf.byteLength);
        peerWrappedMsgKey.set(nonce, 0);
        peerWrappedMsgKey.set(new Uint8Array(ciphertextBuf), nonce.length);

        return {
            peerKemWrapKeyB64: arrayToBase64(peerKemWrapKey),
            peerWrappedMsgKeyB64: arrayToBase64(peerWrappedMsgKey)
        };
    }

    /**
     * Decap and unwrap the sender_msg_key sent by peer
     * @param {Uint8Array} ownCryptSkey
     * @param {string} peerKemWrapKeyB64
     * @param {string} peerWrappedMsgKeyB64
     * @returns {Promise<Uint8Array>}
     */
    static async unwrapSenderMsgKey(ownCryptSkey: Uint8Array, peerKemWrapKeyB64: string, peerWrappedMsgKeyB64: string): Promise<Uint8Array> {
        const peerKemWrapKey = decodeHexOrBase64(peerKemWrapKeyB64)!;
        const peerWrappedMsgKey = decodeHexOrBase64(peerWrappedMsgKeyB64)!;

        // ML-KEM-1024 Decap
        const sharedSecret = ml_kem1024.decapsulate(peerKemWrapKey, ownCryptSkey);

        // Derive wrap_key via HKDF-SHA3-256
        const salt = this.strToBytes("buckitup/dialog-wrap/v1");
        const PRK = hmac(sha3_256, salt, sharedSecret);
        const info = new Uint8Array([...this.strToBytes("wrap"), 0x01]);
        const wrapKey = hmac(sha3_256, PRK, info);

        // AES-256-GCM Decrypt
        const nonce = peerWrappedMsgKey.slice(0, 12);
        const ciphertext = peerWrappedMsgKey.slice(12);

        const cryptoKey = await crypto.subtle.importKey(
            'raw', wrapKey, 'AES-GCM', false, ['decrypt']
        );

        const plaintextBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonce },
            cryptoKey,
            ciphertext
        );

        return new Uint8Array(plaintextBuf);
    }

    /**
     * Encrypt message content (AES-256-GCM)
     * @param {Uint8Array} senderMsgKey
     * @param {string} plaintextJson
     * @returns {Promise<Uint8Array>} content_b64 (nonce || ciphertext)
     */
    static async encryptContent(senderMsgKey: Uint8Array, plaintextJson: string): Promise<string> {
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const cryptoKey = await crypto.subtle.importKey(
            'raw', senderMsgKey, 'AES-GCM', false, ['encrypt']
        );
        const ciphertextBuf = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce },
            cryptoKey,
            this.strToBytes(plaintextJson)
        );
        const contentB64 = new Uint8Array(nonce.length + ciphertextBuf.byteLength);
        contentB64.set(nonce, 0);
        contentB64.set(new Uint8Array(ciphertextBuf), nonce.length);
        return arrayToBase64(contentB64);
    }

    /**
     * Decrypt message content (AES-256-GCM)
     * @param {Uint8Array} senderMsgKey 
     * @param {Uint8Array} contentB64 
     * @returns {Promise<string>}
     */
    static async decryptContent(senderMsgKey: Uint8Array, contentB64Str: string): Promise<string> {
        if (!contentB64Str || contentB64Str.length === 0) return ""; // Deleted flag handling
        
        const contentB64 = decodeHexOrBase64(contentB64Str);
        if (!contentB64) return "";

        const nonce = contentB64.slice(0, 12);
        const ciphertext = contentB64.slice(12);
        const cryptoKey = await crypto.subtle.importKey(
            'raw', senderMsgKey, 'AES-GCM', false, ['decrypt']
        );
        const plaintextBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonce },
            cryptoKey,
            ciphertext
        );
        return new TextDecoder().decode(plaintextBuf);
    }

    /**
     * Compute Reaction Hash (Keyed MAC)
     * @param {Uint8Array} senderMsgKey 
     * @param {string} messageId 
     * @param {string} reactorHash 
     * @param {string} typePlaintext 
     * @returns {string} reaction_hash
     */
    static computeReactionHash(senderMsgKey: Uint8Array, messageId: string, reactorHash: string, typePlaintext: string): string {
        const msgIdBytes = this.strToBytes(messageId);
        const reactorHashBytes = this.strToBytes(reactorHash);
        const typePlaintextBytes = this.strToBytes(typePlaintext);

        const data = new Uint8Array(msgIdBytes.length + reactorHashBytes.length + typePlaintextBytes.length);
        data.set(msgIdBytes, 0);
        data.set(reactorHashBytes, msgIdBytes.length);
        data.set(typePlaintextBytes, msgIdBytes.length + reactorHashBytes.length);

        // HMAC-SHA3-512
        const mac = hmac(sha3_512, senderMsgKey, data);
        return "dmr_" + bytesToHex(mac);
    }

    /**
     * Compute Receipt Hash
     * @param {string} messageId 
     * @param {string} messageSignHash 
     * @param {string} peerHash 
     * @param {string} type 
     * @returns {string} receipt_hash
     */
    static computeReceiptHash(messageId: string, messageSignHash: string, peerHash: string, type: string): string {
        const dataStr = `${messageId}${messageSignHash}${peerHash}${type}`;
        const hash = sha3_512(this.strToBytes(dataStr));
        return "dmrc_" + bytesToHex(hash);
    }
}

// The cryptography of a two-person dialog (chat/docs/pq/reqs/pq_dialogs.done.md):
// the dialog's hash, each author's message key, its wrapping for the peer,
// message content, and the keyed hashes of reactions and receipts.
//
// Every author has one sender_msg_key per peer, derived from its own secret
// keys, so any device holding them derives the same key. The peer gets it
// wrapped under ML-KEM-1024 in the author's dialog_keys row.
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex } from '@noble/hashes/utils';
import { openAesGcm as open, sealAesGcm as seal } from './aesGcm.js';
import { hkdfDerive } from './hkdf.js';
import { toBase64, toBytes } from './signature.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

const concat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

/**
 * A binary column as it arrives: base64 with or without padding (rows written
 * and rows read from a shape), or PostgreSQL's `\x` hex.
 */
export const decodeColumn = (value: string): Uint8Array => toBytes(value);

/** `di_` + hex(SHA3-512(the two user hashes, sorted, concatenated as UTF-8)). */
export const dialogHash = (userA: string, userB: string): string => {
	const [first, second] = [userA, userB].sort();
	return 'di_' + bytesToHex(sha3_512(utf8(first + second)));
};

/**
 * An author's key for every message it writes to `peerHash`:
 * HKDF-SHA3-256(sign_skey || crypt_skey || peer_user_hash), salt
 * "buckitup/dialog-mk/v1", info "dialog-mk", 32 bytes. Post-quantum keys only.
 */
export const deriveSenderMsgKey = (signSkey: Uint8Array, cryptSkey: Uint8Array, peerHash: string): Uint8Array =>
	hkdfDerive(concat(signSkey, cryptSkey, utf8(peerHash)), 'buckitup/dialog-mk/v1', 'dialog-mk', 32);

const wrapKeyOf = (sharedSecret: Uint8Array) => hkdfDerive(sharedSecret, 'buckitup/dialog-wrap/v1', 'wrap', 32);

/**
 * The two dialog_keys columns that carry `senderMsgKey` to the peer:
 * an ML-KEM-1024 encapsulation to its crypt_pkey, and the key sealed under a
 * wrap key derived from the shared secret. Padded base64, as rows are written.
 */
export const wrapSenderMsgKey = async (
	senderMsgKey: Uint8Array,
	peerCryptPkey: Uint8Array,
): Promise<{ peer_kem_wrap_key_b64: string; peer_wrapped_msg_key_b64: string }> => {
	const { cipherText, sharedSecret } = ml_kem1024.encapsulate(peerCryptPkey);
	return {
		peer_kem_wrap_key_b64: toBase64(cipherText),
		peer_wrapped_msg_key_b64: toBase64(await seal(wrapKeyOf(sharedSecret), senderMsgKey)),
	};
};

/** The peer's sender_msg_key out of its dialog_keys row, with this identity's crypt_skey. */
export const unwrapSenderMsgKey = async (
	ownCryptSkey: Uint8Array,
	peerKemWrapKey: string,
	peerWrappedMsgKey: string,
): Promise<Uint8Array> => {
	const sharedSecret = ml_kem1024.decapsulate(decodeColumn(peerKemWrapKey), ownCryptSkey);
	return open(wrapKeyOf(sharedSecret), decodeColumn(peerWrappedMsgKey));
};

/** A message's content_b64: the JSON content sealed under the author's sender_msg_key. */
export const encryptContent = async (senderMsgKey: Uint8Array, plaintext: string): Promise<string> =>
	toBase64(await seal(senderMsgKey, utf8(plaintext)));

/** The JSON content of a message; "" for a deleted one, whose content_b64 is empty. */
export const decryptContent = async (senderMsgKey: Uint8Array, contentB64: string | null | undefined): Promise<string> => {
	if (!contentB64) return '';
	return new TextDecoder().decode(await open(senderMsgKey, decodeColumn(contentB64)));
};

/**
 * `dmr_` + hex(HMAC-SHA3-512(sender_msg_key, message_id || reactor_hash || type)):
 * keyed, so an observer cannot test guesses of the reaction type.
 */
export const reactionHash = (senderMsgKey: Uint8Array, messageId: string, reactorHash: string, type: string): string =>
	'dmr_' + bytesToHex(hmac(sha3_512, senderMsgKey, utf8(messageId + reactorHash + type)));

/** `dmrc_` + hex(SHA3-512(message_id || message_sign_hash || peer_hash || type)). */
export const receiptHash = (messageId: string, messageSignHash: string, peerHash: string, type: string): string =>
	'dmrc_' + bytesToHex(sha3_512(utf8(`${messageId}${messageSignHash}${peerHash}${type}`)));

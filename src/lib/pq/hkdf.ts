// HKDF-SHA3-256 (RFC 5869), the PQ layer's only key-derivation primitive.
//
// invariants/09_symmetric_keys.md: raw hash output must never be used as a key
// directly — every symmetric key comes from extract-then-expand with a
// domain-separating salt, so two key families can never collide. WebCrypto has
// no SHA3, so this is HMAC-SHA3-256 by hand: two calls for a 32-byte output.
//
// The dialog key derivation in DialogCrypto.deriveSenderMsgKey predates this
// module and still inlines the same two HMAC calls.

import { hmac } from '@noble/hashes/hmac';
import { sha3_256 } from '@noble/hashes/sha3';

const utf8 = (s: string) => new TextEncoder().encode(s);

const asBytes = (v: string | Uint8Array) => (typeof v === 'string' ? utf8(v) : v);

/** HKDF-Extract: concentrates input keying material into a 32-byte PRK. */
export const hkdfExtract = (ikm: Uint8Array, salt: string | Uint8Array): Uint8Array =>
	hmac(sha3_256, asBytes(salt), ikm);

/** HKDF-Expand: iterative HMAC with a counter byte, truncated to `length`. */
export const hkdfExpand = (prk: Uint8Array, info: string | Uint8Array, length = 32): Uint8Array => {
	const infoBytes = asBytes(info);
	const out = new Uint8Array(length);
	let prev = new Uint8Array(0);
	let filled = 0;
	for (let i = 1; filled < length; i++) {
		const block = new Uint8Array(prev.length + infoBytes.length + 1);
		block.set(prev, 0);
		block.set(infoBytes, prev.length);
		block[prev.length + infoBytes.length] = i;
		prev = hmac(sha3_256, prk, block);
		out.set(prev.subarray(0, Math.min(prev.length, length - filled)), filled);
		filled += prev.length;
	}
	return out;
};

/**
 * Extract-then-expand. `salt` separates key families ("buckitup/dialog-mk/v1",
 * "buckitup/user-storage-root/v1", …); `info` separates uses within a family.
 */
export const hkdfDerive = (
	ikm: Uint8Array,
	salt: string | Uint8Array,
	info: string | Uint8Array,
	length = 32,
): Uint8Array => hkdfExpand(hkdfExtract(ikm, salt), info, length);

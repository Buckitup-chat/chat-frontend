// The PQ2 optical handshake, as pure functions (docs/task-handshake-pq2.md
// §3–§4): the four QR messages, the transcript, the optical and post-quantum
// signatures, the six-digit comparison code and the check of the message the
// peer sends over the channel. No DOM, no camera, no WebRTC — the engine
// drives these, and the tests run them under node.
//
// The card format, its verification and HKDF are the application's own
// (src/lib/pq/*), so what this sandbox confirms is what the app would.
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, randomBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { base64urlDecode, base64urlEncode } from 'qwbp';
import { hkdfDerive } from '@/lib/pq/hkdf';
import { cardVouchesForContactKey, verifyUserCard } from '@/lib/pq/verifyCard';
import { toBase64, toBytes } from '@/lib/pq/signature';
import type { UserCardRow } from '@/lib/data/types';

export const PREFIX = 'PQ2';
export const TRANSCRIPT_TAG = 'buckitup/handshake/v2\n';
export const PQ_TAG = 'buckitup/handshake/v2/pq\n';
export const SAS_SALT = 'buckitup/handshake/v2';

export const CONTACT_PKEY_BYTES = 33; // compressed secp256k1
export const NONCE_BYTES = 16;
export const SIG_BYTES = 64; // compact r‖s
export const FINGERPRINT_BYTES = 32;
const MAX_QWBP_BYTES = 512;

/** One side of a session, as the codes show it. */
export interface Party {
	userHash: string;
	contactPkey: Uint8Array;
	nonce: Uint8Array;
}

export type Message =
	| { kind: 'A'; userHash: string; contactPkey: Uint8Array; nonce: Uint8Array }
	| { kind: 'B'; userHash: string; contactPkey: Uint8Array; nonce: Uint8Array; sig: Uint8Array }
	| { kind: 'C'; sig: Uint8Array; qwbp: Uint8Array }
	| { kind: 'D'; qwbp: Uint8Array };

const b64 = base64urlEncode;
const utf8 = (s: string) => new TextEncoder().encode(s);

export const newNonce = (): Uint8Array => randomBytes(NONCE_BYTES);

// ---------- messages (§3) ----------

export const encode = (m: Message): string => {
	switch (m.kind) {
		case 'A':
			return [PREFIX, 'A', m.userHash, b64(m.contactPkey), b64(m.nonce)].join(':');
		case 'B':
			return [PREFIX, 'B', m.userHash, b64(m.contactPkey), b64(m.nonce), b64(m.sig)].join(':');
		case 'C':
			return [PREFIX, 'C', b64(m.sig), b64(m.qwbp)].join(':');
		case 'D':
			return [PREFIX, 'D', b64(m.qwbp)].join(':');
	}
};

const isUserHash = (s: string) => /^u_[0-9a-f]{128}$/.test(s);

/** The bytes of an unpadded base64url field; the decoder alone would also take `+`, `/`, `=` and spaces. */
const decoded = (s: string, min: number, max: number): Uint8Array | null => {
	try {
		const out = base64urlDecode(s);
		return out.length >= min && out.length <= max && b64(out) === s ? out : null;
	} catch {
		return null;
	}
};
const fixed = (s: string, bytes: number) => decoded(s, bytes, bytes);
const variable = (s: string, max: number) => decoded(s, 1, max);

/** A code this protocol can act on, or null: another protocol, a wrong field count or length. */
export const parse = (text: string): Message | null => {
	const parts = text.trim().split(':');
	if (parts[0] !== PREFIX) return null;
	const [, kind, ...f] = parts;
	if (kind === 'A' && f.length === 3 && isUserHash(f[0])) {
		const contactPkey = fixed(f[1], CONTACT_PKEY_BYTES);
		const nonce = fixed(f[2], NONCE_BYTES);
		return contactPkey && nonce ? { kind, userHash: f[0], contactPkey, nonce } : null;
	}
	if (kind === 'B' && f.length === 4 && isUserHash(f[0])) {
		const contactPkey = fixed(f[1], CONTACT_PKEY_BYTES);
		const nonce = fixed(f[2], NONCE_BYTES);
		const sig = fixed(f[3], SIG_BYTES);
		return contactPkey && nonce && sig ? { kind, userHash: f[0], contactPkey, nonce, sig } : null;
	}
	if (kind === 'C' && f.length === 2) {
		const sig = fixed(f[0], SIG_BYTES);
		const qwbp = variable(f[1], MAX_QWBP_BYTES);
		return sig && qwbp ? { kind, sig, qwbp } : null;
	}
	if (kind === 'D' && f.length === 1) {
		const qwbp = variable(f[0], MAX_QWBP_BYTES);
		return qwbp ? { kind, qwbp } : null;
	}
	return null;
};

// ---------- transcript and derived values (§4) ----------

/** The two parties ordered by user_hash. Equal hashes are never a session. */
export const order = <T extends { userHash: string }>(a: T, b: T): [T, T] => {
	if (a.userHash === b.userHash) throw new Error('A party cannot handshake with itself');
	return a.userHash < b.userHash ? [a, b] : [b, a];
};

const assertLengths = (p: Party) => {
	if (!isUserHash(p.userHash)) throw new Error('user_hash has the wrong form');
	if (p.contactPkey.length !== CONTACT_PKEY_BYTES) throw new Error('contact key has the wrong length');
	if (p.nonce.length !== NONCE_BYTES) throw new Error('nonce has the wrong length');
};

/** T: the same bytes on both sides, whichever of them computes it. */
export const transcript = (a: Party, b: Party): Uint8Array => {
	assertLengths(a);
	assertLengths(b);
	const [lo, hi] = order(a, b);
	return concatBytes(
		utf8(TRANSCRIPT_TAG),
		utf8(lo.userHash), lo.contactPkey, lo.nonce,
		utf8(hi.userHash), hi.contactPkey, hi.nonce,
	);
};

/** Each party's transport fingerprint, in transcript order. */
export interface Fingerprints {
	[userHash: string]: Uint8Array;
}

const fingerprintsInOrder = (T: Uint8Array, a: string, b: string, fps: Fingerprints): Uint8Array => {
	const [lo, hi] = order({ userHash: a }, { userHash: b });
	const fpLo = fps[lo.userHash];
	const fpHi = fps[hi.userHash];
	if (fpLo?.length !== FINGERPRINT_BYTES || fpHi?.length !== FINGERPRINT_BYTES) {
		throw new Error('both transport fingerprints are needed');
	}
	return concatBytes(T, fpLo, fpHi);
};

/** M: what the post-quantum signature covers — the transcript bound to the channel. */
export const pqMessage = (T: Uint8Array, a: string, b: string, fps: Fingerprints): Uint8Array =>
	concatBytes(utf8(PQ_TAG), fingerprintsInOrder(T, a, b, fps));

/** Four bytes as a big-endian number, mod 10^6, zero-padded: the six digits a screen shows. */
export const sixDigits = (out: Uint8Array): string => {
	const n = ((out[0] << 24) >>> 0) + (out[1] << 16) + (out[2] << 8) + out[3];
	return String(n % 1_000_000).padStart(6, '0');
};

/** The six digits both screens show; they cover the fingerprints, so a swapped channel changes them. */
export const comparisonCode = (T: Uint8Array, a: string, b: string, fps: Fingerprints): string =>
	sixDigits(hkdfDerive(fingerprintsInOrder(T, a, b, fps), SAS_SALT, 'sas', 4));

// ---------- signatures ----------

/** The optical proof: ECDSA secp256k1 over SHA-256(T), compact r‖s. */
export const signOptical = async (T: Uint8Array, contactSkey: Uint8Array): Promise<Uint8Array> =>
	(await secp.signAsync(sha256(T), contactSkey)).toCompactRawBytes();

export const verifyOptical = (sig: Uint8Array, T: Uint8Array, contactPkey: Uint8Array): boolean => {
	try {
		return secp.verify(sig, sha256(T), contactPkey);
	} catch {
		return false;
	}
};

export const signPq = (M: Uint8Array, signSkey: Uint8Array): Uint8Array => ml_dsa87.sign(M, signSkey);

// ---------- the message over the channel (§5 step 6) ----------

export interface ConfirmMessage {
	type: 'PQ2_CONFIRM';
	card: UserCardRow;
	sig: string; // base64 ML-DSA-87 over M
}

export const confirmMessage = (card: UserCardRow, sigPq: Uint8Array): string =>
	JSON.stringify({ type: 'PQ2_CONFIRM', card, sig: toBase64(sigPq) } satisfies ConfirmMessage);

export type ConfirmVerdict =
	| { ok: true; card: UserCardRow }
	| { ok: false; reason: string };

/**
 * The peer is confirmed when its card is the identity the codes showed, is
 * valid and certifies the contact key the optical proof used, and its
 * identity key signed M. A confirmation verifies the card once; only a
 * refusal verifies it again, to name the reason.
 */
export const checkConfirm = (
	raw: string,
	bound: { userHash: string; contactPkey: Uint8Array },
	M: Uint8Array,
): ConfirmVerdict => {
	let msg: ConfirmMessage;
	try {
		msg = JSON.parse(raw);
	} catch {
		return { ok: false, reason: 'the message is not JSON' };
	}
	if (msg?.type !== 'PQ2_CONFIRM' || !msg.card || typeof msg.sig !== 'string') {
		return { ok: false, reason: 'not a PQ2_CONFIRM message' };
	}
	const card = msg.card;
	if (card.user_hash !== bound.userHash) return { ok: false, reason: 'card is another identity than the codes showed' };
	if (!cardVouchesForContactKey(card, toBase64(bound.contactPkey))) {
		const verdict = verifyUserCard(card);
		return {
			ok: false,
			reason: verdict.status === 'verified' ? 'card does not certify the contact key the codes showed' : `card does not verify (${verdict.reason})`,
		};
	}
	let sig: Uint8Array;
	try {
		sig = toBytes(msg.sig);
	} catch {
		return { ok: false, reason: 'signature is not base64' };
	}
	// A verified card has its sign_pkey.
	if (!ml_dsa87.verify(sig, M, toBytes(card.sign_pkey!))) {
		return { ok: false, reason: 'post-quantum signature does not verify' };
	}
	return { ok: true, card };
};

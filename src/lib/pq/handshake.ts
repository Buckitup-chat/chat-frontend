// The optical handshake v2 (PQ2), as pure functions (docs/task-handshake-pq2.md
// §3–§4): the four QR messages, the transcript, the optical and post-quantum
// signatures, the six-digit SAS and the check of the message the peer sends
// over the data channel. No DOM, no camera, no WebRTC: the engine
// (src/lib/handshake/engine.ts) drives these, and the tests run them under
// node.
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, randomBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { base64urlDecode, decode as decodeQwbp } from 'qwbp';
import { hkdfDerive, sixDigits } from './hkdf';
import { contactKeyVouch, type ContactKeyVouch } from './verifyCard';
import { toBase64, toBase64Url, toBytes } from './signature';
import type { UserCardRow } from '@/lib/data/types';

export const PREFIX = 'PQ2';
export const TRANSCRIPT_TAG = 'buckitup/handshake/v2\n';
export const PQ_TAG = 'buckitup/handshake/v2/pq\n';
export const SAS_SALT = 'buckitup/handshake/v2';
export const CONFIRM_TYPE = 'PQ2_CONFIRM';
export const REFUSAL_TYPE = 'PQ2_REFUSE';

export const USER_HASH_CHARS = 130;
export const CONTACT_PKEY_BYTES = 33; // compressed secp256k1
export const NONCE_BYTES = 16;
export const SIG_BYTES = 64; // compact r‖s
export const FINGERPRINT_BYTES = 32;
export const SESSION_TAG_BYTES = 6;
/** A QWBP payload: 34 bytes plus at most six addresses of 19 bytes, with room to spare. */
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
	| { kind: 'D'; tag: Uint8Array; qwbp: Uint8Array };

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = toBase64Url;

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
			return [PREFIX, 'D', b64(m.tag), b64(m.qwbp)].join(':');
	}
};

export const isUserHash = (s: string): boolean => /^u_[0-9a-f]{128}$/.test(s);

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
	if (kind === 'D' && f.length === 2) {
		const tag = fixed(f[0], SESSION_TAG_BYTES);
		const qwbp = variable(f[1], MAX_QWBP_BYTES);
		return tag && qwbp ? { kind, tag, qwbp } : null;
	}
	return null;
};

// ---------- the transcript and what derives from it (§4) ----------

/** The two parties ordered by user_hash. Equal hashes are never a session. */
export const order = <P extends { userHash: string }>(a: P, b: P): [P, P] => {
	if (a.userHash === b.userHash) throw new Error('A party cannot handshake with itself');
	return a.userHash < b.userHash ? [a, b] : [b, a];
};

const assertLengths = (p: Party) => {
	if (!isUserHash(p.userHash)) throw new Error('user_hash has the wrong form');
	if (p.contactPkey.length !== CONTACT_PKEY_BYTES) throw new Error('contact key has the wrong length');
	if (p.nonce.length !== NONCE_BYTES) throw new Error('nonce has the wrong length');
};

const PARTY_BYTES = USER_HASH_CHARS + CONTACT_PKEY_BYTES + NONCE_BYTES;
const TRANSCRIPT_BYTES = TRANSCRIPT_TAG.length + 2 * PARTY_BYTES;

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

/** The user_hash of each party in T, in transcript order: fixed offsets, as every field is fixed-length. */
const partiesOf = (T: Uint8Array): [string, string] => {
	if (T.length !== TRANSCRIPT_BYTES) throw new Error('not a transcript');
	const at = (offset: number) => new TextDecoder().decode(T.subarray(offset, offset + USER_HASH_CHARS));
	return [at(TRANSCRIPT_TAG.length), at(TRANSCRIPT_TAG.length + PARTY_BYTES)];
};

/** What D carries to name its session: D has no signature, so without it a neighbour's D would be fed to the connection. */
export const sessionTag = (T: Uint8Array): Uint8Array => sha256(T).slice(0, SESSION_TAG_BYTES);

/** Each party's DTLS certificate fingerprint, by user_hash. */
export type Fingerprints = Record<string, Uint8Array>;

/** The transport fingerprint a QWBP payload carries, by QWBP's own parser. */
export const fingerprintOf = (qwbpPayload: Uint8Array): Uint8Array => decodeQwbp(qwbpPayload).fingerprint;

/** T ‖ fp_lo ‖ fp_hi. */
const boundToChannel = (T: Uint8Array, fps: Fingerprints): Uint8Array => {
	const [lo, hi] = partiesOf(T);
	const fpLo = fps[lo];
	const fpHi = fps[hi];
	if (fpLo?.length !== FINGERPRINT_BYTES || fpHi?.length !== FINGERPRINT_BYTES) {
		throw new Error('both transport fingerprints are needed');
	}
	return concatBytes(T, fpLo, fpHi);
};

/** M: what the post-quantum signature covers — the transcript bound to the channel. */
export const pqMessage = (T: Uint8Array, fps: Fingerprints): Uint8Array =>
	concatBytes(utf8(PQ_TAG), boundToChannel(T, fps));

/** The six digits both screens show. They cover the fingerprints, so a swapped channel changes them. */
export const sasOf = (T: Uint8Array, fps: Fingerprints): string =>
	sixDigits(hkdfDerive(boundToChannel(T, fps), SAS_SALT, 'sas', 4));

// ---------- the optical signature ----------

/** ECDSA secp256k1 over SHA-256(T), compact r‖s: what EncryptionManagerPQ.signContactChallenge(T) makes with the account's key. */
export const signOptical = async (T: Uint8Array, contactSkey: Uint8Array): Promise<Uint8Array> =>
	(await secp.signAsync(sha256(T), contactSkey)).toCompactRawBytes();

/** Verifies `sig` (compact r‖s) over SHA-256(T) under a compressed secp256k1 key. */
export const verifyOptical = (sig: Uint8Array, T: Uint8Array, contactPkey: Uint8Array): boolean => {
	try {
		return secp.verify(sig, sha256(T), contactPkey);
	} catch {
		return false;
	}
};

// ---------- the message over the channel (§5 step 6) ----------

export interface ConfirmMessage {
	type: typeof CONFIRM_TYPE;
	card: UserCardRow;
	/** Padded base64 ML-DSA-87 over M. */
	sig: string;
}

export const confirmMessage = (card: UserCardRow, sigPq: Uint8Array): string =>
	JSON.stringify({ type: CONFIRM_TYPE, card, sig: toBase64(sigPq) } satisfies ConfirmMessage);

/**
 * What a side sends instead of its confirmation when it cannot make one — it
 * has no published card, or could not sign — so that the other phone names the
 * real cause rather than a missing channel.
 */
export interface RefusalMessage {
	type: typeof REFUSAL_TYPE;
	cause: RefusalCause;
}

export type RefusalCause = 'no-card' | 'no-signature';

export const refusalMessage = (cause: RefusalCause): string =>
	JSON.stringify({ type: REFUSAL_TYPE, cause } satisfies RefusalMessage);

/**
 * Why the peer is not confirmed: `refused`, its card or signature does not
 * hold; `deleted`, its card is a deleted account's; `peer-unable`, it sent a
 * refusal (no card, or it could not sign).
 */
export type ConfirmRefusal = 'refused' | 'deleted' | 'peer-unable';

export type ConfirmVerdict =
	| { ok: true; card: UserCardRow }
	| { ok: false; reason: string; refusal: ConfirmRefusal };

const CARD_REFUSAL: Record<Exclude<ContactKeyVouch, { ok: true }>['why'], string> = {
	'no-card': 'no card',
	'another-identity': 'the card is another identity than the codes showed',
	deleted: 'the card is a deleted account\'s',
	'another-key': 'the card does not certify the contact key the codes showed',
	invalid: 'the card does not verify',
};

/**
 * The peer is confirmed when its card is the live identity the codes showed,
 * verifies, and certifies the contact key the optical proof used, and its
 * identity key signed M. The card is verified once (contactKeyVouch).
 */
export const checkConfirm = (
	raw: string,
	bound: { userHash: string; contactPkey: Uint8Array },
	T: Uint8Array,
	fps: Fingerprints,
): ConfirmVerdict => {
	const refused = (reason: string, refusal: ConfirmRefusal = 'refused'): ConfirmVerdict => ({ ok: false, reason, refusal });
	let msg: ConfirmMessage | RefusalMessage;
	try {
		msg = JSON.parse(raw);
	} catch {
		return refused('the message is not JSON');
	}
	if (msg?.type === REFUSAL_TYPE) {
		const cause = (msg as RefusalMessage).cause;
		return refused(`the other phone could not confirm itself (${cause === 'no-card' ? 'no card' : 'no signature'})`, 'peer-unable');
	}
	if (msg?.type !== CONFIRM_TYPE || !msg.card || typeof msg.card !== 'object' || typeof msg.sig !== 'string') {
		return refused('not a confirmation message');
	}
	const card = msg.card;
	const vouch = contactKeyVouch(card, bound.userHash, toBase64(bound.contactPkey));
	if (!vouch.ok) {
		const reason = vouch.why === 'invalid' ? `${CARD_REFUSAL.invalid} (${vouch.reason})` : CARD_REFUSAL[vouch.why];
		return refused(reason, vouch.why === 'deleted' ? 'deleted' : 'refused');
	}
	let valid = false;
	try {
		// A verified card has its sign_pkey.
		valid = ml_dsa87.verify(toBytes(msg.sig), pqMessage(T, fps), toBytes(card.sign_pkey!));
	} catch {
		valid = false;
	}
	if (!valid) return refused('the post-quantum signature does not verify');
	return { ok: true, card };
};

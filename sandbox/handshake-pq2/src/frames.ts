// The animated-QR variant of the PQ2 confirmation — an experiment, not in the
// spec. When the phones share no network, the post-quantum proof goes through
// the cameras as a loop of QR frames instead of over a WebRTC channel.
//
// A device sends the smallest proof that confirms it: its optical signature,
// its identity key, and an ML-DSA-87 signature over the transcript and its
// name — about 7.3 KB, where the network channel carries the whole card,
// about 30 KB. The transcript holds the contact key the codes showed, so the
// identity's signature over it ties that key to the identity for this session,
// as the card's certificate does for good.
//
// Frames are text in QR alphanumeric mode (digits, capitals, space and
// $%*+-./:), which packs 5.5 bits a character against 8 in byte mode: the
// proof travels in base45 (RFC 9285).
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { hkdfDerive } from '@/lib/pq/hkdf';
import { SAS_SALT, SIG_BYTES, sixDigits, verifyOptical } from './protocol';

export const PROOF_TAG = 'buckitup/handshake/v2/pq-qr\n';
export const FRAME_PREFIX = 'PQ2:F:';
const PROOF_VERSION = 1;
const SIGN_PKEY_BYTES = 2592;
const PQ_SIG_BYTES = 4627;
export const MAX_NAME_BYTES = 64;
const MAX_FRAMES = 999;

/** Base45 characters a frame carries, by frame size; the header takes about 20 more. */
export const FRAME_DATA_CHARS = { small: 228, medium: 438, large: 718 } as const;
export type FrameSize = keyof typeof FRAME_DATA_CHARS;

const utf8 = (s: string) => new TextEncoder().encode(s);

// ---------- base45 (RFC 9285) ----------

const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export const toBase45 = (bytes: Uint8Array): string => {
	let out = '';
	for (let i = 0; i + 1 < bytes.length; i += 2) {
		const n = bytes[i] * 256 + bytes[i + 1];
		out += B45[n % 45] + B45[Math.floor(n / 45) % 45] + B45[Math.floor(n / 2025)];
	}
	if (bytes.length % 2) {
		const n = bytes[bytes.length - 1];
		out += B45[n % 45] + B45[Math.floor(n / 45)];
	}
	return out;
};

export const fromBase45 = (text: string): Uint8Array | null => {
	const out: number[] = [];
	for (let i = 0; i < text.length; i += 3) {
		const digits = [...text.slice(i, i + 3)].map((c) => B45.indexOf(c));
		if (digits.length === 1 || digits.some((d) => d < 0)) return null;
		const n = digits[0] + digits[1] * 45 + (digits[2] ?? 0) * 2025;
		if (digits.length === 3) {
			if (n > 0xffff) return null;
			out.push(n >> 8, n & 0xff);
		} else {
			if (n > 0xff) return null;
			out.push(n);
		}
	}
	return Uint8Array.from(out);
};

// ---------- frames ----------

export interface Frame {
	/** The sender's session: the first three bytes of its nonce, in capital hex. */
	sender: string;
	index: number;
	total: number;
	/** How many of the other device's frames the sender holds. */
	received: number;
	data: string;
}

export const senderTag = (nonce: Uint8Array): string => bytesToHex(nonce.slice(0, 3)).toUpperCase();

export const encodeFrame = (f: Frame): string => `${FRAME_PREFIX}${[f.sender, f.index, f.total, f.received, f.data].join(':')}`;

export const parseFrame = (text: string): Frame | null => {
	if (!text.startsWith(FRAME_PREFIX)) return null;
	// The data is last and may itself hold ':'.
	const [sender, index, total, received, ...data] = text.slice(FRAME_PREFIX.length).split(':');
	if (!/^[0-9A-F]{6}$/.test(sender ?? '') || ![index, total, received].every((v) => /^\d{1,3}$/.test(v ?? ''))) return null;
	const f = { sender, index: Number(index), total: Number(total), received: Number(received), data: data.join(':') };
	return f.total > 0 && f.total <= MAX_FRAMES && f.index < f.total && f.received <= MAX_FRAMES && f.data ? f : null;
};

/** `text` in pieces of `size` characters. */
export const split = (text: string, size: number): string[] =>
	Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

// ---------- the proof ----------

export interface FrameProof {
	opticalSig: Uint8Array;
	signPkey: Uint8Array;
	pqSig: Uint8Array;
	/** UTF-8, at most MAX_NAME_BYTES, as signed. */
	nameBytes: Uint8Array;
}

/** The name as a device signs and sends it: its first MAX_NAME_BYTES bytes. */
export const nameBytesOf = (name: string): Uint8Array => utf8(name).slice(0, MAX_NAME_BYTES);

/** What the identity key signs: the transcript and the sender's name, under a label of this variant. */
export const proofMessage = (T: Uint8Array, nameBytes: Uint8Array): Uint8Array => concatBytes(utf8(PROOF_TAG), T, nameBytes);

export const encodeProof = (p: FrameProof): Uint8Array =>
	concatBytes(Uint8Array.of(PROOF_VERSION), p.opticalSig, p.signPkey, p.pqSig, p.nameBytes);

export const decodeProof = (bytes: Uint8Array): FrameProof | null => {
	const fixed = 1 + SIG_BYTES + SIGN_PKEY_BYTES + PQ_SIG_BYTES;
	if (bytes[0] !== PROOF_VERSION || bytes.length < fixed || bytes.length > fixed + MAX_NAME_BYTES) return null;
	let at = 1;
	const take = (n: number) => bytes.slice(at, (at += n));
	return { opticalSig: take(SIG_BYTES), signPkey: take(SIGN_PKEY_BYTES), pqSig: take(PQ_SIG_BYTES), nameBytes: bytes.slice(at) };
};

export type ProofVerdict = { ok: true; name: string } | { ok: false; reason: string };

/** The peer is confirmed when it signed T optically with the key the codes showed, its identity key is the user_hash the codes showed, and that key signed T and its name. */
export const checkProof = (p: FrameProof, bound: { userHash: string; contactPkey: Uint8Array }, T: Uint8Array): ProofVerdict => {
	if (!verifyOptical(p.opticalSig, T, bound.contactPkey)) return { ok: false, reason: 'optical signature does not verify' };
	if (`u_${bytesToHex(sha3_512(p.signPkey))}` !== bound.userHash) {
		return { ok: false, reason: 'identity key is another identity than the codes showed' };
	}
	if (!ml_dsa87.verify(p.pqSig, proofMessage(T, p.nameBytes), p.signPkey)) {
		return { ok: false, reason: 'post-quantum signature does not verify' };
	}
	return { ok: true, name: new TextDecoder().decode(p.nameBytes) };
};

/** The six digits with no channel: from T alone, so both screens show the same ones for the same session. */
export const sessionCode = (T: Uint8Array): string => sixDigits(hkdfDerive(T, SAS_SALT, 'sas-qr', 4));

// The friends' half of the wrap key, Shamir-split among guardians, and what
// checks one share against the split it came from. The construction is the
// chat repo's docs/pq/reqs/pq_recovery_shares.proposed.md §Re-issuing; the
// on-chain side of it — the root in a guardian slot — is §Issuing there.
//
// A share is checked, not trusted: Shamir combines any bytes into some half,
// so a share that is damaged, from another split, or made up by its holder is
// caught here, by its leaf and the split's root, before it is combined.
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { shamirCombine, shamirSplit } from '@/lib/shamir';

const LEAF_TAG = new TextEncoder().encode('buckitup/recovery-share/leaf/v1\n');
const ROOT_TAG = new TextEncoder().encode('buckitup/recovery-share/root/v1\n');
/** The Shamir library's share header: its field size in bits, then the share's x-coordinate. */
const SHARE_BITS = 8;
const HALF_BYTES = 32;
const LEAF_BYTES = 64;
const SPLIT_ID = /^[0-9a-f]{32}$/;
/** The delivery record's channel tag: the share travels in the dialog. */
const DIALOG_CHANNEL = 0x01;

export class ShareCheckError extends Error {}

export interface Split {
	/** 16 random bytes, hex: which split a share belongs to. */
	splitId: string;
	threshold: number;
	total: number;
	/** Share `i` (1-based) is `shares[i - 1]`. */
	shares: Uint8Array[];
	/** `leaves[i - 1]` commits to share `i`; the list is every share's `split_proof`. */
	leaves: Uint8Array[];
	root: Uint8Array;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

const shape = (threshold: number, total: number): void => {
	if (!Number.isInteger(threshold) || !Number.isInteger(total) || threshold < 2 || threshold > total || total > 255) {
		throw new ShareCheckError('the split must have 2 ≤ threshold ≤ total ≤ 255');
	}
};

export const leafOf = (splitId: string, index: number, share: Uint8Array): Uint8Array =>
	sha3_512(concatBytes(LEAF_TAG, hexToBytes(splitId), Uint8Array.of(index), share));

export const rootOf = (threshold: number, total: number, leaves: Uint8Array[]): Uint8Array =>
	sha3_512(concatBytes(ROOT_TAG, Uint8Array.of(threshold), Uint8Array.of(total), ...leaves));

/** Splits the friends' half into `total` shares, any `threshold` of which give it back. */
export const splitFriendsHalf = (half: Uint8Array, total: number, threshold: number): Split => {
	shape(threshold, total);
	if (half.length !== HALF_BYTES) throw new ShareCheckError('the friends\' half is 32 bytes');
	const shares = shamirSplit(half, total, threshold);
	const splitId = bytesToHex(randomBytes(16));
	const leaves = shares.map((share, i) => leafOf(splitId, i + 1, share));
	return { splitId, threshold, total, shares, leaves, root: rootOf(threshold, total, leaves) };
};

export interface ShareToCheck {
	splitId: string;
	threshold: number;
	total: number;
	/** 1-based. */
	index: number;
	share: Uint8Array;
	/** Every leaf of the split, in index order. */
	proof: Uint8Array[];
}

/**
 * Throws ShareCheckError unless `s` is share `s.index` of the split whose
 * root is `root`. Every field but the share has a fixed length, and each is
 * checked: skip one and bytes can move between fields — a holder could shift
 * its share's header into `splitId` and still match its leaf.
 */
export const checkShare = (s: ShareToCheck, root: Uint8Array): void => {
	if (!SPLIT_ID.test(s.splitId)) throw new ShareCheckError('split id is not 16 bytes of hex');
	shape(s.threshold, s.total);
	if (!Number.isInteger(s.index) || s.index < 1 || s.index > s.total) throw new ShareCheckError('share index is outside the split');
	if (s.proof.length !== s.total || s.proof.some((leaf) => leaf.length !== LEAF_BYTES)) {
		throw new ShareCheckError('the proof is not one 64-byte leaf per share');
	}
	if (s.share.length < 3 || s.share[0] !== SHARE_BITS || s.share[1] !== s.index) {
		throw new ShareCheckError('the share is not share number ' + s.index);
	}
	if (!sameBytes(leafOf(s.splitId, s.index, s.share), s.proof[s.index - 1])) throw new ShareCheckError('the share does not match its leaf');
	if (!sameBytes(rootOf(s.threshold, s.total, s.proof), root)) throw new ShareCheckError('the proof does not hash to the split\'s root');
};

/**
 * The friends' half from checked shares. Counts distinct indices — a share
 * sent twice is one point, and the library would silently interpolate one
 * short of the threshold — and wants `threshold` of them.
 */
export const combineFriendsHalf = (shares: { index: number; share: Uint8Array }[], threshold: number): Uint8Array => {
	const distinct = new Map(shares.map((s) => [s.index, s.share]));
	if (distinct.size < threshold) throw new ShareCheckError(`need ${threshold} different shares, got ${distinct.size}`);
	const half = shamirCombine([...distinct.values()]);
	if (half.length !== HALF_BYTES) throw new ShareCheckError('the shares do not combine into a 32-byte half');
	return half;
};

/** What the first guardian slot of a version carries on chain for shares that travel in the dialog. */
export const deliveryRecord = (root: Uint8Array): Uint8Array => concatBytes(Uint8Array.of(DIALOG_CHANNEL), root);

/** Every other guardian slot of the version: the channel tag alone. */
export const deliveryTag = (): Uint8Array => Uint8Array.of(DIALOG_CHANNEL);

/**
 * The split's root from the slots of one version, or null when none of them
 * carries it. A slot is a record by its first byte and length (1 or 65), which
 * no ECIES ciphertext has; exactly one 65-byte record is expected.
 */
export const rootFromSlots = (slots: Uint8Array[]): Uint8Array | null => {
	const records = slots.filter((s) => s[0] === DIALOG_CHANNEL && s.length === 1 + LEAF_BYTES);
	return records.length === 1 ? records[0].slice(1) : null;
};

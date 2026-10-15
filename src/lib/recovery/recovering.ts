// Both ends of a return (chat repo: pq_recovery_shares § Returning): the
// guardian's share sent back for one round and one candidate, and the
// recovering device putting S together from the returned shares and the
// nodes' releases. Every returned share is checked against the version's
// root on chain before anything is combined: Shamir combines any bytes into
// some half, and a bad share would only show as a vault that does not open.
import { hexToBytes } from '@noble/hashes/utils';
import type { RecoveryShareReturnPart, RecoverySharePart } from '@/lib/pq/content';
import { fromBase64 } from '@/lib/pq/signature';
import { joinHalves } from '@/lib/pq/vaultEnvelope';
import { shamirCombine, shamirSplit } from '@/lib/shamir';
import { checkShare, combineFriendsHalf, ShareCheckError } from './shareSplit';
import { canonicalCandidate } from './recoveryBinding';

/** The guardian's return of `share` for `round`, to the `candidate` they approved. */
export const returnOf = (share: Omit<RecoverySharePart, 'kind'>, round: number, candidate: string, now: number): RecoveryShareReturnPart => ({
	kind: 'recovery_share_return',
	secretRef: share.secretRef,
	version: share.version,
	splitId: share.splitId,
	threshold: share.threshold,
	total: share.total,
	shareIndex: share.shareIndex,
	round,
	candidate: canonicalCandidate(candidate),
	shareB64: share.shareB64,
	createdAt: now,
	splitProof: [...share.splitProof],
	nodeSet: share.nodeSet,
});

export interface ExpectedReturn {
	secretRef: string;
	version: number;
	round: number;
	candidate: string;
}

export type CheckedReturn = { ok: true; index: number; share: Uint8Array; threshold: number; nodeSet: NonNullable<RecoveryShareReturnPart['nodeSet']> } | { ok: false; reason: string };

/**
 * A returned share as the recovering device judges it: for this secret,
 * version, round and candidate, and a true share of the split whose root is
 * on chain. One that fails is set aside with its sender named, not combined;
 * whatever the bytes, the answer is a verdict, never a throw.
 */
export const checkReturn = (r: RecoveryShareReturnPart, expected: ExpectedReturn, root: Uint8Array): CheckedReturn => {
	if (r.secretRef !== expected.secretRef || r.version !== expected.version) return { ok: false, reason: 'it is for another backup or version' };
	if (r.round !== expected.round) return { ok: false, reason: 'it answers another recovery round' };
	let candidate: string;
	try {
		candidate = canonicalCandidate(r.candidate);
	} catch {
		return { ok: false, reason: 'it names no valid device' };
	}
	if (candidate !== canonicalCandidate(expected.candidate)) return { ok: false, reason: 'it was released to another device' };
	let share: Uint8Array;
	let proof: Uint8Array[];
	try {
		if (typeof r.shareB64 !== 'string' || !Array.isArray(r.splitProof)) throw new TypeError();
		share = fromBase64(r.shareB64);
		proof = r.splitProof.map((l) => fromBase64(l));
	} catch {
		return { ok: false, reason: 'its piece or its proof is not valid base64' };
	}
	try {
		checkShare({ splitId: r.splitId, threshold: r.threshold, total: r.total, index: r.shareIndex, share, proof, nodeSet: r.nodeSet ?? null }, root);
	} catch (e) {
		return { ok: false, reason: e instanceof ShareCheckError ? e.message : 'it is not a well-formed share' };
	}
	return { ok: true, index: r.shareIndex, share, threshold: r.threshold, nodeSet: r.nodeSet! };
};

/** The length of a node share of the 32-byte node half, as the Shamir library writes one. */
let nodeShareBytes = 0;
const nodeShareLength = () => (nodeShareBytes ||= shamirSplit(new Uint8Array(32), 2, 2)[0].length);
/** The Shamir header every share starts with: the field size in bits, then the x-coordinate. */
const SHARE_BITS = 8;

/**
 * The node releases that can be combined, one per x-coordinate (a node that
 * released twice is one point, as combineFriendsHalf counts friends), and
 * how many were set aside as malformed: not hex, not a share of the node
 * half, or a header that is no Shamir share's.
 */
export const usableNodeShares = (nodeShares: readonly unknown[]): { shares: Uint8Array[]; malformed: number } => {
	const byIndex = new Map<number, Uint8Array>();
	let malformed = 0;
	for (const raw of nodeShares) {
		const hex = typeof raw === 'string' ? raw.toLowerCase().replace(/^0x/, '') : '';
		if (!/^(?:[0-9a-f]{2})+$/.test(hex)) {
			malformed++;
			continue;
		}
		const bytes = hexToBytes(hex);
		if (bytes.length !== nodeShareLength() || bytes[0] !== SHARE_BITS || bytes[1] === 0) {
			malformed++;
			continue;
		}
		if (!byIndex.has(bytes[1])) byIndex.set(bytes[1], bytes);
	}
	return { shares: [...byIndex.values()], malformed };
};

/**
 * S from checked returns and node releases: `threshold` distinct friends'
 * shares and `nodeThreshold` distinct node shares (hex, as nodes release
 * them; malformed ones are set aside). Throws ShareCheckError — and only
 * that — when either side is short or does not combine.
 */
export const assembleWrapKey = (returns: Extract<CheckedReturn, { ok: true }>[], nodeShares: readonly unknown[]): Uint8Array => {
	if (!returns.length) throw new ShareCheckError('no checked shares');
	const { threshold, nodeSet } = returns[0];
	const friendsHalf = combineFriendsHalf(returns.map((r) => ({ index: r.index, share: r.share })), threshold);
	const { shares, malformed } = usableNodeShares(nodeShares);
	if (shares.length < nodeSet.threshold) {
		throw new ShareCheckError(`need ${nodeSet.threshold} node releases, got ${shares.length}${malformed ? ` (${malformed} malformed set aside)` : ''}`);
	}
	try {
		return joinHalves(shamirCombine(shares), friendsHalf);
	} catch (e) {
		throw new ShareCheckError(`the node releases do not combine: ${(e as Error).message}`);
	}
};

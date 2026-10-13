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
import { shamirCombine } from '@/lib/shamir';
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
 * on chain. One that fails is set aside with its sender named, not combined.
 */
export const checkReturn = (r: RecoveryShareReturnPart, expected: ExpectedReturn, root: Uint8Array): CheckedReturn => {
	if (r.secretRef !== expected.secretRef || r.version !== expected.version) return { ok: false, reason: 'it is for another backup or version' };
	if (r.round !== expected.round) return { ok: false, reason: 'it answers another recovery round' };
	if (canonicalCandidate(r.candidate) !== canonicalCandidate(expected.candidate)) return { ok: false, reason: 'it was released to another device' };
	const share = fromBase64(r.shareB64);
	try {
		checkShare({ splitId: r.splitId, threshold: r.threshold, total: r.total, index: r.shareIndex, share, proof: r.splitProof.map((l) => fromBase64(l)), nodeSet: r.nodeSet }, root);
	} catch (e) {
		if (e instanceof ShareCheckError) return { ok: false, reason: e.message };
		throw e;
	}
	return { ok: true, index: r.shareIndex, share, threshold: r.threshold, nodeSet: r.nodeSet! };
};

/**
 * S from checked returns and node releases: `threshold` distinct friends'
 * shares and `nodeThreshold` node shares (hex, as nodes release them).
 * Throws when either side is short.
 */
export const assembleWrapKey = (returns: Extract<CheckedReturn, { ok: true }>[], nodeShares: string[]): Uint8Array => {
	if (!returns.length) throw new ShareCheckError('no checked shares');
	const { threshold, nodeSet } = returns[0];
	const friendsHalf = combineFriendsHalf(returns.map((r) => ({ index: r.index, share: r.share })), threshold);
	const distinct = [...new Set(nodeShares.map((s) => s.toLowerCase().replace(/^0x/, '')))];
	if (distinct.length < nodeSet.threshold) throw new ShareCheckError(`need ${nodeSet.threshold} node releases, got ${distinct.length}`);
	return joinHalves(shamirCombine(distinct.map(hexToBytes)), friendsHalf);
};

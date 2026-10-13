// The recovering device's side of a return (chat repo: pq_recovery_shares
// § Returning; plan § 7.5): a candidate key of its own, the binding it answers
// a guardian's request with, where the round stands for that candidate, and
// which returned shares count. Pure: the chain's answers and the dialogs'
// parts come in, verdicts go out. What combines them into S is recovering.ts.
import * as secp from '@noble/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import type { RecoveryBindingPart, RecoveryShareReturnPart } from '@/lib/pq/content';
import { canonicalCandidate, signBinding } from './recoveryBinding';
import { addressOf } from './evmSign';
import { checkReturn, type CheckedReturn, type ExpectedReturn } from './recovering';
import { parseNodeEntry, type NodeSet } from './nodeSet';
import type { NodeRef } from './nodeClient';
import type { SecretState } from './chain';

/** A canonical `secret_ref` anywhere in a text (07 § recovery_share: decimal chain id, lowercase hex). */
const SECRET_REF_IN_TEXT = /eip155:[1-9][0-9]*:0x[0-9a-f]{40}\/0x[0-9a-f]{64}(?![0-9a-f])/g;

/**
 * The `secret_ref` a guardian's first message carries (§ Returning, step 2),
 * or null: none, or two different ones — a request names one backup.
 */
export const findSecretRef = (text: unknown): string | null => {
	if (typeof text !== 'string') return null;
	const found = new Set(text.match(SECRET_REF_IN_TEXT) ?? []);
	return found.size === 1 ? [...found][0] : null;
};

/** What a guardian sends first: words for the person, and the secret_ref their app reads. */
export const helpRequestText = (secretRef: string): string =>
	`I am helping you get back into your account. Your app reads this line: ${secretRef}`;

/** A fresh candidate key, `0x` hex: the recipient this device asks the round to elect. It never leaves the device. */
export const newCandidateKey = (): string => '0x' + bytesToHex(secp.utils.randomPrivateKey());

/** The candidate address of `key`, lowercase. */
export const candidateOf = addressOf;

/** The answer to a guardian's request: this account's binding to the candidate (§ Returning, step 3). */
export const bindingFor = (candidateKey: string, secretRef: string, userHash: string): RecoveryBindingPart => ({
	kind: 'recovery_binding',
	secretRef,
	candidate: candidateOf(candidateKey),
	userHash,
	signatureB64: signBinding(candidateKey, secretRef, userHash),
});

export interface HelpRequest {
	/** The guardian who asked: the dialog peer. */
	peer: string;
	secretRef: string;
	/** The message it came in; UUIDv7, so later ids are later messages. */
	messageId: string;
}

/**
 * The backup this recovery follows: the one most guardians asked about, and
 * of those the first asked. A stranger who learns the temporary account's
 * user_hash can write to it; a request of theirs is answered (a binding for
 * another secret gives nothing away) but does not take the recovery over.
 */
export const chosenSecret = (requests: readonly HelpRequest[]): string | null => {
	const byRef = new Map<string, { peers: Set<string>; first: string }>();
	for (const r of requests) {
		const e = byRef.get(r.secretRef) ?? { peers: new Set<string>(), first: r.messageId };
		e.peers.add(r.peer);
		if (r.messageId < e.first) e.first = r.messageId;
		byRef.set(r.secretRef, e);
	}
	let best: [string, { peers: Set<string>; first: string }] | null = null;
	for (const entry of byRef) {
		if (!best || entry[1].peers.size > best[1].peers.size || (entry[1].peers.size === best[1].peers.size && entry[1].first < best[1].first)) best = entry;
	}
	return best?.[0] ?? null;
};

/**
 * Where the round stands for this device. `none`: no round open yet;
 * `voting`: guardians are approving; `timelock`: this device was elected and
 * the owner's veto window runs; `window`: this device may ask for the shares;
 * `elsewhere`: the round elected another device; `stopped`: the round this
 * device saw was cancelled — a veto; `expired`: the window closed.
 */
export type RestorePhase = 'none' | 'voting' | 'timelock' | 'window' | 'elsewhere' | 'stopped' | 'expired';

export interface RoundView {
	phase: RestorePhase;
	round: number;
	/** Approvals the contract needs: its quorum, not the Shamir threshold. */
	quorum: number;
	/** Unix seconds; 0 before quorum. */
	executeAfter: number;
	/** Unix seconds; 0 before quorum. */
	expiresAt: number;
}

/**
 * The round as this device reads it. `seenRound` is the last round it saw
 * open: the same round back at None was cancelled, which the contract shows
 * only by the absence of the round.
 */
export const roundViewOf = (secret: SecretState, state: RoundState, candidate: string, seenRound: number | null, now: number): RoundView => {
	const round = Number(secret.recoveryRound);
	const quorumReached = state === RoundState.TimeLock || state === RoundState.Window || state === RoundState.Expired;
	const executeAfter = quorumReached ? Number(secret.executeAfter) : 0;
	const expiresAt = quorumReached ? executeAfter + Number(secret.recoveryWindow) : 0;
	const view = { round, quorum: Number(secret.threshold), executeAfter, expiresAt };
	const ours = secret.recoveryRecipient?.toLowerCase() === canonicalCandidate(candidate);
	let phase: RestorePhase;
	if (state === RoundState.None) phase = seenRound === round ? 'stopped' : 'none';
	else if (state === RoundState.Voting) phase = 'voting';
	else if (state === RoundState.Expired || (expiresAt && now >= expiresAt)) phase = 'expired';
	else phase = ours ? (state === RoundState.TimeLock ? 'timelock' : 'window') : 'elsewhere';
	return { phase, ...view };
};

/** Whether the person can, and should, start over with a fresh candidate key (§ Returning: after the window, from step 3). */
export const canRestart = (phase: RestorePhase): boolean => phase === 'expired' || phase === 'stopped' || phase === 'elsewhere';

/** A returned share as it arrived: who sent it and how. */
export interface ReceivedReturn {
	sender: string;
	/** A dialog message, or a block pasted by hand. */
	via: 'dialog' | 'text';
	part: RecoveryShareReturnPart;
}

export type VerifiedReturn = { sender: string; via: ReceivedReturn['via']; index: number; checked: Extract<CheckedReturn, { ok: true }> };
export interface SetAsideReturn {
	sender: string;
	via: ReceivedReturn['via'];
	reason: string;
}

export interface ReturnsJudged {
	verified: VerifiedReturn[];
	setAside: SetAsideReturn[];
	/** Distinct share indices verified: a share returned twice is one point. */
	distinct: number;
	/** The split's threshold, once one share verified; null before. */
	threshold: number | null;
	/** The node set the verified shares name — one set, since it is in the root. */
	nodeSet: NodeSet | null;
}

/**
 * Every return checked against the version's root on chain, for this
 * recovery's secret, version, round and candidate (§ Returning, step 6). A
 * return for another backup, round or candidate is not this one's and is not
 * listed — a share sent to a device of an earlier round, before a restart,
 * says nothing against its guardian; one that fails any other check is set
 * aside with its sender named; one without a root to check against is set
 * aside too.
 */
/** Whether a return answers this round and names this device. */
const forThisRound = (part: RecoveryShareReturnPart, expected: ExpectedReturn): boolean => {
	if (part.round !== expected.round || typeof part.candidate !== 'string') return false;
	try {
		return canonicalCandidate(part.candidate) === canonicalCandidate(expected.candidate);
	} catch {
		return false;
	}
};

/**
 * The guardians whose piece for this round did not check and who returned
 * none that did: what the finale leaves out of the reshare it suggests.
 */
export const setAsideGuardians = (judged: Pick<ReturnsJudged, 'verified' | 'setAside'>): string[] => {
	const good = new Set(judged.verified.map((v) => v.sender));
	return [...new Set(judged.setAside.map((r) => r.sender))].filter((s) => !good.has(s));
};

export const judgeReturns = (received: readonly ReceivedReturn[], expected: ExpectedReturn, root: Uint8Array | null): ReturnsJudged => {
	const verified: VerifiedReturn[] = [];
	const setAside: SetAsideReturn[] = [];
	for (const r of received) {
		if (r.part.secretRef !== expected.secretRef || !forThisRound(r.part, expected)) continue;
		if (!root) {
			setAside.push({ sender: r.sender, via: r.via, reason: 'the network holds no checksum for this backup' });
			continue;
		}
		const checked = checkReturn(r.part, expected, root);
		if (checked.ok) verified.push({ sender: r.sender, via: r.via, index: checked.index, checked });
		else setAside.push({ sender: r.sender, via: r.via, reason: checked.reason });
	}
	const first = verified[0]?.checked;
	return {
		verified,
		setAside,
		distinct: new Set(verified.map((v) => v.index)).size,
		threshold: first?.threshold ?? null,
		nodeSet: first?.nodeSet ?? null,
	};
};

/** The nodes to ask for the node half, as the verified shares name them; entries that do not parse are left out. */
export const nodesOf = (nodeSet: NodeSet | null): NodeRef[] => {
	if (!nodeSet) return [];
	const out: NodeRef[] = [];
	for (const entry of nodeSet.nodes) {
		try {
			out.push(parseNodeEntry(entry));
		} catch {
			// The set is in the root, so a verified share's entries parse; nothing else reaches here.
		}
	}
	return out;
};

// The guardian's side of a return (chat repo: pq_recovery_shares § Returning;
// plan § 7.5, "Help someone recover"): the binding the person's temporary
// account answered with, what the guardian does about the round, and the send
// gate — the one rule that decides when this guardian's share goes back. Pure:
// the chain's answers come in, decisions go out.
import { RoundState } from 'backitup-secret-recovery-sdk/lib/types';
import type { ContentPart, RecoveryBindingPart } from '@/lib/pq/content';
import type { SecretState } from './chain';
import { checkBinding } from './recoveryBinding';

/** The parts of one message of the dialog peer, oldest message first. */
export interface PeerMessage {
	messageId: string;
	parts: ContentPart[];
}

export type BindingFound = { ok: true; candidate: string; binding: RecoveryBindingPart; messageId: string } | { ok: false; reason: string; messageId: string };

/**
 * The peer's latest answer to this guardian's request for `secretRef`, judged
 * (recoveryBinding.checkBinding): its candidate, or why it is refused. A
 * restart sends a new binding, so the newest one counts. Null while the peer
 * has not answered.
 */
export const latestBinding = (messages: readonly PeerMessage[], expected: { secretRef: string; peer: string }): BindingFound | null => {
	for (const m of [...messages].reverse()) {
		const binding = [...m.parts].reverse().find((p): p is RecoveryBindingPart => p.kind === 'recovery_binding' && p.secretRef === expected.secretRef);
		if (!binding) continue;
		try {
			return { ok: true, candidate: checkBinding(binding, { secretRef: expected.secretRef, dialogPeerUserHash: expected.peer }), binding, messageId: m.messageId };
		} catch (e) {
			return { ok: false, reason: (e as Error).message, messageId: m.messageId };
		}
	}
	return null;
};

/**
 * What the guardian does about the round, once the words matched:
 * `initiate` (then approve) when none is open — none yet, or the last one
 * expired; `approve` while it is voting; `approved` when their approval of
 * this candidate is already in; `closed` when quorum was reached without it —
 * after quorum a vote reverts, and the voters' shares suffice.
 */
export type RoundMove = 'initiate' | 'approve' | 'approved' | 'closed';

export const roundMove = (state: RoundState, approvedThisCandidate: boolean): RoundMove => {
	if (approvedThisCandidate) return 'approved';
	if (state === RoundState.None || state === RoundState.Expired) return 'initiate';
	if (state === RoundState.Voting) return 'approve';
	return 'closed';
};

/** What this guardian approved, as the gate checks it. */
export interface Approved {
	/** The candidate from the binding this guardian verified, lowercase. */
	candidate: string;
	/** The round the approval was signed in. */
	round: number;
	/** The version of the share this guardian holds. */
	heldVersion: number;
}

export type Gate =
	| { kind: 'send' }
	/** Not yet: `until` is the unix second the window opens, once quorum set it. */
	| { kind: 'wait'; until: number | null }
	| { kind: 'stop'; reason: string };

/**
 * The send gate (§ Returning): this guardian's own vote, not the round's
 * outcome. The share goes only while, on chain, the round this guardian
 * voted in is in its window, it elected the candidate this guardian approved
 * — not the owner — the guardian's approval is recorded, and the share held
 * is of the current version. Before the window it waits; once the round is
 * vetoed, replaced, expired or elects another device, it stops for good.
 * `canDecrypt` is not the gate: it is true for the owner with no round at
 * all, and true for whatever device the quorum elected.
 */
export const sendGate = (o: { secret: SecretState | null; state: RoundState; hasApproved: boolean; approved: Approved; now: number }): Gate => {
	const { secret, state, approved } = o;
	if (!secret) return { kind: 'stop', reason: 'the backup is no longer on the network' };
	if (secret.revoked) return { kind: 'stop', reason: 'the backup was revoked' };
	if (Number(secret.recoveryRound) !== approved.round) return { kind: 'stop', reason: 'a later recovery replaced the one you approved' };
	if (state === RoundState.None) return { kind: 'stop', reason: 'the recovery was stopped' };
	if (state === RoundState.Expired) return { kind: 'stop', reason: 'the recovery ran out of time' };
	if (state === RoundState.Voting) return { kind: 'wait', until: null };
	const recipient = secret.recoveryRecipient.toLowerCase();
	if (recipient !== approved.candidate) return { kind: 'stop', reason: 'the guardians elected another device than the one you checked' };
	if (recipient === secret.owner.toLowerCase()) return { kind: 'stop', reason: 'the recovery names the owner\'s own address' };
	const executeAfter = Number(secret.executeAfter);
	if (state === RoundState.TimeLock) return { kind: 'wait', until: executeAfter };
	if (state !== RoundState.Window) return { kind: 'stop', reason: 'the recovery is in a state this app does not know' };
	if (o.now >= executeAfter + Number(secret.recoveryWindow)) return { kind: 'stop', reason: 'the recovery ran out of time' };
	if (!o.hasApproved) return { kind: 'stop', reason: 'your approval is not on the network' };
	if (Number(secret.version) !== approved.heldVersion) return { kind: 'stop', reason: 'the piece you keep is from an earlier version of the backup' };
	return { kind: 'send' };
};

/**
 * When to ask the chain again, in seconds: about once a block from shortly
 * before the window opens — block time trails the clock — backing off to a
 * minute; a minute otherwise.
 */
export const nextCheckIn = (gate: Gate, now: number, blockTime: number): number => {
	if (gate.kind !== 'wait' || gate.until === null) return 60;
	const left = gate.until - now;
	if (left <= 120) return Math.max(blockTime, 2);
	return Math.min(60, left - 120);
};

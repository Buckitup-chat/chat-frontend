// Invitations in a dialog, as each side's client reads them (chat repo:
// pq_recovery_shares § Inviting). Pure: the page hands in the dialog's
// messages — a reply as its first revision — and the account's records, and
// gets back what each invitation and reply bubble says.
import type { ContentPart, RecoveryInvitePart, RecoveryInviteReplyPart } from '@/lib/pq/content';
import { checkInviteReply, inviteStateOf, type CheckedReply, type InviteState } from './guardianInvite';

/** What the owner's roster records of one invitation, before it is sent. */
export interface RosterInvite {
	contact: string;
	deployment: string;
	/** The carrying message's id: UUIDv7, so the newest invitation sorts last. */
	messageId: string;
}

/** The owner's record of an invitation's outcome, so a second device offers the same people. */
export type RosterAnswer =
	| { state: 'accepted'; contact: string; deployment: string; metaAddress: string }
	| { state: 'declined' | 'void'; contact: string; deployment: string };

/** The owner's `recovery_roster` slot, as far as invitations go. */
export interface Roster {
	invites?: Record<string, RosterInvite>;
	answers?: Record<string, RosterAnswer>;
}

/** The guardian's record of its own answer (its `guardian` slot), next to its holdings. */
export interface GuardianAnswer {
	owner: string;
	deployment: string;
	answer: 'accept' | 'decline';
}

export interface ThreadMessage {
	id: string;
	senderHash: string;
	/** For a reply, its first revision: editing or deleting the row changes nothing. */
	parts: ContentPart[];
}

export type InviteView =
	| {
			kind: 'sent_invite';
			inviteId: string;
			/** `superseded`: a newer invitation to this contact replaced it; `unrecorded`: not in this account's roster. */
			state: InviteState['state'] | 'superseded' | 'unrecorded';
			metaAddress?: string;
			/** Replies ignored, with why — reported, never counted. */
			problems: string[];
	  }
	| {
			kind: 'received_invite';
			inviteId: string;
			deployment: string;
			/** Why it can only be declined, if it can. */
			blocker: 'not_confirmed' | 'unreachable' | null;
			/** This account's answer, if it gave one. */
			answer: 'accept' | 'decline' | null;
	  }
	| { kind: 'reply'; inviteId: string; answer: string; mine: boolean; problem: string | null };

const invitesIn = (m: ThreadMessage) => m.parts.filter((p): p is RecoveryInvitePart => p.kind === 'recovery_invite');
const repliesIn = (m: ThreadMessage) => m.parts.filter((p): p is RecoveryInviteReplyPart => p.kind === 'recovery_invite_reply');

/** The live invitation to `contact` for `deployment`: the roster's newest. */
export const liveInviteId = (roster: Roster, contact: string, deployment: string): string | null => {
	let live: [string, RosterInvite] | null = null;
	for (const entry of Object.entries(roster.invites ?? {})) {
		const [, inv] = entry;
		if (inv.contact !== contact || inv.deployment !== deployment) continue;
		if (!live || inv.messageId > live[1].messageId) live = entry;
	}
	return live?.[0] ?? null;
};

/**
 * Another guardian in the roster already holding `metaAddress`: one key
 * holder counted twice casts two approvals.
 */
const heldByAnother = (roster: Roster, metaAddress: string, contact: string): string | null => {
	for (const a of Object.values(roster.answers ?? {})) {
		if (a.state === 'accepted' && a.metaAddress === metaAddress && a.contact !== contact) return a.contact;
	}
	return null;
};

export interface ThreadContext {
	messages: ThreadMessage[];
	myHash: string;
	peerHash: string;
	roster: Roster;
	/** Whether this account confirmed the peer in person. */
	peerConfirmed: boolean;
	/** Whether this build can approve on `deployment`. */
	reachable: (deployment: string) => boolean;
	/** This account's recorded answers, by invitation id (its `guardian` slot). */
	answers?: Record<string, GuardianAnswer>;
}

/** What each invitation and reply in the dialog shows, by message id. */
export const inviteViews = (ctx: ThreadContext): Record<string, InviteView> => {
	const { messages, myHash, peerHash, roster } = ctx;
	const out: Record<string, InviteView> = {};

	// Replies by invitation, each judged once. Only the peer answers the
	// owner's invitations, and only this account answers the peer's.
	const theirReplies = new Map<string, { messageId: string; part: RecoveryInviteReplyPart; checked: CheckedReply }[]>();
	const myAnswers = new Map<string, 'accept' | 'decline'>();
	for (const m of messages) {
		for (const part of repliesIn(m)) {
			if (m.senderHash === peerHash) {
				const checked = checkInviteReply(part, myHash, peerHash);
				const list = theirReplies.get(part.inviteId) ?? [];
				list.push({ messageId: m.id, part, checked });
				theirReplies.set(part.inviteId, list);
			} else if (m.senderHash === myHash && (part.answer === 'accept' || part.answer === 'decline')) {
				// A decline at any time withdraws: it wins over an earlier accept.
				if (myAnswers.get(part.inviteId) !== 'decline') myAnswers.set(part.inviteId, part.answer);
			}
		}
	}

	for (const m of messages) {
		for (const inv of invitesIn(m)) {
			if (m.senderHash === myHash) {
				const recorded = roster.invites?.[inv.inviteId];
				const replies = theirReplies.get(inv.inviteId) ?? [];
				const problems = replies.flatMap((r) => (r.checked.ok ? [] : [r.checked.reason]));
				if (!recorded || recorded.contact !== peerHash || recorded.deployment !== inv.deployment) {
					out[m.id] = { kind: 'sent_invite', inviteId: inv.inviteId, state: 'unrecorded', problems };
					continue;
				}
				if (liveInviteId(roster, peerHash, inv.deployment) !== inv.inviteId) {
					out[m.id] = { kind: 'sent_invite', inviteId: inv.inviteId, state: 'superseded', problems };
					continue;
				}
				const state = inviteStateOf(replies.map((r) => r.checked));
				if (state.state === 'accepted') {
					const other = heldByAnother(roster, state.metaAddress, peerHash);
					if (other) {
						out[m.id] = { kind: 'sent_invite', inviteId: inv.inviteId, state: 'void', problems: [...problems, `the meta-address is already ${other}'s`] };
						continue;
					}
					out[m.id] = { kind: 'sent_invite', inviteId: inv.inviteId, state: 'accepted', metaAddress: state.metaAddress, problems };
					continue;
				}
				if (state.state === 'void') problems.push('two different acceptances');
				out[m.id] = { kind: 'sent_invite', inviteId: inv.inviteId, state: state.state, problems };
			} else if (m.senderHash === peerHash) {
				const blocker = !ctx.peerConfirmed ? 'not_confirmed' : !ctx.reachable(inv.deployment) ? 'unreachable' : null;
				const answer = myAnswers.get(inv.inviteId) ?? ctx.answers?.[inv.inviteId]?.answer ?? null;
				out[m.id] = { kind: 'received_invite', inviteId: inv.inviteId, deployment: inv.deployment, blocker, answer };
			}
		}
	}

	for (const m of messages) {
		for (const part of repliesIn(m)) {
			const mine = m.senderHash === myHash;
			const judged = mine ? null : theirReplies.get(part.inviteId)?.find((r) => r.messageId === m.id)?.checked;
			out[m.id] = { kind: 'reply', inviteId: part.inviteId, answer: part.answer, mine, problem: judged && !judged.ok ? judged.reason : null };
		}
	}
	return out;
};

/**
 * The roster answers the owner's client owes for the dialog's live
 * invitations: those whose judged state is settled and differs from the
 * record. Written back, a second device offers the same people.
 */
export const rosterAnswersDue = (views: Record<string, InviteView>, roster: Roster, peerHash: string): Record<string, RosterAnswer> => {
	const due: Record<string, RosterAnswer> = {};
	for (const v of Object.values(views)) {
		if (v.kind !== 'sent_invite' || !['accepted', 'declined', 'void'].includes(v.state)) continue;
		const inv = roster.invites?.[v.inviteId];
		if (!inv) continue;
		const next: RosterAnswer =
			v.state === 'accepted'
				? { state: 'accepted', contact: peerHash, deployment: inv.deployment, metaAddress: v.metaAddress! }
				: { state: v.state as 'declined' | 'void', contact: peerHash, deployment: inv.deployment };
		const prev = roster.answers?.[v.inviteId];
		const same = prev?.state === next.state && prev.contact === next.contact && prev.deployment === next.deployment
			&& (prev.state !== 'accepted' || next.state !== 'accepted' || prev.metaAddress === next.metaAddress);
		if (!same) due[v.inviteId] = next;
	}
	return due;
};

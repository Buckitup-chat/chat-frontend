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
	| ({ kind: 'sent_invite'; inviteId: string } & JudgedInvite)
	| {
			kind: 'received_invite';
			inviteId: string;
			deployment: string;
			/** Why it can only be declined, if it can. */
			blocker: 'not_confirmed' | 'unreachable' | 'superseded' | null;
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
	approvesOn: (deployment: string) => boolean;
	/** This account's recorded answers, by invitation id (its `guardian` slot). */
	answers?: Record<string, GuardianAnswer>;
}

/** Where the owner's invitation stands, as the roster will record it. */
export interface JudgedInvite {
	state: InviteState['state'] | 'superseded' | 'unrecorded';
	metaAddress?: string;
	/** Replies ignored, with why — reported, never counted. */
	problems: string[];
}

// A proof check recovers a key; a dialog re-renders on every new row. The
// same reply part, judged for the same pair, is judged once.
const judgedParts = new WeakMap<RecoveryInviteReplyPart, Map<string, CheckedReply>>();
const judge = (part: RecoveryInviteReplyPart, ownerHash: string, guardianHash: string): CheckedReply => {
	const key = `${ownerHash}|${guardianHash}`;
	let byPair = judgedParts.get(part);
	if (!byPair) judgedParts.set(part, (byPair = new Map()));
	let checked = byPair.get(key);
	if (!checked) byPair.set(key, (checked = checkInviteReply(part, ownerHash, guardianHash)));
	return checked;
};

/** The peer's replies, judged, by invitation and by carrying message. */
const peerReplies = (ctx: ThreadContext) => {
	const byInvite = new Map<string, CheckedReply[]>();
	const byMessage = new Map<string, CheckedReply>();
	for (const m of ctx.messages) {
		if (m.senderHash !== ctx.peerHash) continue;
		for (const part of repliesIn(m)) {
			const checked = judge(part, ctx.myHash, ctx.peerHash);
			byInvite.set(part.inviteId, [...(byInvite.get(part.inviteId) ?? []), checked]);
			byMessage.set(m.id, checked);
		}
	}
	return { byInvite, byMessage };
};

/**
 * The owner's invitations in this dialog, judged against the roster rather
 * than dialog history (§ Inviting, step 4), by invitation id.
 */
export const judgeInvites = (ctx: ThreadContext, byInvite = peerReplies(ctx).byInvite): Map<string, JudgedInvite> => {
	const { roster, peerHash } = ctx;
	const out = new Map<string, JudgedInvite>();
	for (const m of ctx.messages) {
		if (m.senderHash !== ctx.myHash) continue;
		for (const inv of invitesIn(m)) {
			const replies = byInvite.get(inv.inviteId) ?? [];
			const problems = replies.flatMap((r) => (r.ok ? [] : [r.reason]));
			const recorded = roster.invites?.[inv.inviteId];
			let judged: JudgedInvite;
			if (!recorded || recorded.contact !== peerHash || recorded.deployment !== inv.deployment) judged = { state: 'unrecorded', problems };
			else if (liveInviteId(roster, peerHash, inv.deployment) !== inv.inviteId) judged = { state: 'superseded', problems };
			else {
				const state = inviteStateOf(replies);
				const other = state.state === 'accepted' ? heldByAnother(roster, state.metaAddress, peerHash) : null;
				if (other) judged = { state: 'void', problems: [...problems, `the meta-address is already ${other}'s`] };
				else if (state.state === 'accepted') judged = { state: 'accepted', metaAddress: state.metaAddress, problems };
				else judged = { state: state.state, problems: state.state === 'void' ? [...problems, 'two different acceptances'] : problems };
			}
			out.set(inv.inviteId, judged);
		}
	}
	return out;
};

/** What each invitation and reply in the dialog shows, by message id. */
export const inviteViews = (ctx: ThreadContext, judged?: Map<string, JudgedInvite>): Record<string, InviteView> => {
	const { messages, myHash, peerHash } = ctx;
	const { byInvite, byMessage } = peerReplies(ctx);
	judged ??= judgeInvites(ctx, byInvite);
	// This account's own answers to the peer: a decline at any time withdraws.
	const myAnswers = new Map<string, 'accept' | 'decline'>();
	for (const m of messages) {
		if (m.senderHash !== myHash) continue;
		for (const part of repliesIn(m)) {
			if (part.answer !== 'accept' && part.answer !== 'decline') continue;
			if (myAnswers.get(part.inviteId) !== 'decline') myAnswers.set(part.inviteId, part.answer);
		}
	}

	// The peer's newest invitation per deployment: an older one's replies are
	// ignored by its owner, so it is not offered for an answer.
	const newestFromPeer = new Map<string, string>();
	for (const m of messages) {
		if (m.senderHash !== peerHash) continue;
		for (const inv of invitesIn(m)) if ((newestFromPeer.get(inv.deployment) ?? '') < m.id) newestFromPeer.set(inv.deployment, m.id);
	}

	const out: Record<string, InviteView> = {};
	for (const m of messages) {
		for (const inv of invitesIn(m)) {
			if (m.senderHash === myHash) {
				out[m.id] = { kind: 'sent_invite', inviteId: inv.inviteId, ...judged.get(inv.inviteId)! };
			} else if (m.senderHash === peerHash) {
				const blocker = newestFromPeer.get(inv.deployment) !== m.id
					? 'superseded'
					: !ctx.peerConfirmed ? 'not_confirmed' : !ctx.approvesOn(inv.deployment) ? 'unreachable' : null;
				const answer = myAnswers.get(inv.inviteId) ?? ctx.answers?.[inv.inviteId]?.answer ?? null;
				out[m.id] = { kind: 'received_invite', inviteId: inv.inviteId, deployment: inv.deployment, blocker, answer };
			}
		}
		for (const part of repliesIn(m)) {
			const checked = byMessage.get(m.id);
			out[m.id] = { kind: 'reply', inviteId: part.inviteId, answer: part.answer, mine: m.senderHash === myHash, problem: checked && !checked.ok ? checked.reason : null };
		}
	}
	return out;
};

/**
 * The roster answers owed for judged invitations: those settled and not yet
 * recorded as they stand. Written back, a second device offers the same
 * people.
 */
export const rosterAnswersDue = (judged: Map<string, JudgedInvite>, roster: Roster): Record<string, RosterAnswer> => {
	const due: Record<string, RosterAnswer> = {};
	for (const [inviteId, j] of judged) {
		const inv = roster.invites?.[inviteId];
		if (!inv) continue;
		let next: RosterAnswer;
		if (j.state === 'accepted') next = { state: 'accepted', contact: inv.contact, deployment: inv.deployment, metaAddress: j.metaAddress! };
		else if (j.state === 'declined' || j.state === 'void') next = { state: j.state, contact: inv.contact, deployment: inv.deployment };
		else continue;
		const prev = roster.answers?.[inviteId];
		const same = prev?.state === next.state && prev.contact === next.contact && prev.deployment === next.deployment
			&& (prev.state !== 'accepted' || next.state !== 'accepted' || prev.metaAddress === next.metaAddress);
		if (!same) due[inviteId] = next;
	}
	return due;
};

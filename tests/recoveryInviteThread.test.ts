// Invitations in a dialog as each side reads them, and the actions that send
// them (pq_recovery_shares § Inviting). Real keys and proofs throughout.
import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { checkInviteReply, inviteProof, metaKeysOf } from '@/lib/recovery/guardianInvite';
import { inviteViews, liveInviteId, rosterAnswersDue, type Roster, type ThreadMessage } from '@/lib/recovery/inviteThread';
import { GUARDIAN_SLOT, ROSTER_SLOT, InvitationError, answerInvite, sendInvite, type InvitationDeps } from '@/lib/recovery/invitations';
import type { ContentPart } from '@/lib/pq/content';

const OWNER = 'u_' + 'a'.repeat(128);
const GUARDIAN = 'u_' + 'b'.repeat(128);
const OTHER = 'u_' + 'c'.repeat(128);
const DEPLOYMENT = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7';
const INVITE = '11'.repeat(16);
const NEWER = '22'.repeat(16);
const keys = metaKeysOf(new Uint8Array(32).fill(5));
const otherKeys = metaKeysOf(new Uint8Array(32).fill(6));

const invite = (id: string, sender: string, inviteId = INVITE, deployment = DEPLOYMENT): ThreadMessage => ({
	id,
	senderHash: sender,
	parts: [{ kind: 'recovery_invite', inviteId, deployment }],
});
const accept = (id: string, inviteId = INVITE, k = keys, sender = GUARDIAN): ThreadMessage => ({
	id,
	senderHash: sender,
	parts: [{ kind: 'recovery_invite_reply', inviteId, answer: 'accept', metaAddress: k.metaAddress, proofB64: inviteProof(k, inviteId, OWNER, GUARDIAN) }],
});
const decline = (id: string, inviteId = INVITE, sender = GUARDIAN): ThreadMessage => ({
	id,
	senderHash: sender,
	parts: [{ kind: 'recovery_invite_reply', inviteId, answer: 'decline', metaAddress: '', proofB64: '' }],
});
const roster = (extra: Roster = {}): Roster => ({
	invites: { [INVITE]: { contact: GUARDIAN, deployment: DEPLOYMENT, messageId: 'dmsg_01' }, ...extra.invites },
	answers: extra.answers,
});

const asOwner = (messages: ThreadMessage[], r: Roster = roster()) =>
	inviteViews({ messages, myHash: OWNER, peerHash: GUARDIAN, roster: r, peerConfirmed: true, reachable: (d) => d === DEPLOYMENT });
const asGuardian = (messages: ThreadMessage[], opts: { confirmed?: boolean; reachable?: boolean; answers?: Record<string, any> } = {}) =>
	inviteViews({
		messages,
		myHash: GUARDIAN,
		peerHash: OWNER,
		roster: {},
		peerConfirmed: opts.confirmed ?? true,
		reachable: () => opts.reachable ?? true,
		answers: opts.answers,
	});

describe('the owner’s view of an invitation', () => {
	it('waits, then is accepted with the guardian’s meta-address', () => {
		expect(asOwner([invite('m1', OWNER)]).m1).toMatchObject({ kind: 'sent_invite', state: 'pending' });
		const views = asOwner([invite('m1', OWNER), accept('m2')]);
		expect(views.m1).toMatchObject({ state: 'accepted', metaAddress: keys.metaAddress, problems: [] });
		expect(views.m2).toMatchObject({ kind: 'reply', answer: 'accept', mine: false, problem: null });
	});

	it('is withdrawn by a decline at any time, and voided by two acceptances that differ', () => {
		expect(asOwner([invite('m1', OWNER), accept('m2'), decline('m3')]).m1).toMatchObject({ state: 'declined' });
		expect(asOwner([invite('m1', OWNER), decline('m3'), accept('m2')]).m1).toMatchObject({ state: 'declined' });
		expect(asOwner([invite('m1', OWNER), accept('m2'), accept('m3', INVITE, otherKeys)]).m1).toMatchObject({ state: 'void' });
	});

	it('ignores and reports a reply that fails its check', () => {
		const forged: ThreadMessage = {
			id: 'm2',
			senderHash: GUARDIAN,
			// Another guardian's meta-address, with that guardian's proof for another pair.
			parts: [{ kind: 'recovery_invite_reply', inviteId: INVITE, answer: 'accept', metaAddress: otherKeys.metaAddress, proofB64: inviteProof(otherKeys, INVITE, OWNER, OTHER) }],
		};
		const views = asOwner([invite('m1', OWNER), forged]);
		expect(views.m1).toMatchObject({ state: 'pending', problems: [expect.stringMatching(/proof/)] });
		expect(views.m2).toMatchObject({ kind: 'reply', problem: expect.stringMatching(/proof/) });
	});

	it('counts only the peer’s replies', () => {
		expect(asOwner([invite('m1', OWNER), accept('m2', INVITE, keys, OWNER)]).m1).toMatchObject({ state: 'pending' });
	});

	it('is superseded by a newer invitation to the same contact, whose replies alone count', () => {
		const r = roster({ invites: { [NEWER]: { contact: GUARDIAN, deployment: DEPLOYMENT, messageId: 'dmsg_02' } } });
		expect(liveInviteId(r, GUARDIAN, DEPLOYMENT)).toBe(NEWER);
		const views = asOwner([invite('m1', OWNER), accept('m2'), invite('m3', OWNER, NEWER)], r);
		expect(views.m1).toMatchObject({ state: 'superseded' });
		expect(views.m3).toMatchObject({ state: 'pending' });
	});

	it('is not counted unless the roster recorded it for this contact', () => {
		expect(asOwner([invite('m1', OWNER), accept('m2')], {}).m1).toMatchObject({ state: 'unrecorded' });
		const elsewhere = { invites: { [INVITE]: { contact: OTHER, deployment: DEPLOYMENT, messageId: 'dmsg_01' } } };
		expect(asOwner([invite('m1', OWNER), accept('m2')], elsewhere).m1).toMatchObject({ state: 'unrecorded' });
	});

	it('refuses a meta-address another guardian in the roster already holds', () => {
		const r = roster({ answers: { ['33'.repeat(16)]: { state: 'accepted', contact: OTHER, deployment: DEPLOYMENT, metaAddress: keys.metaAddress } } });
		expect(asOwner([invite('m1', OWNER), accept('m2')], r).m1).toMatchObject({ state: 'void', problems: [expect.stringContaining(OTHER)] });
	});

	it('owes the roster each settled outcome once', () => {
		const views = asOwner([invite('m1', OWNER), accept('m2')]);
		const due = rosterAnswersDue(views, roster(), GUARDIAN);
		expect(due).toEqual({ [INVITE]: { state: 'accepted', contact: GUARDIAN, deployment: DEPLOYMENT, metaAddress: keys.metaAddress } });
		expect(rosterAnswersDue(views, roster({ answers: due }), GUARDIAN)).toEqual({});
		expect(rosterAnswersDue(asOwner([invite('m1', OWNER)]), roster(), GUARDIAN)).toEqual({});
	});
});

describe('the guardian’s view of an invitation', () => {
	it('can be accepted from a confirmed contact on a reachable deployment', () => {
		expect(asGuardian([invite('m1', OWNER)]).m1).toEqual({ kind: 'received_invite', inviteId: INVITE, deployment: DEPLOYMENT, blocker: null, answer: null });
	});

	it('can only be declined from an unconfirmed contact or on another deployment', () => {
		expect(asGuardian([invite('m1', OWNER)], { confirmed: false }).m1).toMatchObject({ blocker: 'not_confirmed' });
		expect(asGuardian([invite('m1', OWNER)], { reachable: false }).m1).toMatchObject({ blocker: 'unreachable' });
	});

	it('shows this account’s answer, from the dialog or its records; a decline wins', () => {
		expect(asGuardian([invite('m1', OWNER), accept('m2')]).m1).toMatchObject({ answer: 'accept' });
		expect(asGuardian([invite('m1', OWNER), accept('m2'), decline('m3')]).m1).toMatchObject({ answer: 'decline' });
		expect(asGuardian([invite('m1', OWNER)], { answers: { [INVITE]: { owner: OWNER, deployment: DEPLOYMENT, answer: 'decline' } } }).m1).toMatchObject({
			answer: 'decline',
		});
		expect(asGuardian([invite('m1', OWNER), accept('m2')]).m2).toMatchObject({ kind: 'reply', mine: true, problem: null });
	});
});

/** Fakes that keep what a real slot and dialog would: the order of writes, and what was sent. */
const fakeDeps = (over: Partial<InvitationDeps> = {}) => {
	const log: string[] = [];
	const slots: Record<string, any[]> = {};
	const sent: { peerHash: string; parts: ContentPart[]; messageId?: string | null }[] = [];
	let seed: string | null = null;
	const deps: InvitationDeps = {
		myHash: GUARDIAN,
		isConfirmed: () => true,
		deployment: DEPLOYMENT,
		newMessageId: async () => 'dmsg_0199',
		sendMessage: async (peerHash, parts, _onStatus, messageId) => {
			log.push('send');
			sent.push({ peerHash, parts: parts as ContentPart[], messageId });
			return messageId ?? 'dmsg_x';
		},
		patchSlotJson: async (name, patch) => {
			log.push(`patch:${name}`);
			(slots[name] ??= []).push(patch);
			return patch;
		},
		guardianMetaSeed: async ({ create }) => {
			if (!seed && create) seed = bytesToHex(new Uint8Array(32).fill(5));
			return seed;
		},
		...over,
	};
	return { deps, log, slots, sent };
};

describe('sending an invitation', () => {
	it('records it in the roster before it leaves', async () => {
		const { deps, log, slots, sent } = fakeDeps({ myHash: OWNER });
		const inviteId = await sendInvite(deps, GUARDIAN);
		expect(log).toEqual([`patch:${ROSTER_SLOT}`, 'send']);
		expect(slots[ROSTER_SLOT][0]).toEqual({ invites: { [inviteId]: { contact: GUARDIAN, deployment: DEPLOYMENT, messageId: 'dmsg_0199' } } });
		expect(sent[0]).toEqual({ peerHash: GUARDIAN, parts: [{ kind: 'recovery_invite', inviteId, deployment: DEPLOYMENT }], messageId: 'dmsg_0199' });
	});

	it('goes only to a contact confirmed in person', async () => {
		const { deps, log } = fakeDeps({ isConfirmed: () => false });
		await expect(sendInvite(deps, GUARDIAN)).rejects.toBeInstanceOf(InvitationError);
		expect(log).toEqual([]);
	});
});

describe('answering an invitation', () => {
	it('accepts with the vault’s guardian keys and a proof the owner accepts, and records the answer', async () => {
		const { deps, log, slots, sent } = fakeDeps();
		await answerInvite(deps, OWNER, { inviteId: INVITE, deployment: DEPLOYMENT }, true);
		const reply = sent[0].parts[0] as any;
		expect(reply).toMatchObject({ kind: 'recovery_invite_reply', inviteId: INVITE, answer: 'accept', metaAddress: keys.metaAddress });
		expect(checkInviteReply(reply, OWNER, GUARDIAN)).toEqual({ ok: true, answer: 'accept', metaAddress: keys.metaAddress });
		expect(log).toEqual(['send', `patch:${GUARDIAN_SLOT}`]);
		expect(slots[GUARDIAN_SLOT][0]).toEqual({ answers: { [INVITE]: { owner: OWNER, deployment: DEPLOYMENT, answer: 'accept' } } });
	});

	it('answers every owner with the same meta-address', async () => {
		const { deps, sent } = fakeDeps();
		await answerInvite(deps, OWNER, { inviteId: INVITE, deployment: DEPLOYMENT }, true);
		await answerInvite(deps, OTHER, { inviteId: NEWER, deployment: DEPLOYMENT }, true);
		expect((sent[0].parts[0] as any).metaAddress).toBe((sent[1].parts[0] as any).metaAddress);
	});

	it('declines with nothing in it', async () => {
		const { deps, sent } = fakeDeps({ guardianMetaSeed: async () => { throw new Error('no keys are made for a decline'); } });
		await answerInvite(deps, OWNER, { inviteId: INVITE, deployment: DEPLOYMENT }, false);
		expect(sent[0].parts[0]).toEqual({ kind: 'recovery_invite_reply', inviteId: INVITE, answer: 'decline', metaAddress: '', proofB64: '' });
	});

	it('refuses to accept from an unconfirmed contact, or on a deployment this build does not approve on', async () => {
		const unconfirmed = fakeDeps({ isConfirmed: () => false });
		await expect(answerInvite(unconfirmed.deps, OWNER, { inviteId: INVITE, deployment: DEPLOYMENT }, true)).rejects.toBeInstanceOf(InvitationError);
		const elsewhere = fakeDeps();
		await expect(answerInvite(elsewhere.deps, OWNER, { inviteId: INVITE, deployment: 'eip155:10:0x45907bd5636ccece1819fcd6433dec71c78f3bb3' }, true)).rejects.toBeInstanceOf(
			InvitationError,
		);
		expect([...unconfirmed.sent, ...elsewhere.sent]).toEqual([]);
		// A decline needs neither.
		await answerInvite(unconfirmed.deps, OWNER, { inviteId: INVITE, deployment: DEPLOYMENT }, false);
		expect(unconfirmed.sent).toHaveLength(1);
	});
});

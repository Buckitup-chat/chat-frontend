// Asking a contact to be a guardian and answering, as actions (chat repo:
// pq_recovery_shares § Inviting). The dialog carries the parts; each side's
// user_storage keeps its record — the owner's roster before the invitation
// leaves, the guardian's answer next to its holdings.
import { hexToBytes } from '@noble/hashes/utils';
import type { RecoveryInvitePart, RecoveryInviteReplyPart } from '@/lib/pq/content';
import { inviteProof, metaKeysOf, newInviteId } from './guardianInvite';
import type { GuardianAnswer, Roster, RosterAnswer, RosterInvite } from './inviteThread';

/** The owner's roster slot; the guardian's slot for its answers and, later, its holdings. */
export const ROSTER_SLOT = 'recovery_roster';
export const GUARDIAN_SLOT = 'guardian';

export interface InvitationDeps {
	myHash: string;
	/** Whether `peerHash` is a contact this account confirmed in person. */
	isConfirmed: (peerHash: string) => boolean;
	/** The deployment this build invites for, as `eip155:<chainId>:<contract>`. */
	deployment: string;
	/** Whether this build can approve on `deployment` (the same rule the card shows). */
	approvesOn: (deployment: string) => boolean;
	newMessageId: () => Promise<string>;
	/** dialogs.store's sendMessage: captured durably before it resolves. */
	sendMessage: (peerHash: string, parts: unknown[], onStatus?: (status: string, cause?: unknown) => void, messageId?: string | null) => Promise<string>;
	/** Resolves to the slot's value as the server accepted it. */
	patchSlotJson: (name: string, patch: unknown) => Promise<any>;
	guardianMetaSeed: (opts: { create: boolean }) => Promise<string | null>;
}

export class InvitationError extends Error {}

/**
 * Invites `peerHash` to be a guardian on this build's deployment. The roster
 * records the invitation before it is sent, so an answer to it is never one
 * this account cannot place; a newer invitation supersedes this one.
 */
export const sendInvite = async (
	deps: InvitationDeps,
	peerHash: string,
	onStatus?: (status: string, cause?: unknown) => void,
): Promise<{ inviteId: string; roster: Roster }> => {
	if (!deps.isConfirmed(peerHash)) throw new InvitationError('Only a contact confirmed in person can be asked to be a guardian.');
	const inviteId = newInviteId();
	const messageId = await deps.newMessageId();
	const invite: RosterInvite = { contact: peerHash, deployment: deps.deployment, messageId };
	const roster = await deps.patchSlotJson(ROSTER_SLOT, { invites: { [inviteId]: invite } } satisfies Roster);
	const part: RecoveryInvitePart = { kind: 'recovery_invite', inviteId, deployment: deps.deployment };
	try {
		await deps.sendMessage(peerHash, [part], onStatus, messageId);
	} catch (e) {
		// Never captured, so never sent: left in the roster it would be the
		// newest invitation and supersede the one the contact answered.
		await deps.patchSlotJson(ROSTER_SLOT, { invites: { [inviteId]: null } }).catch((undo) => console.error('[recovery] an unsent invitation stays in the roster:', inviteId, undo));
		throw e;
	}
	return { inviteId, roster: roster ?? {} };
};

/**
 * Answers `peerHash`'s invitation. An acceptance carries the meta-address of
 * the account's guardian keys — made from the vault's seed, created at the
 * first acceptance — and their proof over this invitation and both
 * identities. Only a confirmed contact, on the deployment this build reaches,
 * can be accepted; any invitation can be declined.
 */
export const answerInvite = async (
	deps: InvitationDeps,
	peerHash: string,
	invite: { inviteId: string; deployment: string },
	accept: boolean,
	onStatus?: (status: string, cause?: unknown) => void,
): Promise<Record<string, GuardianAnswer>> => {
	let part: RecoveryInviteReplyPart;
	if (accept) {
		if (!deps.isConfirmed(peerHash)) throw new InvitationError('Only a contact confirmed in person can be accepted.');
		if (!deps.approvesOn(invite.deployment)) throw new InvitationError('This invitation names a deployment this app cannot approve on.');
		const seed = await deps.guardianMetaSeed({ create: true });
		if (!seed) throw new InvitationError('The guardian keys could not be made.');
		const keys = metaKeysOf(hexToBytes(seed));
		part = {
			kind: 'recovery_invite_reply',
			inviteId: invite.inviteId,
			answer: 'accept',
			metaAddress: keys.metaAddress,
			proofB64: inviteProof(keys, invite.inviteId, peerHash, deps.myHash),
		};
	} else {
		part = { kind: 'recovery_invite_reply', inviteId: invite.inviteId, answer: 'decline', metaAddress: '', proofB64: '' };
	}
	await deps.sendMessage(peerHash, [part], onStatus);
	// The answer is in the dialog from here on, and the dialog is what the
	// owner reads; a record that fails to write is not a failed answer.
	const answer: GuardianAnswer = { owner: peerHash, deployment: invite.deployment, answer: accept ? 'accept' : 'decline' };
	try {
		const slot = await deps.patchSlotJson(GUARDIAN_SLOT, { answers: { [invite.inviteId]: answer } });
		return slot?.answers ?? {};
	} catch (e) {
		console.warn('[recovery] the answer was sent but not recorded:', invite.inviteId, e);
		return { [invite.inviteId]: answer };
	}
};

/** Records the owner's judged outcomes (inviteThread.rosterAnswersDue). */
export const recordRosterAnswers = async (deps: Pick<InvitationDeps, 'patchSlotJson'>, answers: Record<string, RosterAnswer>): Promise<Roster> =>
	(await deps.patchSlotJson(ROSTER_SLOT, { answers } satisfies Roster)) ?? {};

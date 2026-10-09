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
	/** The deployment this build approves on, as `eip155:<chainId>:<contract>`. */
	deployment: string;
	newMessageId: () => Promise<string>;
	/** dialogs.store's sendMessage: captured durably before it resolves. */
	sendMessage: (peerHash: string, parts: unknown[], onStatus?: (status: string, cause?: unknown) => void, messageId?: string | null) => Promise<string>;
	patchSlotJson: (name: string, patch: unknown) => Promise<unknown>;
	guardianMetaSeed: (opts: { create: boolean }) => Promise<string | null>;
}

export class InvitationError extends Error {}

/**
 * Invites `peerHash` to be a guardian on this build's deployment. The roster
 * records the invitation before it is sent, so an answer to it is never one
 * this account cannot place; a newer invitation supersedes this one.
 */
export const sendInvite = async (deps: InvitationDeps, peerHash: string, onStatus?: (status: string, cause?: unknown) => void): Promise<string> => {
	if (!deps.isConfirmed(peerHash)) throw new InvitationError('Only a contact confirmed in person can be asked to be a guardian.');
	const inviteId = newInviteId();
	const messageId = await deps.newMessageId();
	const invite: RosterInvite = { contact: peerHash, deployment: deps.deployment, messageId };
	await deps.patchSlotJson(ROSTER_SLOT, { invites: { [inviteId]: invite } } satisfies Roster);
	const part: RecoveryInvitePart = { kind: 'recovery_invite', inviteId, deployment: deps.deployment };
	await deps.sendMessage(peerHash, [part], onStatus, messageId);
	return inviteId;
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
): Promise<void> => {
	let part: RecoveryInviteReplyPart;
	if (accept) {
		if (!deps.isConfirmed(peerHash)) throw new InvitationError('Only a contact confirmed in person can be accepted.');
		if (invite.deployment !== deps.deployment) throw new InvitationError('This invitation names a deployment this app cannot approve on.');
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
	const answer: GuardianAnswer = { owner: peerHash, deployment: invite.deployment, answer: part.answer as GuardianAnswer['answer'] };
	await deps.patchSlotJson(GUARDIAN_SLOT, { answers: { [invite.inviteId]: answer } });
};

/** Records the owner's judged outcomes (inviteThread.rosterAnswersDue). */
export const recordRosterAnswers = async (deps: Pick<InvitationDeps, 'patchSlotJson'>, answers: Record<string, RosterAnswer>): Promise<void> => {
	if (Object.keys(answers).length) await deps.patchSlotJson(ROSTER_SLOT, { answers } satisfies Roster);
};

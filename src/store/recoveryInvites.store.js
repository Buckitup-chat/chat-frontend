// The account's guardian invitations (pq_recovery_shares § Inviting): the
// owner's roster and the guardian's answers, kept once per account rather
// than per open dialog, and the actions that write them. Dialog pages judge
// their own messages (inviteThread) and hand the owner's outcomes back here.
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { v7 as uuidv7 } from 'uuid';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { deploymentNamespace, recoveryDeployment } from '@/lib/recovery/deployments';
import { rosterAnswersDue } from '@/lib/recovery/inviteThread';
import { GUARDIAN_SLOT, ROSTER_SLOT, answerInvite, recordRosterAnswers, sendInvite } from '@/lib/recovery/invitations';

export const useRecoveryInvitesStore = defineStore('recoveryInvites', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();

	/** The deployment this build invites for and approves on. */
	const deployment = deploymentNamespace(recoveryDeployment());
	const approvesOn = (d) => d === deployment;
	/** Only a contact confirmed in person can be asked, or accepted. */
	const isConfirmed = (userHash) => $userPQ.contactsMap?.[userHash]?.confirmed === true;

	const roster = ref({});
	const answers = ref({});
	let loadedFor = null;
	let loading = null;

	watch(
		() => $userPQ.currentUserHash,
		() => {
			loadedFor = null;
			roster.value = {};
			answers.value = {};
		},
	);

	/** Reads both slots once per account; later calls resolve at once. */
	const load = () => {
		const owner = $userPQ.currentUserHash;
		if (!owner || loadedFor === owner) return Promise.resolve();
		loading ??= (async () => {
			const em = EncryptionManagerPQ.getInstance();
			const [r, g] = await Promise.all([em.loadSlotJson(ROSTER_SLOT), em.loadSlotJson(GUARDIAN_SLOT)]);
			if ($userPQ.currentUserHash !== owner) return;
			roster.value = r ?? {};
			answers.value = g?.answers ?? {};
			loadedFor = owner;
		})().finally(() => {
			loading = null;
		});
		return loading;
	};

	const deps = () => {
		const em = EncryptionManagerPQ.getInstance();
		return {
			myHash: $userPQ.currentUserHash,
			isConfirmed,
			deployment,
			approvesOn,
			newMessageId: async () => 'dmsg_' + uuidv7(),
			sendMessage: $dialogs.sendMessage,
			patchSlotJson: (name, patch) => em.patchSlotJson(name, patch),
			guardianMetaSeed: (opts) => em.guardianMetaSeed(opts),
		};
	};

	const invite = async (peerHash, onStatus) => {
		const { roster: accepted } = await sendInvite(deps(), peerHash, onStatus);
		roster.value = accepted;
	};

	const answer = async (peerHash, inv, accept, onStatus) => {
		answers.value = await answerInvite(deps(), peerHash, inv, accept, onStatus);
	};

	// A dialog re-judges on every new row: one write in flight, and an outcome
	// submitted once — a failed write is forgotten, so the next judging retries.
	const submitted = new Set();
	let recording = false;
	const recordJudged = async (judged) => {
		if (recording || loadedFor !== $userPQ.currentUserHash) return;
		const due = rosterAnswersDue(judged, roster.value);
		const keys = Object.entries(due).map(([id, a]) => `${id}:${a.state}:${a.metaAddress ?? ''}`);
		if (!keys.length || keys.every((k) => submitted.has(k))) return;
		recording = true;
		keys.forEach((k) => submitted.add(k));
		try {
			roster.value = await recordRosterAnswers(deps(), due);
		} catch (e) {
			keys.forEach((k) => submitted.delete(k));
			console.warn('[recovery] recording guardian answers failed:', e);
		} finally {
			recording = false;
		}
	};

	return { roster, answers, deployment, approvesOn, isConfirmed, load, invite, answer, recordJudged };
});

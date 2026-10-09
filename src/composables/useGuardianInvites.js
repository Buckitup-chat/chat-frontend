// A dialog page's guardian invitations (pq_recovery_shares § Inviting): what
// each invitation and reply bubble shows, the owner's outcomes handed back to
// the account's roster, and the two actions with their prompts and errors.
import { computed, ref, watch } from 'vue';
import { useRecoveryInvitesStore } from '@/store/recoveryInvites.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { userPQStore } from '@/store/userPQ.store';
import { inviteViews, judgeInvites } from '@/lib/recovery/inviteThread';
import { InvitationError } from '@/lib/recovery/invitations';

/**
 * @param {object} o
 * @param {import('vue').Ref<string>} o.peerHash
 * @param {import('vue').Ref<string>} o.dialogHash
 * @param {import('vue').Ref<object[]>} o.messages decrypted dialog entries ({ id, parts, _raw })
 * @param {import('vue').Ref<Record<string, number>>} o.versionCounts archived revisions by message id
 * @param {import('vue').Ref<string>} o.peerName
 * @param {object} o.swal
 * @param {() => boolean} o.isAlive false once the page is gone: no late prompts
 */
export function useGuardianInvites({ peerHash, dialogHash, messages, versionCounts, peerName, swal, isAlive }) {
	const $invites = useRecoveryInvitesStore();
	const $dialogs = useDialogsStore();
	const $userPQ = userPQStore();
	const inviting = ref(false);
	const peerConfirmed = computed(() => $invites.isConfirmed(peerHash.value));
	const hasInvites = computed(() => messages.value.some((m) => (m.parts || []).some((p) => p.kind === 'recovery_invite')));

	watch(hasInvites, (has) => {
		if (has) $invites.load().catch((e) => console.warn('[chat] guardian records unavailable:', e));
	}, { immediate: true });

	// A reply counts as its first revision: an edited or deleted one is read
	// from its archived revisions. Only dialogs with invitations need it.
	const firstRevision = ref(new Map());
	let generation = 0;
	watch([versionCounts, hasInvites, dialogHash], async ([counts, has, dh]) => {
		if (!has || !dh) return;
		const run = ++generation;
		const missing = Object.keys(counts).filter((id) => !firstRevision.value.has(id));
		if (!missing.length) return;
		const found = await Promise.all(missing.map((id) => $dialogs.firstRevisionParts(dh, id).catch(() => null)));
		if (run !== generation || !isAlive()) return;
		const next = new Map(firstRevision.value);
		missing.forEach((id, i) => found[i] && next.set(id, found[i]));
		firstRevision.value = next;
	}, { immediate: true });

	const context = computed(() => ({
		messages: messages.value
			.filter((m) => m._raw?.sender_hash)
			.map((m) => ({ id: m.id, senderHash: m._raw.sender_hash, parts: firstRevision.value.get(m.id) ?? m.parts ?? [] })),
		myHash: $userPQ.currentUserHash,
		peerHash: peerHash.value,
		roster: $invites.roster,
		peerConfirmed: peerConfirmed.value,
		approvesOn: $invites.approvesOn,
		answers: $invites.answers,
	}));

	const views = computed(() => (peerHash.value && hasInvites.value ? inviteViews(context.value) : {}));

	// The owner's outcomes go to the account's roster, so a second device
	// offers the same people at backup time.
	watch(context, (ctx) => {
		if (hasInvites.value) $invites.recordJudged(judgeInvites(ctx));
	});

	const statusToast = (what) => (status) => {
		if (!isAlive()) return;
		if (status === 'queued') swal.fire({ icon: 'info', title: `${what} queued`, text: 'No connection right now — it is stored and sent when the network returns.' });
		else if (status === 'awaiting_approval') swal.fire({ icon: 'info', title: `${what} waits for approval`, text: 'It is sent once the device owner approves your account.' });
	};

	const run = async (errorTitle, fn) => {
		if (inviting.value) return;
		inviting.value = true;
		try {
			await fn();
		} catch (e) {
			if (isAlive()) swal.fire({ icon: 'error', title: errorTitle, text: e instanceof InvitationError ? e.message : String(e?.message ?? e) });
		} finally {
			inviting.value = false;
		}
	};

	const inviteGuardian = async () => {
		const { isConfirmed } = await swal.fire({
			icon: 'question',
			title: `Ask ${peerName.value} to be your guardian?`,
			text: 'A guardian keeps a part of your backup. If you ever lose access, they check that it is really you and approve your recovery.',
			showCancelButton: true,
			confirmButtonText: 'Ask',
		});
		if (!isConfirmed) return;
		await run('The invitation was not sent', async () => {
			await $invites.load();
			await $invites.invite(peerHash.value, statusToast('The invitation'));
		});
	};

	const answerInvite = ({ inviteId, deployment, accept }) =>
		run('The answer was not sent', () =>
			$invites.answer(peerHash.value, { inviteId, deployment }, accept, statusToast(accept ? 'Your acceptance' : 'Your answer')),
		);

	return { views, peerConfirmed, inviting, inviteGuardian, answerInvite };
}

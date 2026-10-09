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
 * @param {import('vue').Ref<string>} o.peerName
 * @param {object} o.swal
 * @param {() => boolean} o.isAlive false once the page is gone: no late prompts
 */
export function useGuardianInvites({ peerHash, dialogHash, messages, peerName, swal, isAlive }) {
	const $invites = useRecoveryInvitesStore();
	const $dialogs = useDialogsStore();
	const $userPQ = userPQStore();
	const inviting = ref(false);
	const peerConfirmed = computed(() => $invites.isConfirmed(peerHash.value));
	const hasInvites = computed(() => messages.value.some((m) => (m.parts || []).some((p) => p.kind === 'recovery_invite')));

	// The records are the account's, and another device may have invited
	// since: read again each time a dialog with invitations opens.
	watch([hasInvites, dialogHash], ([has]) => {
		if (has) $invites.load({ refresh: true }).catch((e) => console.warn('[chat] guardian records unavailable:', e));
	}, { immediate: true });

	// A reply counts as its first revision: an edited or deleted message (its
	// row has a parent) is read as the revision it began as. Until that is
	// known, the message is left out of judging, and nothing is recorded.
	const edited = computed(() => messages.value.filter((m) => m._raw?.parent_sign_hash).map((m) => m.id));
	const originals = ref(new Map());
	let generation = 0;
	watch([edited, hasInvites, dialogHash], async ([ids, has, dh]) => {
		if (!has || !dh) return;
		const missing = ids.filter((id) => !originals.value.get(id));
		if (!missing.length) return;
		const run = ++generation;
		const found = await $dialogs.firstRevisionsOf(dh, missing).catch(() => new Map());
		if (run !== generation || !isAlive()) return;
		originals.value = new Map([...originals.value, ...found]);
	}, { immediate: true });
	const originalsKnown = computed(() => edited.value.every((id) => originals.value.get(id)));

	const context = computed(() => ({
		messages: messages.value
			.filter((m) => m._raw?.sender_hash)
			.map((m) => ({
				id: m.id,
				senderHash: m._raw.sender_hash,
				parts: m._raw.parent_sign_hash ? (originals.value.get(m.id) ?? []) : (m.parts ?? []),
			})),
		myHash: $userPQ.currentUserHash,
		peerHash: peerHash.value,
		roster: $invites.roster,
		peerConfirmed: peerConfirmed.value,
		approvesOn: $invites.approvesOn,
		answers: $invites.answers,
	}));

	const active = computed(() => !!peerHash.value && hasInvites.value && $invites.loaded);
	const judged = computed(() => (active.value ? judgeInvites(context.value) : new Map()));
	const views = computed(() => (active.value ? inviteViews(context.value, judged.value) : {}));

	// The owner's outcomes go to the account's roster, so a second device
	// offers the same people at backup time — once every reply is read as
	// its first revision.
	watch(judged, (j) => {
		if (active.value && originalsKnown.value && j.size) $invites.recordJudged(j);
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

// "Recover with friends" — the recovering device (plan § 7.5; chat repo:
// pq_recovery_shares § Returning, § Manual return). It runs as a temporary
// account: an ordinary account made on this device, whose user_hash the
// person gives a guardian, and whose vault keeps the recovery's progress and
// the candidate key beside its own keys. The temporary account is named in
// this device's localStorage (public metadata), so a reload, or a sign-in to
// it, comes back to the recovery. At the threshold it puts S together, opens
// the vault and lands in the original account; the finale (recoveryFinale)
// destroys the temporary account and asks for a reshare.
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useDialogsStore } from '@/store/dialogs.store';
import { useRecoveryFinaleStore } from '@/store/recoveryFinale.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { followPeersWhoWrote, peersWhoWrote } from '@/lib/data/inboundDialogs';
import { RecoveryChain } from '@/lib/recovery/chain';
import { deploymentNamespace, maybeRecoveryDeployment } from '@/lib/recovery/deployments';
import { parseSecretRef } from '@/lib/recovery/holdings';
import { requestRelease } from '@/lib/recovery/nodeClient';
import { fetchVault } from '@/lib/recovery/vault';
import { bindingFor, canRestart, findSecretRef, setAsideGuardians } from '@/lib/recovery/restoring';
import { newMemo, newProgress, restarted, restorePass, wrapKeyFrom } from '@/lib/recovery/restoreFlow';
import { bindingText, blockSignedBy, parseReturnBlock, readReturnBlock } from '@/lib/recovery/manualReturn';
import { nameOf as accountName } from '@/components/recovery/backup/backupFlow';
import errorMessage from '@/utils/errorMessage';

/** The temporary account this device is recovering with, if any. */
export const RECOVERING_KEY = 'buckitup:recovering';
/** How often the screen looks again while it is shown. */
export const CHECK_MS = 20_000;
const nowSec = () => Math.floor(Date.now() / 1000);
const readMarker = () => (typeof localStorage !== 'undefined' && localStorage.getItem(RECOVERING_KEY)) || null;

export const useRecoveryRestoreStore = defineStore('recoveryRestore', () => {
	const $userPQ = userPQStore();
	const $dialogs = useDialogsStore();
	const em = () => EncryptionManagerPQ.getInstance();
	const deployment = maybeRecoveryDeployment();
	const namespace = deployment ? deploymentNamespace(deployment) : null;
	let chain = null;
	const chainOf = () => (chain ??= new RecoveryChain(deployment));

	/** The temporary account's user_hash, as this device remembers it. */
	const temporary = ref(readMarker());
	/** Signed in as the temporary account: the app shows the recovery and nothing else. */
	const active = computed(() => !!temporary.value && $userPQ.currentUserHash === temporary.value);

	const progress = shallowRef(null);
	const view = shallowRef(null);
	const checking = ref(false);
	const lastError = ref(null);
	const checkedAt = ref(0);
	/** A share pasted as text, waiting for the person to compare the digits: { guardian, name, digits }. */
	const pendingBlock = shallowRef(null);
	let pendingRead = null;
	const opening = ref(false);
	const openError = ref(null);
	let memo = newMemo();

	const setMarker = (hash) => {
		temporary.value = hash;
		if (hash) localStorage.setItem(RECOVERING_KEY, hash);
		else localStorage.removeItem(RECOVERING_KEY);
	};

	watch(
		() => $userPQ.currentUserHash,
		() => {
			progress.value = null;
			view.value = null;
			lastError.value = null;
			rejectBlock();
			memo = newMemo();
		},
	);

	const save = async (p) => {
		if ($userPQ.currentUserHash !== p.userHash) throw new Error('The account changed; the recovery was not saved');
		await em().saveRecoveryProgress(p);
		progress.value = p;
	};

	/**
	 * Starts a recovery on this device: makes the temporary account — an
	 * ordinary one, which signs in — and its first candidate key.
	 */
	const begin = async () => {
		if (!deployment) throw new Error('This app names no network to recover on.');
		const identity = await $userPQ.registerNewUser({ name: 'Recovering account' });
		setMarker(identity.user_hash);
		await save(newProgress(identity.user_hash, nowSec()));
		return identity.user_hash;
	};

	/** The progress of the signed-in temporary account, made afresh if its vault has none. */
	const load = async () => {
		if (!active.value) return null;
		if (progress.value?.userHash === $userPQ.currentUserHash) return progress.value;
		const me = $userPQ.currentUserHash;
		const stored = await em().loadRecoveryProgress();
		if ($userPQ.currentUserHash !== me) return null;
		if (stored?.v === 1 && stored.userHash === me) progress.value = stored;
		else await save(newProgress(me, nowSec()));
		return progress.value;
	};

	/** A pass's world, for the temporary account `me`: nothing is sent under any other account signed in meanwhile. */
	const deps = (me) => ({
		namespace,
		peersWhoWrote: () => peersWhoWrote(me),
		readPeer: async (peer) => (await $dialogs.readPeerParts(peer, ['text', 'recovery_share_return']))?.messages ?? null,
		sendBinding: async (peer, parts) => {
			// The binding names the temporary account and is signed as it: checked right before it is captured.
			if ($userPQ.currentUserHash !== me) throw new Error('The account changed; no answer was sent');
			await $dialogs.sendMessage(peer, parts);
		},
		chain: chainOf(),
		release: (node, id, key) => requestRelease(node, id, key),
		save,
		now: nowSec,
	});

	let running = null;
	/** One look: requests answered, the round, the returns, the nodes. One at a time. */
	const check = () => {
		if (!active.value || !deployment) return Promise.resolve();
		running ??= (async () => {
			checking.value = true;
			const me = $userPQ.currentUserHash;
			try {
				const p = await load();
				if (!p) return;
				const out = await restorePass(p, deps(me), memo);
				if ($userPQ.currentUserHash !== me) return;
				progress.value = out.progress;
				view.value = out.view;
				lastError.value = null;
				checkedAt.value = nowSec();
			} catch (e) {
				console.warn('[recovery] the recovery could not be checked:', e);
				if ($userPQ.currentUserHash === me) lastError.value = errorMessage(e);
			} finally {
				checking.value = false;
				running = null;
			}
		})();
		return running;
	};

	/** Starts over with a fresh candidate key, after the window closed, a veto, or another device was elected. */
	const restart = async () => {
		const p = await load();
		if (!p) return;
		if (view.value?.round && !canRestart(view.value.round.phase)) throw new Error('This recovery is still running.');
		memo = newMemo();
		await save(restarted(p));
		view.value = null;
		await check();
	};

	/**
	 * A guardian who cannot reach this account in the app sends the secret_ref
	 * some other way (§ Manual return). Resolves to the binding to send back,
	 * as text, and the words to read out.
	 */
	const typeRequest = async (text) => {
		const secretRef = findSecretRef(text);
		if (!secretRef) throw new Error('This is not what your guardian\'s app shows: look for the line that starts with eip155.');
		const p = await load();
		if (!p) throw new Error('No recovery is running here.');
		if (!p.typedRequests.some((r) => r.secretRef === secretRef)) await save({ ...p, typedRequests: [...p.typedRequests, { secretRef, at: nowSec() }] });
		await check();
		return bindingText(bindingFor(progress.value.candidateKey, secretRef, progress.value.userHash));
	};

	const nameOf = (hash) => accountName(hash, $userPQ);

	/**
	 * A share pasted as text: decapsulated with this account's key and its
	 * digits derived, but not opened — nothing is imported until the person
	 * says the digits match (confirmBlock). A block whose guardian's card is
	 * here is checked against it, and refused if it is not theirs.
	 */
	const readBlock = async (text) => {
		const secretRef = view.value?.secretRef;
		if (!secretRef) throw new Error('A guardian has to send the request first.');
		const block = parseReturnBlock(text);
		const card = $userPQ.getUserByHash?.(block.guardian);
		if (card?.sign_pkey && !blockSignedBy(block, card.sign_pkey)) throw new Error('This piece is not signed by the guardian it names. Ask them to send it again.');
		pendingRead?.forget();
		pendingRead = await readReturnBlock(block, secretRef, (ct) => em().kemDecapsulate(ct));
		pendingBlock.value = { guardian: block.guardian, name: nameOf(block.guardian), digits: pendingRead.digits };
		return pendingBlock.value;
	};

	/** The digits matched: the share is opened and counted like one from the dialog. */
	const confirmBlock = async () => {
		const read = pendingRead;
		if (!read) return;
		// The recovery it goes into first: with another account signed in, the block stays as it is, unopened.
		const p = await load();
		if (!p) throw new Error('The recovery is not signed in on this device now. Sign in to the temporary account again, then add the piece.');
		const part = await read.open();
		read.forget();
		if (pendingRead === read) {
			pendingRead = null;
			pendingBlock.value = null;
		}
		await save({ ...p, typedReturns: [...p.typedReturns, { sender: read.guardian, part }] });
		await check();
	};

	/** The digits differ: the block is dropped, opened by nobody. */
	const rejectBlock = () => {
		pendingRead?.forget();
		pendingRead = null;
		pendingBlock.value = null;
	};

	/**
	 * Puts S together, opens the vault and lands in the original account —
	 * from a tap: the import makes a passkey, which WebKit allows only from a
	 * user gesture. The finale takes over from there.
	 */
	const openAccount = async () => {
		if (opening.value) return;
		opening.value = true;
		openError.value = null;
		try {
			const v = view.value;
			const p = progress.value;
			if (!v?.ready || !p) throw new Error('Not enough pieces yet.');
			const wrapKey = wrapKeyFrom(v, memo);
			let backup;
			try {
				backup = await fetchVault(wrapKey);
			} finally {
				wrapKey.fill(0);
			}
			if (backup.identity.user_hash === p.userHash) throw new Error('The backup opened to this temporary account, not yours.');
			const { id } = parseSecretRef(v.secretRef);
			await useRecoveryFinaleStore().land(backup, {
				temporary: p.userHash,
				secretId: id,
				version: v.version,
				round: v.round.round,
				candidate: v.candidate,
				setAside: setAsideGuardians(v.returns),
			});
			setMarker(null);
		} catch (e) {
			openError.value = errorMessage(e);
			throw e;
		} finally {
			opening.value = false;
		}
	};

	let timer = null;
	let unfollow = null;
	/** A look on the watch's own beat; none once enough pieces are here — the person opens the account from there. */
	const due = () => !view.value?.ready;
	const onVisible = () => {
		if (document.visibilityState === 'visible' && due() && nowSec() - checkedAt.value >= CHECK_MS / 2000) check();
	};
	/** Looks again every CHECK_MS while the screen is shown and visible, following who writes to the temporary account. */
	const startWatching = () => {
		if (timer) return;
		if (active.value) unfollow = followPeersWhoWrote($userPQ.currentUserHash);
		timer = setInterval(() => {
			if ((typeof document === 'undefined' || document.visibilityState === 'visible') && due()) check();
		}, CHECK_MS);
		document.addEventListener('visibilitychange', onVisible);
		check();
	};
	const stopWatching = () => {
		clearInterval(timer);
		timer = null;
		unfollow?.();
		unfollow = null;
		document.removeEventListener('visibilitychange', onVisible);
	};

	/** Gives the recovery up on this device: the temporary account goes, keys and vault together. */
	const abandon = async () => {
		const hash = temporary.value;
		stopWatching();
		setMarker(null);
		if (hash) await $userPQ.deleteAccount(hash);
	};

	return {
		deployment,
		temporary,
		active,
		progress,
		view,
		checking,
		lastError,
		checkedAt,
		pendingBlock,
		opening,
		openError,
		begin,
		load,
		check,
		restart,
		typeRequest,
		readBlock,
		confirmBlock,
		rejectBlock,
		openAccount,
		startWatching,
		stopWatching,
		abandon,
		nameOf,
	};
});

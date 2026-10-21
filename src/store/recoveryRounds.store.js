// Recovery rounds on the owner's own backup, watched while the app is open,
// and the veto (plan § 7.4, "Alerts in the app"). The round is read from the
// chain on start, every few minutes while the app is shown and whenever it
// comes back to the foreground; one at any number of devices is enough for
// the owner to stop it. The backup's secret and how it pays are read from its
// slot once and kept, and read again only when the backup changes here or
// the chain no longer has it as a live secret.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { BACKUP_SLOT, useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { ChainUnavailableError, RecoveryChain } from '@/lib/recovery/chain';
import { maybeRecoveryDeployment } from '@/lib/recovery/deployments';
import { gatewayOf } from '@/lib/recovery/gateway';
import { ownerKeyOf } from '@/lib/recovery/evmSign';
import { signBound } from '@/lib/recovery/typedData';
import { registeredSecretOf } from '@/lib/recovery/backupRun';
import { ackOf, acknowledged, alertOf, roundIsLive } from '@/lib/recovery/rounds';
import errorMessage from '@/utils/errorMessage';

const POLL_MS = 5 * 60_000;
/** A return to the foreground this soon after a check does not check again. */
const VISIBLE_GAP_MS = 30_000;
const ackKey = (owner) => `buckitup:recovery-ack:${owner}`;
const shownNow = () => typeof document === 'undefined' || document.visibilityState === 'visible';

export const useRecoveryRoundsStore = defineStore('recoveryRounds', () => {
	const $userPQ = userPQStore();
	const $backup = useRecoveryBackupStore();
	const deployment = maybeRecoveryDeployment();
	let chain = null;
	const chainOf = () => (chain ??= new RecoveryChain(deployment));
	const em = () => EncryptionManagerPQ.getInstance();

	/** The live round on the account's backup, or null. */
	const alert = ref(null);
	const ack = ref({});
	const stopping = ref(null);
	const lastError = ref(null);

	/** The round to show: live, and not one the owner said is theirs. */
	const shown = computed(() => (alert.value && !acknowledged(alert.value, ack.value) ? alert.value : null));

	const loadAck = (owner) => {
		try {
			ack.value = JSON.parse(localStorage.getItem(ackKey(owner)) ?? '{}');
		} catch {
			ack.value = {};
		}
	};

	/** The account's registered secret and its fee ({ owner, secretId, fee }), as last read; null: read the slot at the next check. */
	let backup = null;
	/** Secrets the chain says are revoked: never watched again. */
	const revoked = new Set();

	const readBackup = async (owner) => {
		if (backup?.owner === owner) return backup;
		const found = registeredSecretOf(await em().loadSlotJson(BACKUP_SLOT));
		if ($userPQ.currentUserHash !== owner) return null;
		// No backup yet is not kept: one registered on another device is found at the next check.
		backup = found && !revoked.has(found.secretId) ? { owner, ...found } : null;
		return backup;
	};

	let lastCheckAt = 0;
	const checkOnce = async (owner) => {
		lastCheckAt = Date.now();
		const b = await readBackup(owner);
		if ($userPQ.currentUserHash !== owner) return;
		if (!b?.secretId) {
			alert.value = null;
			return;
		}
		const c = chainOf();
		let state;
		try {
			state = await c.roundState(b.secretId);
		} catch (e) {
			if (e instanceof ChainUnavailableError) throw e;
			// The chain refused the question: no such secret now. Read the slot again next time.
			backup = null;
			alert.value = null;
			return;
		}
		if ($userPQ.currentUserHash !== owner) return;
		if (!roundIsLive(state)) {
			alert.value = null;
			return;
		}
		const secret = await c.readSecret(b.secretId);
		if ($userPQ.currentUserHash !== owner) return;
		if (!secret || secret.revoked) {
			if (secret?.revoked) revoked.add(b.secretId);
			backup = null;
			alert.value = null;
			return;
		}
		alert.value = alertOf(b.secretId, secret, state);
	};

	let checking = null;
	/**
	 * Reads the round of the account's backup; a chain that does not answer
	 * leaves the last answer standing. With `fresh`, a check already in flight
	 * — begun before what the caller just did — is followed by a new one.
	 */
	const check = ({ fresh = false } = {}) => {
		const owner = $userPQ.currentUserHash;
		if (!owner || !deployment) return Promise.resolve();
		if (checking && !fresh) return checking;
		const run = (checking ?? Promise.resolve())
			.then(() => checkOnce(owner))
			.catch((e) => console.warn('[recovery] round check failed:', e))
			.finally(() => {
				if (checking === run) checking = null;
			});
		checking = run;
		return run;
	};

	/** "This is me": hides this round's banner on this device, for the device it elected if any; a later round, or one electing another device, shows again. */
	const acknowledge = (a) => {
		const owner = $userPQ.currentUserHash;
		ack.value = { ...ack.value, [a.secretId]: ackOf(a) };
		localStorage.setItem(ackKey(owner), JSON.stringify(ack.value));
	};

	/** The veto: cancels the live round, through the free service or from the owner's own address, as the backup pays. */
	const stop = async (a) => {
		const owner = $userPQ.currentUserHash;
		stopping.value = a.secretId;
		lastError.value = null;
		try {
			const fee = backup?.secretId === a.secretId ? backup.fee : (await readBackup(owner))?.fee;
			const key = await ownerKeyOf(em());
			if ($userPQ.currentUserHash !== owner) return;
			const c = chainOf();
			const { body } = await signBound(c, key, 'CancelRecovery', a.secretId, {});
			await gatewayOf(c, fee, key, deployment.relayerUrl).cancelRecovery(body);
			await check({ fresh: true });
		} catch (e) {
			lastError.value = errorMessage(e);
			throw e;
		} finally {
			stopping.value = null;
		}
	};

	// The backup changed here — registered, reshared, revoked, paid another way: its secret is read again.
	// One source per value, so a record read again unchanged sets off nothing.
	watch(
		[
			() => $backup.run?.secretId,
			() => $backup.run?.step,
			() => $backup.run?.revokedAt,
			() => $backup.run?.fee?.kind,
			() => $backup.run?.fee?.url,
			() => !!$backup.reshare,
		],
		() => {
			backup = null;
			if (timer) check({ fresh: true });
		},
	);

	let timer = null;
	const onVisible = () => {
		if (shownNow() && Date.now() - lastCheckAt >= VISIBLE_GAP_MS) check();
	};
	const startWatching = () => {
		if (timer) return;
		timer = setInterval(() => {
			if (shownNow()) check();
		}, POLL_MS);
		document.addEventListener('visibilitychange', onVisible);
		check();
	};
	const stopWatching = () => {
		clearInterval(timer);
		timer = null;
		document.removeEventListener('visibilitychange', onVisible);
	};

	watch(
		() => $userPQ.currentUserHash,
		(owner) => {
			alert.value = null;
			backup = null;
			revoked.clear();
			stopWatching();
			if (owner) {
				loadAck(owner);
				startWatching();
			}
		},
		{ immediate: true },
	);

	return { alert, shown, stopping, lastError, check, acknowledge, stop, stopWatching };
});

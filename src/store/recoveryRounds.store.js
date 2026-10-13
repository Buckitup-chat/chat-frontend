// Recovery rounds on the owner's own backup, watched while the app is open,
// and the veto (plan § 7.4, "Alerts in the app"). The round is read from the
// chain on start, every few minutes and whenever the app comes back to the
// foreground; one at any number of devices is enough for the owner to stop it.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { RecoveryChain } from '@/lib/recovery/chain';
import { maybeRecoveryDeployment } from '@/lib/recovery/deployments';
import { directGateway, relayerGateway } from '@/lib/recovery/gateway';
import { signBound } from '@/lib/recovery/typedData';
import { acknowledged, alertOf } from '@/lib/recovery/rounds';
import errorMessage from '@/utils/errorMessage';

/** The community backup's record (recoveryBackup.store), read here only for the secret it registered. */
const BACKUP_SLOT = 'recovery_backup';
const POLL_MS = 5 * 60_000;
const ackKey = (owner) => `buckitup:recovery-ack:${owner}`;

export const useRecoveryRoundsStore = defineStore('recoveryRounds', () => {
	const $userPQ = userPQStore();
	const deployment = maybeRecoveryDeployment();
	let chain = null;
	const chainOf = () => (chain ??= new RecoveryChain(deployment));

	/** Live rounds on this account's secrets, by secret id. */
	const alerts = ref({});
	const ack = ref({});
	const stopping = ref(null);
	const lastError = ref(null);

	/** The rounds to show: live, and not ones the owner said are theirs. */
	const shown = computed(() => Object.values(alerts.value).filter((a) => !acknowledged(a, ack.value)));

	const loadAck = (owner) => {
		try {
			ack.value = JSON.parse(localStorage.getItem(ackKey(owner)) ?? '{}');
		} catch {
			ack.value = {};
		}
	};

	/** The registered secret of this account's backup, and how it pays, or null. */
	const backupOf = async () => {
		const rec = (await EncryptionManagerPQ.getInstance().loadSlotJson(BACKUP_SLOT))?.run;
		return rec?.secretId && ['registered', 'done'].includes(rec.step) ? { secretId: rec.secretId, fee: rec.fee } : null;
	};

	let checking = null;
	/** Reads the round of the account's backup; a chain that does not answer leaves the last answer standing. */
	const check = () => {
		const owner = $userPQ.currentUserHash;
		if (!owner || !deployment) return Promise.resolve();
		checking ??= (async () => {
			try {
				const backup = await backupOf();
				if ($userPQ.currentUserHash !== owner) return;
				if (!backup) {
					alerts.value = {};
					return;
				}
				const c = chainOf();
				const [secret, state] = await Promise.all([c.readSecret(backup.secretId), c.roundState(backup.secretId)]);
				if ($userPQ.currentUserHash !== owner) return;
				const alert = alertOf(backup.secretId, secret, state);
				alerts.value = alert ? { [backup.secretId]: alert } : {};
			} catch (e) {
				console.warn('[recovery] round check failed:', e);
			} finally {
				checking = null;
			}
		})();
		return checking;
	};

	/** "This is me": hides this round's banner on this device; a later round shows again. */
	const acknowledge = (alert) => {
		const owner = $userPQ.currentUserHash;
		ack.value = { ...ack.value, [alert.secretId]: alert.round };
		localStorage.setItem(ackKey(owner), JSON.stringify(ack.value));
	};

	/** The veto: cancels the live round, through the free service or from the owner's own address, as the backup pays. */
	const stop = async (alert) => {
		const owner = $userPQ.currentUserHash;
		stopping.value = alert.secretId;
		lastError.value = null;
		try {
			const backup = await backupOf();
			const keys = await EncryptionManagerPQ.getInstance().exportVaultKeys();
			const key = keys.evm_skey.startsWith('0x') ? keys.evm_skey : `0x${keys.evm_skey}`;
			if ($userPQ.currentUserHash !== owner) return;
			const c = chainOf();
			const { body } = await signBound(c, key, 'CancelRecovery', alert.secretId, {});
			const gateway = backup?.fee?.kind === 'self' ? directGateway(c, key) : relayerGateway(backup?.fee?.url || deployment.relayerUrl);
			await gateway.cancelRecovery(body);
			await check();
		} catch (e) {
			lastError.value = errorMessage(e);
			throw e;
		} finally {
			stopping.value = null;
		}
	};

	let timer = null;
	const onVisible = () => {
		if (document.visibilityState === 'visible') check();
	};
	const startWatching = () => {
		if (timer) return;
		timer = setInterval(check, POLL_MS);
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
			alerts.value = {};
			stopWatching();
			if (owner) {
				loadAck(owner);
				startWatching();
			}
		},
		{ immediate: true },
	);

	return { alerts, shown, stopping, lastError, check, acknowledge, stop, stopWatching };
});

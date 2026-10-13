// The end of a recovery with friends (plan § 7.5, "The finale is not
// optional"; chat repo: pq_recovery_shares § Returning, step 7). Back in the
// original account the temporary account is destroyed, keys and vault
// together — its crypt_skey opens every share returned to it, its candidate
// key still has canDecrypt until the window closes — and the backup is
// reshared: a new S makes the returned pieces and the released node half
// open nothing. Until a reshare (or a new backup, or a revocation) lands, a
// banner over every screen says so and leads into it.
//
// What this device remembers of the finale is kept in localStorage under the
// recovered account (public metadata: invariant 1), written before the import
// so that a crash between the two still ends here.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { userPQStore } from '@/store/userPQ.store';
import { useRecoveryBackupStore } from '@/store/recoveryBackup.store';
import { useRecoveryRoundsStore } from '@/store/recoveryRounds.store';

export const finaleKey = (owner) => `buckitup:recovery-finale:${owner}`;
const nowSec = () => Math.floor(Date.now() / 1000);

const readRecord = (owner) => {
	try {
		const r = JSON.parse(localStorage.getItem(finaleKey(owner)) ?? 'null');
		return r && typeof r === 'object' && typeof r.temporary === 'string' ? r : null;
	} catch {
		return null;
	}
};

/**
 * Whether the backup no longer opens with what this recovery released: a
 * later version of the same secret (a reshare), another secret (a new
 * backup), or the secret revoked for good.
 */
export const finaleDone = (record, run) => {
	if (!record || !run) return false;
	if (run.secretId === record.secretId && run.revokedAt) return true;
	if (run.step !== 'done' || run.revokedAt) return false;
	return run.secretId !== record.secretId || Number(run.version) > Number(record.version);
};

export const useRecoveryFinaleStore = defineStore('recoveryFinale', () => {
	const $userPQ = userPQStore();
	const $backup = useRecoveryBackupStore();

	/** The finale of the signed-in account, if it recovered on this device and has not finished. */
	const record = ref(null);
	const destroying = ref(false);
	const destroyError = ref(null);

	const write = (owner, r) => {
		if (r) localStorage.setItem(finaleKey(owner), JSON.stringify(r));
		else localStorage.removeItem(finaleKey(owner));
		if ($userPQ.currentUserHash === owner) record.value = r;
	};

	/** The temporary account goes from this device, keys and vault together; retried at every sign-in until it is gone. */
	// One removal at a time: the landing and the sign-in it causes both ask for one.
	let destroyingNow = null;
	const destroyTemporary = (owner = $userPQ.currentUserHash) => {
		destroyingNow ??= (async () => {
			const r = readRecord(owner);
			if (!r || r.temporaryGone) return;
			destroying.value = true;
			destroyError.value = null;
			try {
				await $userPQ.refreshMyLocalUsers?.();
				if ($userPQ.getMyUserByHash(r.temporary)) await $userPQ.deleteAccount(r.temporary);
				write(owner, { ...r, temporaryGone: true });
			} catch (e) {
				console.warn('[recovery] the temporary account could not be removed yet:', e);
				destroyError.value = e?.message ?? String(e);
			} finally {
				destroying.value = false;
			}
		})().finally(() => {
			destroyingNow = null;
		});
		return destroyingNow;
	};

	/**
	 * Lands in the recovered account: records the finale under it, imports the
	 * backup (which signs in), destroys the temporary account, and tells the
	 * round watch that the device this round elected is the owner's own. `info`
	 * is what the recovery used: { temporary, secretId, version, round,
	 * candidate, setAside } — the guardians whose returns were set aside are
	 * left out of the reshare's suggestion.
	 */
	const land = async (backup, info) => {
		const owner = backup.identity.user_hash;
		write(owner, { ...info, at: nowSec(), temporaryGone: false });
		const result = await $userPQ.importBackup({ identity: backup.identity, keys: backup.keys });
		if (result.status === 'active' && $userPQ.currentUserHash === owner) {
			record.value = readRecord(owner);
			useRecoveryRoundsStore().acknowledge({ secretId: info.secretId, round: info.round, recipient: info.candidate });
		}
		await destroyTemporary(owner);
		return result;
	};

	watch(
		() => $userPQ.currentUserHash,
		(owner) => {
			record.value = owner ? readRecord(owner) : null;
			if (record.value && !record.value.temporaryGone) destroyTemporary(owner);
		},
		{ immediate: true },
	);

	const done = computed(() => finaleDone(record.value, $backup.run));
	// Once the backup no longer opens with what was released, there is nothing left to finish.
	watch(done, (d) => {
		if (d && record.value?.temporaryGone) write($userPQ.currentUserHash, null);
	});

	/** The banner: shown until the backup was reshared, replaced or revoked, and the temporary account is gone. */
	const shown = computed(() => (record.value && (!done.value || !record.value.temporaryGone) ? record.value : null));

	/** The guardians the reshare suggests: the backup's, without those whose returns were set aside. */
	const keepGuardians = computed(() => {
		const exclude = new Set(record.value?.setAside ?? []);
		return ($backup.run?.guardians ?? []).map((g) => g.userHash).filter((h) => !exclude.has(h));
	});

	return { record, shown, done, destroying, destroyError, keepGuardians, land, destroyTemporary };
});

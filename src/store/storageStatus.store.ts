// The storage status of this device (src/lib/storageStatus.ts), shared by
// every screen that shows it, and read whenever one asks.
//
// The account's community backup is read with it on the storage screen: a
// finished, not revoked backup in the account's `recovery_backup` slot, the
// record Backup Center shows. A slot this device cannot read looks the same
// as none, so the absence of one is "not found", not "no".
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { probeStorage, requestPersistence as askPersistence, statusOf, type CommunityBackupState, type PersistRequest, type StorageEnv, type StorageProbe } from '@/lib/storageStatus';
import { isLiveBackup } from '@/components/recovery/backup/backupFlow';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { BACKUP_SLOT } from '@/store/recoveryBackup.store';
import { userPQStore } from '@/store/userPQ.store';

let env: StorageEnv | undefined;

/** Test seam: a fake browser, read by every probe from now on. */
export function _useStorageEnvForTests(fake?: StorageEnv): void {
	env = fake;
}

export const useStorageStatusStore = defineStore('storageStatus', () => {
	const $userPQ = userPQStore();
	const probe = ref<StorageProbe | null>(null);
	const lastRequest = ref<PersistRequest | null>(null);
	/** Whose backup `backup` describes: an account switch must not show the previous account's. */
	const backup = ref<{ owner: string; state: CommunityBackupState } | null>(null);
	let generation = 0;

	/** Reads the storage state again; overlapping calls keep the newest answer. */
	async function refresh(): Promise<StorageProbe> {
		const current = ++generation;
		const next = await probeStorage(env);
		if (current === generation) probe.value = next;
		return next;
	}

	/** Whether the signed-in account has a finished community backup; a slot that does not decrypt leaves it unknown. */
	async function refreshCommunityBackup(): Promise<CommunityBackupState | null> {
		const owner = $userPQ.currentUserHash;
		if (!owner) return null;
		const em = EncryptionManagerPQ.getInstance();
		let state: CommunityBackupState;
		try {
			const slot = await em.loadSlotJson(BACKUP_SLOT, { strict: true });
			state = isLiveBackup(slot?.run) ? 'yes' : 'not found';
		} catch {
			state = 'unknown';
		}
		// Read through whoever is signed in now: another account's answer is not `owner`'s.
		if (em.currentUserHash === owner) backup.value = { owner, state };
		return state;
	}

	/** The signed-in account's community backup as last read; null before a read for this account. */
	const communityBackup = computed(() => {
		const owner = $userPQ.currentUserHash;
		return owner && backup.value?.owner === owner ? backup.value.state : null;
	});

	/** Asks for persistent storage (a diagnostic; may prompt in Firefox). Only `persisted()` can change with it. */
	async function requestPersistence(): Promise<PersistRequest> {
		const result = await askPersistence(env);
		lastRequest.value = result;
		const p = probe.value;
		if (p) {
			// A read already running answers from before the request: it is dropped.
			generation += 1;
			probe.value = { ...p, persisted: result.after, status: statusOf(result.after, p.privateSignals) };
		} else {
			await refresh();
		}
		return result;
	}

	return {
		probe,
		status: computed(() => probe.value?.status ?? null),
		lastRequest,
		communityBackup,
		refresh,
		refreshCommunityBackup,
		requestPersistence,
	};
});

// The storage status of this device (src/lib/storageStatus.ts), shared by
// every screen that shows it, and read whenever one asks.
//
// The account's community backup is read with it on the storage screen: a
// finished, not revoked backup in the account's `recovery_backup` slot, the
// record Backup Center shows. A slot this device cannot read looks the same
// as none, so the absence of one is "not found", not "no". A file backup leaves no record anywhere — the
// file is handed to the browser's download and nothing remembers it — so the
// device cannot say whether one exists.
import { computed, ref } from 'vue';
import { probeStorage, requestPersistence, formatBytes, statusOf, type PersistRequest, type StorageEnv, type StorageProbe } from '@/lib/storageStatus';
import { isLiveBackup } from '@/components/recovery/backup/backupFlow';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { BACKUP_SLOT } from '@/store/recoveryBackup.store';

export type CommunityBackupState = 'yes' | 'not found' | 'unknown';

const probe = ref<StorageProbe | null>(null);
const lastRequest = ref<PersistRequest | null>(null);
/** Whose backup `communityBackup` describes: an account switch must not show the previous account's. */
const backup = ref<{ owner: string; state: CommunityBackupState } | null>(null);
let env: StorageEnv | undefined;
let generation = 0;

/** Reads the storage state again; overlapping calls keep the newest answer. */
export async function refreshStorageStatus(): Promise<StorageProbe> {
	const current = ++generation;
	const next = await probeStorage(env);
	if (current === generation) probe.value = next;
	return next;
}

/** Whether `owner` has a finished community backup; a slot that does not decrypt leaves it unknown. */
export async function refreshCommunityBackup(owner: string): Promise<CommunityBackupState> {
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

/** Asks for persistent storage (a diagnostic; may prompt in Firefox). Only `persisted()` can change with it. */
export async function requestStoragePersistence(): Promise<PersistRequest> {
	const result = await requestPersistence(env);
	lastRequest.value = result;
	const p = probe.value;
	if (p) {
		// A read already running answers from before the request: it is dropped.
		generation += 1;
		probe.value = { ...p, persisted: result.after, status: statusOf(result.after, p.privateSignals) };
	} else {
		await refreshStorageStatus();
	}
	return result;
}

const yesNo = (v: boolean | null): string => (v === null ? 'unavailable' : v ? 'yes' : 'no');
const bytes = (v: number | null): string => (v === null ? 'unavailable' : formatBytes(v));

/** The probe as label/value rows: the Details table, and the text Copy puts on the clipboard. */
export const probeRows = (p: StorageProbe, request: PersistRequest | null, communityBackup: CommunityBackupState | null): [string, string][] => {
	const rows: [string, string][] = [
		['Status', p.status],
		['persisted()', yesNo(p.persisted)],
		['Usage', bytes(p.usage)],
		['Quota', bytes(p.quota)],
		['Installed (standalone)', p.installed ? 'yes' : 'no'],
		['Private window', p.privateSignals.length ? `suspected: ${p.privateSignals.join('; ')}` : 'not detected'],
	];
	if (communityBackup) rows.push(['Community backup', communityBackup]);
	if (request) {
		rows.push(['persisted() before persist()', yesNo(request.before)]);
		rows.push(['persist() answered', request.error ? `failed: ${request.error}` : yesNo(request.granted)]);
		rows.push(['persisted() after persist()', yesNo(request.after)]);
	}
	rows.push(['Platform', p.platform || 'unavailable']);
	rows.push(['User agent', p.userAgent || 'unavailable']);
	return rows;
};

export const probeText = (rows: [string, string][]): string => rows.map(([k, v]) => `${k}: ${v}`).join('\n');

export function useStorageStatus(owner: () => string | null | undefined = () => null) {
	return {
		probe,
		status: computed(() => probe.value?.status ?? null),
		lastRequest,
		communityBackup: computed(() => {
			const o = owner();
			return o && backup.value?.owner === o ? backup.value.state : null;
		}),
		refresh: refreshStorageStatus,
		requestPersistence: requestStoragePersistence,
	};
}

/** Test seam: a fake browser, and nothing remembered from the previous test. */
export function _resetStorageStatusForTests(fake?: StorageEnv): void {
	env = fake;
	probe.value = null;
	lastRequest.value = null;
	backup.value = null;
	generation = 0;
}

// When this device last saved a backup file of an account. The file itself
// leaves the app, so this is the only trace of it: Backup Center shows the
// date and counts the account as protected by a file. Kept per device — a
// file saved on another device is not known here.
import { reactive } from 'vue';

const key = (userHash: string) => `buckitup:backup-file-saved:${userHash}`;
const cache = reactive<Record<string, number | null>>({});

/** Unix seconds of the last backup file this device saved for the account, or null. */
export function backupFileSavedAt(userHash: string | null | undefined): number | null {
	if (!userHash) return null;
	if (!(userHash in cache)) {
		const raw = Number(localStorage.getItem(key(userHash)));
		cache[userHash] = Number.isFinite(raw) && raw > 0 ? raw : null;
	}
	return cache[userHash];
}

export function rememberBackupFileSaved(userHash: string, at: number = Math.floor(Date.now() / 1000)): void {
	localStorage.setItem(key(userHash), String(at));
	cache[userHash] = at;
}

export function forgetBackupFileRecord(userHash: string): void {
	localStorage.removeItem(key(userHash));
	delete cache[userHash];
}

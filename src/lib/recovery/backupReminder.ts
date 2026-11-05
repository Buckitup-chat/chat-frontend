import { kvGet, kvSet } from '@/lib/data/localStore';

const dismissedKey = (userHash: string) => `passkey-reminder-dismissed|${userHash}`;
const fileBackupKey = (userHash: string) => `file-backup-made|${userHash}`;

export const browserDataMayBeCleared = async (storage: Pick<StorageManager, 'persisted'> | undefined = globalThis.navigator?.storage): Promise<boolean> => {
	if (typeof storage?.persisted !== 'function') return true;
	try {
		return !(await storage.persisted());
	} catch {
		return true;
	}
};

const readFlag = async (key: string): Promise<boolean> => {
	try {
		return !!(await kvGet<boolean>(key));
	} catch {
		return true;
	}
};

const writeFlag = async (key: string, userHash: string): Promise<void> => {
	try {
		await kvSet(key, true, userHash);
	} catch (e) {
		console.warn('[backup reminder] could not be saved:', e);
	}
};

export const reminderDismissed = (userHash: string): Promise<boolean> => readFlag(dismissedKey(userHash));
export const dismissReminder = (userHash: string): Promise<void> => writeFlag(dismissedKey(userHash), userHash);

export type BackupKind = 'file' | 'community' | 'passkey';
export type BackupChange = 'made' | 'removed';
type BackupListener = (userHash: string, kind: BackupKind, change: BackupChange) => void;

const backupListeners = new Set<BackupListener>();

export const onBackupChange = (listener: BackupListener): (() => void) => {
	backupListeners.add(listener);
	return () => backupListeners.delete(listener);
};

export const announceBackupMade = (userHash: string, kind: BackupKind): void => {
	for (const listener of backupListeners) listener(userHash, kind, 'made');
};

export const announceBackupRemoved = (userHash: string, kind: Exclude<BackupKind, 'file'>): void => {
	for (const listener of backupListeners) listener(userHash, kind, 'removed');
};

export const fileBackupMade = (userHash: string): Promise<boolean> => readFlag(fileBackupKey(userHash));
export const markFileBackupMade = (userHash: string): Promise<void> => {
	announceBackupMade(userHash, 'file');
	return writeFlag(fileBackupKey(userHash), userHash);
};

/** What a backup holds — the object exportBackup builds and every restore
 * path (file, shares, device link) hands to importBackup. */
export interface BackupContents {
	identity: { user_hash: string; name?: string; [key: string]: unknown };
	keys: Record<string, unknown>;
}

/** The one place that decides whether parsed data is an account backup. */
export const parseBackupContents = (data: unknown): BackupContents => {
	const d = data as Partial<BackupContents> | null;
	if (!d?.identity?.user_hash || !d.keys || typeof d.keys !== 'object') {
		throw new Error('not an account backup');
	}
	return d as BackupContents;
};

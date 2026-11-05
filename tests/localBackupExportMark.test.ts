// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _setStoreForTests } from '@/lib/data/localStore';
import { fileBackupMade } from '@/lib/recovery/backupReminder';

const H = vi.hoisted(() => ({ downloaded: [] as unknown[][] }));
vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({
		currentUser: { name: 'Alice' },
		exportBackup: async () => ({ version: 1, identity: { user_hash: 'u_alice' }, keys: {} }),
	}),
}));
vi.mock('@/utils/downloadFile', () => ({ default: (...args: unknown[]) => H.downloaded.push(args) }));

const { useLocalBackupExport } = await import('@/composables/useLocalBackupExport');

const memory = () => {
	const map = new Map<string, string>();
	return { get: async (k: string) => map.get(k) ?? null, set: async (k: string, v: string) => { map.set(k, v); }, delete: async (k: string) => { map.delete(k); }, keys: async () => [...map.keys()], clear: async () => map.clear() };
};

beforeEach(() => {
	H.downloaded = [];
	_setStoreForTests(memory());
});

describe('saving a backup file', () => {
	it('is recorded for the account once the file is handed to the browser', async () => {
		const { exportToFile, protect } = useLocalBackupExport();
		protect.value = false;
		expect(await fileBackupMade('u_alice')).toBe(false);
		expect(await exportToFile()).toBe(true);
		expect(H.downloaded).toHaveLength(1);
		await vi.waitFor(async () => expect(await fileBackupMade('u_alice')).toBe(true));
		expect(await fileBackupMade('u_bob')).toBe(false);
	});

	it('is not recorded when the form is not ready and nothing was saved', async () => {
		const { exportToFile } = useLocalBackupExport();
		expect(await exportToFile()).toBe(false);
		expect(H.downloaded).toEqual([]);
		expect(await fileBackupMade('u_alice')).toBe(false);
	});
});

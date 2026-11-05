// @vitest-environment jsdom
// Backup Center's status line: only guardians who keep enough pieces protect
// the account; a backup file saved on this device is named beside them but
// protects nothing alone. No verdict before the guardians answered.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { fakeBackupStore, makeRun } from './helpers/communityBackup';

const ME = 'u_' + 'a'.repeat(128);
const H = vi.hoisted(() => ({ store: null }));
vi.mock('@/store/recoveryBackup.store', () => ({ useRecoveryBackupStore: () => H.store }));
// The cards have their own tests; here they would only pull in the crypto stack.
vi.mock('@/components/recovery/backup/CommunityBackupCard.vue', () => ({ default: { render: () => null } }));
vi.mock('@/components/recovery/SharesIKeepCard.vue', () => ({ default: { render: () => null } }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ currentUser: { user_hash: ME }, currentUserHash: ME }) }));

const { default: Page } = await import('@/views/backup/Page_Backup_Dashboard.vue');
const { rememberBackupFileSaved, forgetBackupFileRecord } = await import('@/lib/backupFileRecord');

const render = () => mount(Page, {
	global: {
		provide: { $modal: ref({ open: vi.fn() }) },
		stubs: { FullContentBlock: { template: '<div><slot name="content" /></div>' }, UiRow: true },
	},
});
const status = (w) => w.find('[data-test="backup-status"]');

/** A finished backup whose guardians all said they store their piece. */
const liveBackup = () => {
	const run = makeRun({ step: 'done', secretId: '0x1', version: 1 });
	H.store.receipts = Object.fromEntries(run.guardians.map((g) => [g.userHash, 'stored']));
	return run;
};

beforeEach(() => {
	H.store = fakeBackupStore();
	H.store.loaded = true;
	forgetBackupFileRecord(ME);
});

describe('Backup Center status', () => {
	it('says nothing until the guardians answered', () => {
		H.store.loaded = false;
		expect(status(render()).exists()).toBe(false);
	});

	it('is not protected with neither a file nor a backup', () => {
		expect(status(render()).text()).toContain('Account not protected');
	});

	it('does not count a backup file alone as protection, and shows its date', () => {
		rememberBackupFileSaved(ME, Math.floor(Date.UTC(2026, 9, 12, 12) / 1000));
		const w = render();
		expect(status(w).text()).toContain('Account not protected');
		expect(status(w).text()).toContain('A backup file alone can be lost');
		expect(w.find('[data-test="file-saved"]').text()).toBe('saved 12 Oct');
	});

	it('counts guardians only once they keep enough pieces, and names both ways', () => {
		H.store.run = makeRun({ step: 'done', secretId: '0x1', version: 1 });
		expect(status(render()).text()).toContain('Account not protected');

		H.store.run = liveBackup();
		expect(status(render()).text()).toContain('You can get back in with your guardians.');

		rememberBackupFileSaved(ME);
		expect(status(render()).text()).toContain('You can get back in with your guardians or with your backup file.');
	});

	it('does not count a revoked backup', () => {
		H.store.run = { ...liveBackup(), revokedAt: 1_700_000_500 };
		expect(status(render()).text()).toContain('Account not protected');
	});
});

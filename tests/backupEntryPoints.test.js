// @vitest-environment jsdom
// The places outside Backup Center that offer a backup of the account lead to
// Backup Center, where every backup of the account is made: the backup icon in
// Accounts, and the Backup button of the dialog that wipes an account.
import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const alice = { user_hash: 'u_alice', name: 'Alice' };
const bob = { user_hash: 'u_bob', name: 'Bob' };
const deleted = [];
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ myLocalUsers: [alice, bob], currentUser: alice, pqUserCards: [], deleteAccount: async (hash) => { deleted.push(hash); } }) }));
vi.mock('@/store/user.store', () => ({ userStore: () => ({}) }));
// Bob keeps 2 KB of files on this device that no other account keeps.
vi.mock('@/lib/data/chunkCache', () => ({ soleKeptBytesOf: vi.fn(async (hash) => (hash === bob.user_hash ? 2048 : 0)) }));
vi.mock('@/components/Account_Item_PQ.vue', () => ({ default: { template: '<div />' } }));

const { default: AccountSelector } = await import('@/components/Account_Selector.vue');
const { default: DeleteAccount } = await import('@/components/swal/views/Swal_DeleteAccount.vue');
const chunkCache = await import('@/lib/data/chunkCache');

const harness = () => {
	const emitted = [];
	const router = { push: vi.fn() };
	const global = {
		provide: {
			$mitt: { emit: (...args) => emitted.push(args) },
			$router: router,
			$route: {},
			$swal: { fire: () => {} },
			$swalModal: {},
			$isProd: false,
			$encryptionManager: {},
			$encryptionManagerPQ: { getLocalUserCards: async () => [] },
		},
		directives: { tooltip: {} },
		stubs: { trn: { template: '<span><slot /></span>' } },
	};
	return { emitted, router, global };
};

const button = (w, label) => w.findAll('button').find((b) => b.text() === label);
// Mounted as the swal host mounts its views: the prop is what open() was given.
const wipeDialog = (account, global) => mount(DeleteAccount, { props: { data: { id: 'delete_account', data: account } }, global });

describe('the backup icon in Accounts', () => {
	it('opens Backup Center and closes the modal it sits in', async () => {
		const { emitted, router, global } = harness();
		const w = mount(AccountSelector, { global });
		await flushPromises();
		await w.find('._icon_backups').element.closest('button').click();
		expect(emitted).toEqual([['modal::close']]);
		expect(router.push).toHaveBeenCalledWith({ name: 'account_backups' });
	});
});

describe('the Backup button of the wipe dialog', () => {
	it('opens Backup Center for the signed-in account, leaving the account in place', async () => {
		const { emitted, router, global } = harness();
		const w = wipeDialog(alice, global);
		await flushPromises();
		await button(w, 'Backup').trigger('click');
		expect(emitted).toEqual([['swal::close', false], ['modal::close']]);
		expect(router.push).toHaveBeenCalledWith({ name: 'account_backups' });
	});

	it('is not offered for an account that is not signed in: its keys are not open', async () => {
		const { global } = harness();
		const w = wipeDialog(bob, global);
		await flushPromises();
		expect(button(w, 'Backup')).toBeUndefined();
		expect(w.findAll('button').map((b) => b.text())).toEqual(['Cancel', 'Delete']);
	});
});

describe('the wipe dialog', () => {
	it('says how much of what the account keeps on this device goes with it', async () => {
		const { global } = harness();
		const w = wipeDialog(bob, global);
		await flushPromises();
		expect(w.text()).toContain('Files only this account keeps on this device (2 KB) will be removed too.');
		const signedIn = wipeDialog(alice, global);
		await flushPromises();
		expect(chunkCache.soleKeptBytesOf).toHaveBeenLastCalledWith(alice.user_hash);
		expect(signedIn.text()).not.toContain('keeps on this device');
	});

	// It read the account one level too high and wiped the signed-in one instead.
	it('wipes the account it was opened for, not the signed-in one', async () => {
		const { global } = harness();
		const w = wipeDialog(bob, global);
		await flushPromises();
		await w.find('input[type=checkbox]').setValue(true);
		await button(w, 'Delete').trigger('click');
		await flushPromises();
		expect(deleted).toEqual(['u_bob']);
	});
});

// @vitest-environment jsdom
// The finale of a recovery with friends (plan § 7.5): back in the original
// account, a banner over every screen leads into a reshare — the backup's
// guardians suggested, without those whose piece was set aside — until the
// backup no longer opens with what the recovery released, and the temporary
// account is removed, retried at every sign-in until it is gone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { effectScope, nextTick, reactive } from 'vue';
import { candidate, fakeBackupStore, hash, makeRun, node } from './helpers/communityBackup';

const ORIGINAL = hash('o');
const TEMP = hash('t');
const H = vi.hoisted(() => ({ backup: null, user: null }));
vi.mock('@/store/recoveryBackup.store', () => ({ useRecoveryBackupStore: () => H.backup }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => H.user }));
vi.mock('@/store/recoveryRounds.store', () => ({ useRecoveryRoundsStore: () => ({ acknowledge: vi.fn() }) }));

const { finaleDone, finaleKey, useRecoveryFinaleStore } = await import('@/store/recoveryFinale.store');
const { default: Banner } = await import('@/components/RecoveryFinaleBanner.vue');
const { createBackupDraft } = await import('@/components/recovery/backup/backupFlow');

const SECRET = '0x' + 'ab'.repeat(32);
const record = (over = {}) => ({ temporary: TEMP, secretId: SECRET, version: 2, round: 4, candidate: '0x5a', setAside: [hash('b')], at: 1, temporaryGone: true, ...over });
const signIn = (owner) => {
	H.user.currentUserHash = owner;
};

beforeEach(() => {
	localStorage.clear();
	H.user = reactive({
		currentUserHash: null,
		myLocalUsers: [{ user_hash: ORIGINAL }],
		refreshMyLocalUsers: vi.fn(async () => {}),
		getMyUserByHash: (h) => H.user.myLocalUsers.find((u) => u.user_hash === h),
		deleteAccount: vi.fn(async (h) => {
			H.user.myLocalUsers = H.user.myLocalUsers.filter((u) => u.user_hash !== h);
		}),
	});
	H.backup = fakeBackupStore({
		run: makeRun({ step: 'done', secretId: SECRET, version: 2, guardians: ['a', 'b', 'c'].map((c) => ({ userHash: hash(c), metaAddress: 'm' })) }),
	});
	setActivePinia(createPinia());
});

describe('when the recovery is over', () => {
	it('is a later version, another backup, or a revoked one — not the version the recovery opened', () => {
		const r = record();
		expect(finaleDone(r, { step: 'done', secretId: SECRET, version: 2 })).toBe(false);
		expect(finaleDone(r, { step: 'done', secretId: SECRET, version: 3 })).toBe(true);
		expect(finaleDone(r, { step: 'done', secretId: '0x' + 'cd'.repeat(32), version: 1 })).toBe(true);
		expect(finaleDone(r, { step: 'done', secretId: SECRET, version: 2, revokedAt: 5 })).toBe(true);
		expect(finaleDone(r, { step: 'submitted', secretId: '0x' + 'cd'.repeat(32), version: 1 })).toBe(false);
		expect(finaleDone(r, null)).toBe(false);
	});
});

describe('the finale store', () => {
	it('removes a temporary account still on this device at sign-in, and records that it is gone', async () => {
		H.user.myLocalUsers.push({ user_hash: TEMP });
		localStorage.setItem(finaleKey(ORIGINAL), JSON.stringify(record({ temporaryGone: false })));
		const finale = useRecoveryFinaleStore();
		signIn(ORIGINAL);
		await flushPromises();
		expect(H.user.deleteAccount).toHaveBeenCalledWith(TEMP);
		expect(finale.record.temporaryGone).toBe(true);
		expect(JSON.parse(localStorage.getItem(finaleKey(ORIGINAL))).temporaryGone).toBe(true);
	});

	it('keeps trying when the removal fails, and says why', async () => {
		H.user.myLocalUsers.push({ user_hash: TEMP });
		H.user.deleteAccount = vi.fn(async () => {
			throw new Error('vault busy');
		});
		localStorage.setItem(finaleKey(ORIGINAL), JSON.stringify(record({ temporaryGone: false })));
		const finale = useRecoveryFinaleStore();
		signIn(ORIGINAL);
		await flushPromises();
		expect(finale.record.temporaryGone).toBe(false);
		expect(finale.destroyError).toBe('vault busy');
		expect(finale.shown).toBeTruthy();
	});

	it('lands once: the sign-in the import causes does not remove the temporary account a second time', async () => {
		H.user.myLocalUsers.push({ user_hash: TEMP });
		H.user.currentUserHash = TEMP;
		let release;
		const slow = new Promise((r) => (release = r));
		H.user.deleteAccount = vi.fn(async (h) => {
			await slow;
			H.user.myLocalUsers = H.user.myLocalUsers.filter((u) => u.user_hash !== h);
		});
		H.user.importBackup = vi.fn(async (b) => {
			H.user.currentUserHash = b.identity.user_hash;
			return { status: 'active' };
		});
		const finale = useRecoveryFinaleStore();
		const landing = finale.land({ identity: { user_hash: ORIGINAL }, keys: {} }, record({ temporaryGone: undefined }));
		await flushPromises();
		release();
		await landing;
		await flushPromises();
		expect(H.user.deleteAccount).toHaveBeenCalledTimes(1);
		expect(finale.record.temporaryGone).toBe(true);
	});

	it('suggests the backup\'s guardians without those whose piece was set aside', () => {
		localStorage.setItem(finaleKey(ORIGINAL), JSON.stringify(record()));
		signIn(ORIGINAL);
		const finale = useRecoveryFinaleStore();
		expect(finale.keepGuardians).toEqual([hash('a'), hash('c')]);
	});

	it('forgets the finale once the reshare landed and the temporary account is gone', async () => {
		localStorage.setItem(finaleKey(ORIGINAL), JSON.stringify(record()));
		signIn(ORIGINAL);
		const finale = useRecoveryFinaleStore();
		expect(finale.shown).toBeTruthy();
		H.backup.run = { ...H.backup.run, version: 3 };
		await nextTick();
		expect(finale.shown).toBeNull();
		expect(localStorage.getItem(finaleKey(ORIGINAL))).toBeNull();
	});
});

describe('the banner', () => {
	let modal;
	const render = () => mount(Banner, { global: { provide: { $modal: modal } } });
	beforeEach(() => {
		modal = { value: { open: vi.fn() } };
		localStorage.setItem(finaleKey(ORIGINAL), JSON.stringify(record()));
		signIn(ORIGINAL);
	});

	it('leads into a reshare of the backup with the guardians to keep', async () => {
		const w = render();
		expect(w.find('[data-test="finale"]').text()).toContain('Finish your recovery: renew your backup');
		await w.find('[data-test="finale-renew"]').trigger('click');
		expect(modal.value.open).toHaveBeenCalledWith({ id: 'community_backup', start: 'guardians', reshare: true, keep: [hash('a'), hash('c')] });
	});

	it('has no way to dismiss it, follows a reshare in progress, and goes once it landed', async () => {
		H.backup.reshare = makeRun({ step: 'submitted', reshareOf: { secretId: SECRET, version: 2 } });
		const w = render();
		expect(w.findAll('button').map((b) => b.text())).toEqual(['Show progress']);
		await w.find('[data-test="finale-progress"]').trigger('click');
		expect(modal.value.open).toHaveBeenCalledWith({ id: 'community_backup', start: 'progress' });
		H.backup.reshare = null;
		H.backup.run = { ...H.backup.run, version: 3 };
		await nextTick();
		expect(w.find('[data-test="finale"]').exists()).toBe(false);
	});

	it('asks for a new backup when there is none to reshare', async () => {
		H.backup.run = { ...H.backup.run, revokedAt: undefined, step: 'discarded', secretId: '0x' + 'cd'.repeat(32) };
		const w = render();
		await w.find('[data-test="finale-renew"]').trigger('click');
		expect(w.find('[data-test="finale-renew"]').text()).toBe('Make a new backup');
		expect(modal.value.open).toHaveBeenCalledWith({ id: 'community_backup', start: 'guardians' });
	});

	it('offers to remove a temporary account that is still here', async () => {
		localStorage.setItem(finaleKey(ORIGINAL), JSON.stringify(record({ temporaryGone: false })));
		H.user.deleteAccount = vi.fn(async () => {
			throw new Error('vault busy');
		});
		H.user.myLocalUsers.push({ user_hash: TEMP });
		setActivePinia(createPinia());
		const w = render();
		await flushPromises();
		expect(w.find('[data-test="finale-temporary"]').exists()).toBe(true);
		H.user.deleteAccount = vi.fn(async () => {});
		await w.find('[data-test="finale-destroy"]').trigger('click');
		await flushPromises();
		expect(H.user.deleteAccount).toHaveBeenCalledWith(TEMP);
		expect(w.find('[data-test="finale-temporary"]').exists()).toBe(false);
	});
});

describe('the reshare it leads into', () => {
	let scope;
	afterEach(() => scope?.stop());

	it('picks only the guardians to keep — also when the contacts arrive later — and starts as a reshare', async () => {
		const store = fakeBackupStore({ candidates: [], nodes: [node({ operator: hash('x') }), node({ operator: hash('y') }), node({ operator: hash('z') })] });
		scope = effectScope();
		const draft = scope.run(() => createBackupDraft(store, { reshare: true, keep: [hash('a'), hash('c')] }));
		expect(draft.state.selected).toEqual([]);
		store.candidates = ['a', 'b', 'c', 'd'].map((c) => candidate(c.toUpperCase(), 'agreed', c));
		await nextTick();
		expect(draft.state.selected).toEqual([hash('a'), hash('c')]);
		expect(draft.startPayload()).toMatchObject({ reshare: true, guardians: [{ userHash: hash('a') }, { userHash: hash('c') }] });
		// A first backup suggests everyone who agreed, and starts as one.
		const plain = scope.run(() => createBackupDraft(store));
		expect(plain.state.selected).toHaveLength(4);
		expect(plain.startPayload().reshare).toBeUndefined();
	});
});

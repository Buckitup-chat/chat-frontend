// @vitest-environment jsdom
// Account → Storage on this device: the one plain line per storage status, the
// Details table, the diagnostic persistence request and Copy.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { StorageEnv } from '@/lib/storageStatus';
import { fakeStorageEnv as env } from './helpers/storageEnv';

const H = await vi.hoisted(async () => {
	// Reactive, as the real store is: the page and the store follow the signed-in account.
	const { reactive } = await import('vue');
	return {
		slot: null as unknown,
		slotError: null as Error | null,
		duringLoad: null as (() => void) | null,
		copied: [] as string[],
		user: reactive({ currentUser: { name: 'Alice' }, currentUserHash: 'u_alice' }) as Record<string, unknown>,
	};
});
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => H.user }));
vi.mock('@/store/recoveryBackup.store', () => ({ BACKUP_SLOT: 'recovery_backup' }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() {
				return H.user.currentUserHash;
			},
			loadSlotJson: async (name: string) => {
				expect(name).toBe('recovery_backup');
				H.duringLoad?.();
				if (H.slotError) throw H.slotError;
				return H.slot;
			},
		}),
	},
}));
vi.mock('@/utils/copyToClipboard', () => ({ default: async (text: string) => (H.copied.push(text), true) }));

const { default: Page } = await import('@/views/account/Page_Account_Storage.vue');
const { _useStorageEnvForTests, useStorageStatusStore } = await import('@/store/storageStatus.store');

const FullContentBlock = defineComponent({
	setup: (_, { slots }) => () => h('div', [slots.header?.(), slots.content?.()]),
});

const render = async (fake: StorageEnv) => {
	setActivePinia(createPinia());
	_useStorageEnvForTests(fake);
	const w = mount(Page, { global: { stubs: { FullContentBlock } } });
	await flushPromises();
	return w;
};
const lineOf = (w: Awaited<ReturnType<typeof render>>) => w.find('[data-test="storage-line"]').text();
const rowsOf = (w: Awaited<ReturnType<typeof render>>) =>
	Object.fromEntries(w.findAll('[data-test="probe-table"] tr').map((tr) => tr.findAll('td').map((td) => td.text())));

beforeEach(() => {
	H.slot = null;
	H.slotError = null;
	H.duringLoad = null;
	H.user.currentUserHash = 'u_alice';
	H.copied = [];
});
afterEach(() => _useStorageEnvForTests());

describe('the plain line', () => {
	it('says the browser will not clear the data when storage is persistent', async () => {
		expect(lineOf(await render(env({ persisted: true })))).toBe('This browser will not clear your data');
	});

	it('says it may, and what protects the person, when storage is best-effort', async () => {
		expect(lineOf(await render(env({ persisted: false })))).toBe('This browser may clear your data: install the app or make a backup');
	});

	it('asks only for a backup when the app is installed already', async () => {
		expect(lineOf(await render(env({ persisted: false, installed: true })))).toBe('This browser may clear your data when storage runs low: make a backup');
	});

	it('says a private window forgets everything', async () => {
		expect(lineOf(await render(env({ quota: 50 * 1024 * 1024 })))).toBe('This window forgets everything when it closes');
	});

	it('stays neutral when the browser does not say', async () => {
		const w = await render(env({ noStorage: true }));
		expect(lineOf(w)).toBe('This browser does not say whether it may clear your data: a backup keeps the account safe');
	});
});

describe('Details', () => {
	it('shows the probe and the community backup of the signed-in account', async () => {
		H.slot = { run: { step: 'done' } };
		const rows = rowsOf(await render(env({ persisted: false })));
		expect(rows).toMatchObject({
			'persisted()': 'no',
			Usage: '1.0 KB',
			Quota: '10 GB',
			'Installed (standalone)': 'no',
			'Private window': 'not detected',
			localStorage: 'accepts writes',
			'Community backup': 'yes',
			'User agent': 'TestBrowser/1.0',
		});
	});

	it('shows a refused localStorage write on its own row, under the line of the status', async () => {
		const w = await render(env({ persisted: false, localStorage: Object.assign(new Error('the area is full'), { name: 'QuotaExceededError' }) }));
		expect(lineOf(w)).toBe('This browser may clear your data: install the app or make a backup');
		expect(rowsOf(w)).toMatchObject({ 'Private window': 'not detected', localStorage: 'refused (QuotaExceededError: the area is full)' });
	});

	it('reads the backup of the account that signs in next, and never shows the previous one\'s', async () => {
		H.slot = { run: { step: 'done' } };
		const w = await render(env());
		expect(rowsOf(w)['Community backup']).toBe('yes');
		H.slot = null;
		H.user.currentUserHash = 'u_bob';
		await nextTick();
		expect(rowsOf(w)['Community backup']).toBeUndefined();
		await flushPromises();
		expect(rowsOf(w)['Community backup']).toBe('not found');
	});

	it('does not count a revoked or unfinished backup, and says when the slot cannot be read', async () => {
		H.slot = { run: { step: 'done', revokedAt: 1 } };
		expect(rowsOf(await render(env()))['Community backup']).toBe('not found');
		H.slot = { run: { step: 'published' } };
		expect(rowsOf(await render(env()))['Community backup']).toBe('not found');
		H.slotError = new Error('Crypt key not loaded');
		expect(rowsOf(await render(env()))['Community backup']).toBe('unknown');
	});

	it('drops an answer read after the account changed', async () => {
		H.slot = { run: { step: 'done' } };
		H.duringLoad = () => {
			H.user.currentUserHash = 'u_bob';
		};
		setActivePinia(createPinia());
		const storage = useStorageStatusStore();
		await storage.refreshCommunityBackup();
		H.user.currentUserHash = 'u_alice';
		expect(storage.communityBackup).toBeNull();
	});

	it('Request persistence shows persisted() before and after, and the line follows', async () => {
		const w = await render(env({ persisted: false, grants: true }));
		await w.find('[data-test="request"]').trigger('click');
		await flushPromises();
		expect(rowsOf(w)).toMatchObject({
			'persisted() before persist()': 'no',
			'persist() answered': 'yes',
			'persisted() after persist()': 'yes',
		});
		expect(lineOf(w)).toBe('This browser will not clear your data');
	});

	it('Copy puts the table on the clipboard as text', async () => {
		const w = await render(env({ persisted: true }));
		await w.find('[data-test="copy"]').trigger('click');
		expect(H.copied).toHaveLength(1);
		expect(H.copied[0]).toContain('Status: persistent');
		expect(H.copied[0]).toContain('User agent: TestBrowser/1.0');
	});
});

// @vitest-environment jsdom
// The account menu's "Storage on this device" row carries the storage page's
// status line in a few words, read each time the menu mounts.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises, enableAutoUnmount, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { StorageEnv } from '@/lib/storageStatus';
import { fakeStorageEnv as env } from './helpers/storageEnv';

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ currentUser: { name: 'Alice', user_hash: 'u_alice' } }) }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => ({ alertingPeers: new Set() }) }));
vi.mock('@/store/recoveryBackup.store', () => ({ BACKUP_SLOT: 'recovery_backup' }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: {} }));

const { default: Menu } = await import('@/views/menu/views/Menu_Account.vue');
const { _useStorageEnvForTests } = await import('@/store/storageStatus.store');
const { useBreakpoint } = await import('@/composables/useBreakpoint');

// The menu lays out by the width useBreakpoint read last.
const resize = (px: number) => {
	Object.defineProperty(window, 'innerWidth', { value: px, configurable: true });
	useBreakpoint().init();
};

const ROW = 'Storage on this device';

const mountMenu = (fake: StorageEnv, pinia = createPinia()) => {
	setActivePinia(pinia);
	_useStorageEnvForTests(fake);
	return mount(Menu, {
		global: {
			provide: { $route: { name: 'chats' }, $mitt: { emit: () => {} } },
			stubs: { RouterLink: RouterLinkStub },
		},
	});
};

const subOf = (w: ReturnType<typeof mountMenu>) => {
	const row = w.findAll('.ui-row').find((r) => r.text().includes(ROW));
	expect(row, 'the row is in the menu').toBeTruthy();
	return row!.find('._sub');
};

const answered = async (fake: StorageEnv, pinia?: ReturnType<typeof createPinia>) => {
	const w = mountMenu(fake, pinia);
	await flushPromises();
	return subOf(w);
};

enableAutoUnmount(afterEach);
afterEach(() => {
	_useStorageEnvForTests();
	resize(1024);
});

describe('the storage row of the account menu', () => {
	it.each([
		['persistent', { persisted: true }, 'Kept by this browser'],
		['best-effort', {}, 'Browser may clear data'],
		['ephemeral', { quota: 50 * 1024 * 1024 }, 'Gone when this window closes'],
		['unknown', { noStorage: true }, 'Browser does not say'],
	])('says %s in a few words, uncoloured like the other rows', async (_, o, text) => {
		const sub = await answered(env(o));
		expect(sub.text()).toBe(text);
		expect(sub.classes()).toEqual(['_sub']);
	});

	it('keeps its second line while the browser has not answered yet', () => {
		expect(subOf(mountMenu(env())).text()).toBe('Checking…');
	});

	it('reads the status again when the menu mounts again', async () => {
		const pinia = createPinia();
		const first = mountMenu(env(), pinia);
		await flushPromises();
		expect(subOf(first).text()).toBe('Browser may clear data');
		first.unmount();
		expect((await answered(env({ persisted: true }), pinia)).text()).toBe('Kept by this browser');
	});

	it.each([
		['desktop', 1024],
		['phone', 400],
	])('appears once, in the App group, on a %s', async (_, px) => {
		resize(px);
		const w = mountMenu(env());
		await flushPromises();
		expect(w.find('._profile').exists(), 'the phone layout has the profile card').toBe(px < 768);
		expect(w.findAll('.ui-row').filter((r) => r.text().includes(ROW))).toHaveLength(1);
		const app = w.findAll('.ui-group-label').find((l) => l.text() === 'App');
		expect(app?.element.nextElementSibling?.textContent).toContain(ROW);
		expect(subOf(w).text()).toBe('Browser may clear data');
	});
});

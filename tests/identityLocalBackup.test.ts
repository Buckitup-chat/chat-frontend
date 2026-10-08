import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { defineComponent, h, type Component } from 'vue';
import { mount, flushPromises, type DOMWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { modalRegistry } from '@/components/modal/registry';

let activeStore: Record<string, unknown> = {};
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => activeStore }));

const { default: Page_Account_Info } = await import('@/views/account/Page_Account_Info.vue');
const { default: Modal_Account_Restore_Local } = await import('@/components/modal/views/Modal_Account_Restore_Local.vue');
const modalViews = import.meta.glob<{ default: Component }>('@/components/modal/views/*.vue');

const BACKUP = {
	version: 1,
	identity: { user_hash: 'u_' + 'a'.repeat(64), name: 'Alice', sign_pkey: 'spk', crypt_pkey: 'cpk' },
	keys: { sign_skey: 'c2s=', crypt_skey: 'Y3M=', evm_skey: '0xevm', contact_skey: '0xcontact', sign_pkey: 'spk', crypt_pkey: 'cpk' },
};
const PASSWORD = 'Correct-Horse-9!';

const FullContentBlock = defineComponent({
	setup: (_, { slots }) => () => h('div', [slots.header?.(), slots.content?.()]),
});

const services = () => ({
	$mitt: { emit: vi.fn() },
	$swal: { fire: vi.fn() },
	$swalModal: { value: { open: vi.fn() } },
	$router: { replace: vi.fn(), push: vi.fn() },
	$encryptionManagerPQ: {},
});
type Services = ReturnType<typeof services>;

const present = <T>(value: T | undefined, what: string): T => {
	expect(value, what).toBeTruthy();
	return value as T;
};

const buttonWith = (buttons: DOMWrapper<Element>[], text: RegExp) =>
	present(buttons.find((b) => text.test(b.text())), `a button matching ${text}`);

const mountWith = (component: Component, svc: Services, props: Record<string, unknown> = {}) =>
	mount(component, {
		props,
		global: {
			provide: svc,
			mocks: { $mitt: svc.$mitt },
			stubs: { InfoTooltip: true, Account_Info: true, FullContentBlock },
		},
	});

const openBackupFromIdentity = async (svc: Services) => {
	const page = mountWith(Page_Account_Info, svc);
	const button = present(
		page.findAll('button').find((b) => b.find('i._icon_backups').exists()),
		'Identity has a backup button',
	);
	await button.trigger('click');

	const call = present(
		svc.$mitt.emit.mock.calls.find(([event]) => event === 'modal::open'),
		'the button opens a modal',
	);
	const data = call[1] as { id: string };
	const entry = present(modalRegistry[data.id as keyof typeof modalRegistry], `modal "${data.id}" is registered`);
	const [, load] = present(
		Object.entries(modalViews).find(([path]) => path.endsWith(`/${entry.component}.vue`)),
		`the view of modal "${data.id}"`,
	);
	const { default: view } = await load();
	return mountWith(view, svc, { inputData: data });
};

const readBlob = (blob: Blob) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsText(blob);
	});

let downloads: { name: string; blob: Blob }[] = [];
beforeEach(() => {
	downloads = [];
	const blobs = new Map<string, Blob>();
	URL.createObjectURL = vi.fn((blob: Blob) => {
		const url = `blob:test/${blobs.size}`;
		blobs.set(url, blob);
		return url;
	});
	URL.revokeObjectURL = vi.fn();
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
		downloads.push({ name: this.download, blob: blobs.get(this.href) as Blob });
	});
});
afterEach(() => vi.restoreAllMocks());

describe('Identity backup → .bukitup file → restore on a clean device', () => {
	it('downloads a sealed .bukitup the restore flow on another device accepts', async () => {
		setActivePinia(createPinia());
		activeStore = { currentUser: { ...BACKUP.identity }, exportBackup: vi.fn(async () => structuredClone(BACKUP)) };
		const svcA = services();
		const modal = await openBackupFromIdentity(svcA);

		expect(modal.text()).not.toContain('BuckitUp network');
		const password = modal.find('input#password');
		expect(password.exists(), 'the export asks for a password').toBe(true);
		const download = buttonWith(modal.findAll('button'), /download/i);

		await password.setValue('short');
		await download.trigger('click');
		await flushPromises();
		expect(downloads).toHaveLength(0);
		expect(modal.text()).toContain('Must be at least 10 characters long.');

		await password.setValue(PASSWORD);
		await download.trigger('click');
		await vi.waitFor(() => expect(downloads).toHaveLength(1), { timeout: 15_000 });
		expect(svcA.$mitt.emit).toHaveBeenCalledWith('modal::close');
		expect(svcA.$swal.fire).not.toHaveBeenCalled();

		const file = present(downloads[0], 'the downloaded file');
		expect(file.name).toMatch(/^backup_\d{4}_\d{2}_\d{2}_Alice_encrypted\.bukitup$/);
		const body = await readBlob(file.blob);
		for (const secret of [BACKUP.keys.sign_skey, BACKUP.keys.crypt_skey, BACKUP.keys.evm_skey, BACKUP.keys.contact_skey]) {
			expect(body).not.toContain(secret);
		}

		setActivePinia(createPinia());
		const importBackup: Mock = vi.fn(async () => ({ status: 'active', userHash: BACKUP.identity.user_hash }));
		activeStore = { currentUser: null, getMyUserByHash: () => undefined, importBackup };
		const svcB = services();
		const restore = mountWith(Modal_Account_Restore_Local, svcB);
		const input = restore.find('input[type="file"]');
		Object.defineProperty(input.element, 'files', { value: [new File([body], file.name)] });
		await input.trigger('change');
		await vi.waitFor(() => expect(restore.find('input#password').exists()).toBe(true));

		await restore.find('input#password').setValue(PASSWORD);
		await buttonWith(restore.findAll('button'), /Decrypt and restore/).trigger('click');
		await vi.waitFor(() => expect(importBackup).toHaveBeenCalledTimes(1), { timeout: 15_000 });

		expect(importBackup.mock.calls[0]?.[0]).toEqual({ identity: BACKUP.identity, keys: BACKUP.keys });
		expect(svcB.$swal.fire).not.toHaveBeenCalled();
		expect(svcB.$router.replace).toHaveBeenCalledWith({ name: 'account_info' });
	}, 60_000);

	it('says so when the vault cannot be exported, instead of doing nothing', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		setActivePinia(createPinia());
		activeStore = {
			currentUser: { ...BACKUP.identity },
			exportBackup: vi.fn(async () => {
				throw new Error('This account has no contact key in its vault and cannot be backed up or linked.');
			}),
		};
		const svc = services();
		const modal = await openBackupFromIdentity(svc);
		await modal.find('input#password').setValue(PASSWORD);
		await buttonWith(modal.findAll('button'), /download/i).trigger('click');
		await flushPromises();

		expect(downloads).toHaveLength(0);
		expect(svc.$swal.fire).toHaveBeenCalledWith(
			expect.objectContaining({ icon: 'error', title: 'Backup error', text: expect.stringContaining('no contact key') }),
		);
	});
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import swal from '@/libs/swal';

const state = vi.hoisted(() => ({
	user: null as null | { currentUserHash: string; setContactStorageAccess: ReturnType<typeof vi.fn> },
	deviceId: 'device-a',
	intentListeners: new Set<(userHash: string) => void>(),
}));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => state.user }));
vi.mock('@/lib/data/contactVouches', async () => {
	const { readDeviceIdentity } = await import('@/lib/data/deviceOwner');
	return {
		contactAccess: {
			snapshot: async (issuerHash: string, subjectHash: string) => {
				const device = await readDeviceIdentity();
				return {
					issuerHash, subjectHash, identity: device.kind === 'identity' ? device.identity : null,
					scopes: { read: 'granted', write: 'granted' }, requests: { pending: null, last: null }, mayGrant: true,
				};
			},
		},
	};
});
vi.mock('@/lib/data/deviceOwner', () => ({ readDeviceIdentity: async () => ({ kind: 'identity', identity: { deviceId: state.deviceId, adminHash: state.user!.currentUserHash } }) }));
vi.mock('@/lib/data/intents', () => ({
	onIntentChange: (handler: (userHash: string) => void) => {
		state.intentListeners.add(handler);
		return () => state.intentListeners.delete(handler);
	},
}));
vi.mock('@/lib/data/outbox', () => ({ onOutboxChange: () => () => {} }));
const { default: Access } = await import('@/components/ContactStorageAccess.vue');

let wrapper: VueWrapper | null = null;
beforeEach(() => {
	state.deviceId = 'device-a';
	state.intentListeners.clear();
	state.user = reactive({ currentUserHash: 'issuer-a', setContactStorageAccess: vi.fn(async () => 'resolved') });
});
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	swal.close();
	vi.unstubAllGlobals();
});

const beginRevoke = async () => {
	let answer!: (result: { isConfirmed: boolean }) => void;
	const fire = vi.fn(() => new Promise<{ isConfirmed: boolean }>((resolve) => { answer = resolve; }));
	wrapper = mount(Access, { props: { userHash: 'contact-a' }, global: { provide: { $swal: { fire } } } });
	await flushPromises();
	await wrapper.find('input').setValue(false);
	expect(fire).toHaveBeenCalledOnce();
	return answer;
};

describe('a revoke confirmation stays bound to the context it was opened in', () => {
	it('shows an actionable Revoke button with the application SweetAlert defaults', async () => {
		vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
		vi.stubGlobal('scrollTo', () => {});
		wrapper = mount(Access, { props: { userHash: 'contact-a' }, global: { provide: { $swal: swal } } });
		await flushPromises();
		await wrapper.find('input').setValue(false);
		await flushPromises();
		const confirm = document.querySelector<HTMLButtonElement>('.swal2-confirm');
		expect(confirm?.textContent).toBe('Revoke');
		expect(getComputedStyle(confirm!).display).not.toBe('none');
		expect(state.user!.setContactStorageAccess).not.toHaveBeenCalled();
		confirm!.click();
		await vi.waitFor(() => expect(state.user!.setContactStorageAccess).toHaveBeenCalledWith('issuer-a', 'contact-a', false, 'device-a'));
	});

	it('does not revoke another contact when navigation happens while confirming', async () => {
		const answer = await beginRevoke();
		await wrapper!.setProps({ userHash: 'contact-b' });
		await flushPromises();
		answer({ isConfirmed: true });
		await flushPromises();
		expect(state.user!.setContactStorageAccess).not.toHaveBeenCalled();
	});
	it('does not revoke permissions from a different account after account switching', async () => {
		const answer = await beginRevoke();
		state.user!.currentUserHash = 'issuer-b';
		await flushPromises();
		answer({ isConfirmed: true });
		await flushPromises();
		expect(state.user!.setContactStorageAccess).not.toHaveBeenCalled();
	});

	it('is dropped when the backend answers as another device while the dialog is open', async () => {
		const answer = await beginRevoke();
		state.deviceId = 'device-b';
		for (const notify of state.intentListeners) notify('issuer-a');
		await flushPromises();
		answer({ isConfirmed: true });
		await flushPromises();
		expect(state.user!.setContactStorageAccess).not.toHaveBeenCalled();
	});

	it('is dropped when the page is closed while the dialog is open', async () => {
		const answer = await beginRevoke();
		wrapper!.unmount();
		wrapper = null;
		answer({ isConfirmed: true });
		await flushPromises();
		expect(state.user!.setContactStorageAccess).not.toHaveBeenCalled();
	});

	it('goes out once with the context it was opened in when nothing changed', async () => {
		const answer = await beginRevoke();
		answer({ isConfirmed: true });
		await flushPromises();
		expect(state.user!.setContactStorageAccess).toHaveBeenCalledTimes(1);
		expect(state.user!.setContactStorageAccess).toHaveBeenCalledWith('issuer-a', 'contact-a', false, 'device-a');
	});
});

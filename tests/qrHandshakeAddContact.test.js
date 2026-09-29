// @vitest-environment jsdom
// A contact the server does not take is not reported as added: the person is
// told what went wrong, and the modal stays open on the contact, with no
// success message and no move to the contact page.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

const A = 'u_' + 'a'.repeat(128);
let store;

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => store }));
vi.mock('@/lib/pq/verifyCard', () => ({ cardVouchesForContactKey: () => true }));
vi.mock('@/components/Account_Item.vue', () => ({ default: { render: () => null } }));
// The scanner engine stands in for the handshake: `completed` is what it emits.
const ScannerEngine = defineComponent({
	emits: ['completed', 'scanning', 'countdown'],
	setup(_, { expose }) {
		expose({ toggleScanner: async () => {}, stopScan: () => {} });
		return () => h('div', { class: 'scanner-stub' });
	},
});
vi.mock('@/components/engines/QRScannerEngine.vue', () => ({ default: ScannerEngine }));

const { default: Modal_QrHandshake } = await import('@/components/modal/views/Modal_QrHandshake.vue');

let swal;
let mitt;
let router;

const mountModal = async () => {
	const wrapper = mount(Modal_QrHandshake, {
		global: { provide: { $swal: swal, $mitt: mitt, $router: router } },
	});
	await flushPromises();
	return wrapper;
};

const buttonNamed = (wrapper, text) => wrapper.findAll('button').find((b) => b.text().includes(text));

beforeEach(() => {
	swal = { fire: vi.fn() };
	mitt = { emit: vi.fn() };
	router = { push: vi.fn() };
	store = {
		currentUserHash: 'u_' + '1'.repeat(128),
		contactsMap: {},
		allNetworkUsers: [{ user_hash: A, name: 'Ann', contact_pkey: 'pkA' }],
		saveContact: vi.fn(async () => { throw new Error('The contacts slot on the server cannot be read; nothing was written'); }),
		confirmContact: vi.fn(async () => { throw new Error('Saved on this device, but the server did not take it'); }),
	};
	Object.defineProperty(navigator, 'mediaDevices', {
		configurable: true,
		value: { enumerateDevices: async () => [{ kind: 'videoinput' }] },
	});
});

const expectErrorShownAndModalKept = (message) => {
	expect(swal.fire).toHaveBeenCalledTimes(1);
	expect(swal.fire).toHaveBeenCalledWith(expect.objectContaining({ icon: 'error', title: 'Contact not saved', text: message }));
	expect(mitt.emit).not.toHaveBeenCalledWith('modal::close');
	expect(router.push).not.toHaveBeenCalled();
};

describe('adding a contact the server does not take', () => {
	it('shows the error for a contact added by id, and keeps the modal open', async () => {
		const wrapper = await mountModal();
		await buttonNamed(wrapper, 'Add manually').trigger('click');
		await wrapper.find('input').setValue(A);
		await wrapper.findAll('button').find((b) => b.text() === 'Add').trigger('click');
		await flushPromises();

		expect(store.saveContact).toHaveBeenCalled();
		expectErrorShownAndModalKept('The contacts slot on the server cannot be read; nothing was written');
	});

	it('shows the error when confirming an existing contact through the handshake, and keeps the modal open', async () => {
		store.contactsMap = { [A]: { user_hash: A, name: 'Ann', contact_pkey: 'pkA' } };
		const wrapper = await mountModal();
		wrapper.findComponent(ScannerEngine).vm.$emit('completed', { user_hash: A, name: 'Ann', contact_pkey: 'pkA' });
		await flushPromises();
		await buttonNamed(wrapper, 'Open contact').trigger('click');
		await flushPromises();

		expect(store.confirmContact).toHaveBeenCalledWith(A, 'pkA');
		expectErrorShownAndModalKept('Saved on this device, but the server did not take it');
		expect(wrapper.text()).toContain('Existing contact'); // still on the contact, ready to try again
	});
});

// @vitest-environment jsdom
// The add-contact modal: what it does with the handshake's result
// (docs/task-handshake-pq2.md §6), and a contact the server does not take is
// not reported as added — the person is told what went wrong, and the modal
// stays open on the contact, with no success message and no move to the
// contact page.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

const A = 'u_' + 'a'.repeat(128);
let store;

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => store }));
const prefetchRelay = vi.fn(async () => {});
vi.mock('@/lib/data/turnCredentials', () => ({ prefetchRelay: () => prefetchRelay() }));
vi.mock('@/components/Account_Item.vue', () => ({ default: { render: () => null } }));
// The scanner engine stands in for the handshake: `completed` is what it emits.
const ScannerEngine = defineComponent({
	emits: ['completed', 'scanning'],
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

/** What the scanner emits at the end of a handshake. */
const CARD = { user_hash: A, name: 'Ann', contact_pkey: 'pkA', sign_b64: 'sig' };
const confirmedResult = () => ({ user_hash: A, name: 'Ann', contact_pkey: 'pkA', confirmed: true, card: CARD, sas: '042917', cause: null });
const verifiedResult = (cause = 'no-channel') => ({
	user_hash: A, name: 'Ann', contact_pkey: 'pkA', confirmed: false, card: null, sas: '042917',
	cause,
});

const completeWith = async (wrapper, result) => {
	wrapper.findComponent(ScannerEngine).vm.$emit('completed', result);
	await flushPromises();
};

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
		wrapper.findComponent(ScannerEngine).vm.$emit('completed', confirmedResult());
		await flushPromises();
		await buttonNamed(wrapper, 'Open contact').trigger('click');
		await flushPromises();

		expect(store.confirmContact).toHaveBeenCalledWith(A, CARD, 'pkA');
		expectErrorShownAndModalKept('Saved on this device, but the server did not take it');
		expect(wrapper.text()).toContain('Existing contact'); // still on the contact, ready to try again
	});
});

describe('what the modal does with the handshake\'s result', () => {
	beforeEach(() => {
		store.saveContact = vi.fn(async () => ({ status: 'synced' }));
		store.confirmContact = vi.fn(async () => ({ status: 'synced' }));
		prefetchRelay.mockClear();
	});

	it('asks for the relay credentials when it opens, one screen before the scanner — when there is a camera', async () => {
		await mountModal();
		expect(prefetchRelay).toHaveBeenCalledTimes(1);
		prefetchRelay.mockClear();
		Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices: async () => [] } });
		await mountModal();
		expect(prefetchRelay).not.toHaveBeenCalled();
	});

	it('confirmed, and not a contact yet: confirms it with the verified card, and shows the six digits', async () => {
		const wrapper = await mountModal();
		await completeWith(wrapper, confirmedResult());
		expect(wrapper.find('[data-test="contact-sas"]').text()).toBe('042917');
		expect(wrapper.text()).toContain('Contact confirmed');
		await buttonNamed(wrapper, 'Save contact').trigger('click');
		await flushPromises();
		expect(store.confirmContact).toHaveBeenCalledWith(A, CARD, 'pkA', { name: 'Ann', notes: '', hidden: false });
		expect(store.saveContact).not.toHaveBeenCalled();
		expect(swal.fire).toHaveBeenCalledWith(expect.objectContaining({ icon: 'success', title: 'Contact added and confirmed', text: 'Code 042917' }));
		expect(router.push).toHaveBeenCalledWith({ name: 'contact', params: { address: A } });
		expect(store.allNetworkUsers).toHaveLength(1); // nothing written into the network users
	});

	it('confirmed, and already a contact: confirms it', async () => {
		store.contactsMap = { [A]: { user_hash: A, name: 'Ann', contact_pkey: 'pkA' } };
		const wrapper = await mountModal();
		await completeWith(wrapper, confirmedResult());
		await buttonNamed(wrapper, 'Open contact').trigger('click');
		await flushPromises();
		expect(store.confirmContact).toHaveBeenCalledWith(A, CARD, 'pkA');
		expect(swal.fire).toHaveBeenCalledWith(expect.objectContaining({ title: 'Contact confirmed' }));
	});

	it('not confirmed, and new: saves it unconfirmed with the key proved in person, and says why it is not confirmed', async () => {
		const wrapper = await mountModal();
		await completeWith(wrapper, verifiedResult());
		expect(wrapper.text()).toContain('Key verified in person; not yet confirmed');
		expect(wrapper.text()).toContain('Check that both phones are online, or scan again on a shared Wi-Fi.');
		await buttonNamed(wrapper, 'Save contact').trigger('click');
		await flushPromises();
		expect(store.confirmContact).not.toHaveBeenCalled();
		expect(store.saveContact).toHaveBeenCalledWith(A, { name: 'Ann', notes: '', hidden: false, contact_pkey: 'pkA' });
		expect(swal.fire).toHaveBeenCalledWith(expect.objectContaining({
			icon: 'warning',
			title: 'Key verified in person; not yet confirmed',
			footer: 'Check that both phones are online, or scan again on a shared Wi-Fi.',
		}));
	});

	it('not confirmed, and already a contact: writes nothing, and says it is not confirmed', async () => {
		store.contactsMap = { [A]: { user_hash: A, name: 'Ann', contact_pkey: 'pkA' } };
		const wrapper = await mountModal();
		await completeWith(wrapper, verifiedResult('refused'));
		await buttonNamed(wrapper, 'Open contact').trigger('click');
		await flushPromises();
		expect(store.confirmContact).not.toHaveBeenCalled();
		expect(store.saveContact).not.toHaveBeenCalled();
		expect(swal.fire).toHaveBeenCalledWith(expect.objectContaining({
			title: 'Key verified in person; not yet confirmed',
			footer: 'Their profile card does not certify the key their phone showed: this is not confirmed as their account.',
		}));
	});

	it('names each cause the engine gives, a deleted account among them', async () => {
		for (const [cause, text] of [
			['deleted', 'This account is deleted: a deleted account cannot be confirmed.'],
			['peer-unable', 'The other phone could not confirm its account'],
			['no-signature', 'This phone could not sign the confirmation'],
			['no-confirmation', 'the other one sent no confirmation'],
		]) {
			const wrapper = await mountModal();
			await completeWith(wrapper, verifiedResult(cause));
			expect(wrapper.text(), cause).toContain(text);
			wrapper.unmount();
		}
	});

	it('refuses a handshake with the signed-in account itself before anything is saved', async () => {
		store.currentUserHash = A;
		const wrapper = await mountModal();
		await completeWith(wrapper, confirmedResult());
		await buttonNamed(wrapper, 'Save contact').trigger('click');
		await flushPromises();
		expect(store.confirmContact).not.toHaveBeenCalled();
		expect(store.saveContact).not.toHaveBeenCalled();
		expect(swal.fire).toHaveBeenCalledWith(expect.objectContaining({ title: 'It`s your own account' }));
	});

	it('tells to hold the phones 25–40 cm apart', async () => {
		const wrapper = await mountModal();
		expect(wrapper.text()).toMatch(/25–40 cm/);
	});
});

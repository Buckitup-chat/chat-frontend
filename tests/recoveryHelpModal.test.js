// @vitest-environment jsdom
// "Help someone recover" (plan § 7.5), the guardian's screens: the code and
// the piece, the wait for the answer, the ten words compared on the call —
// approval only when they match — and, for a piece returned by hand, the
// request and answer as text and the sealed piece with its six digits.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));
const OWNER = 'u_' + 'o'.repeat(128);
const TEMP = 'u_' + 'e'.repeat(128);
const H = vi.hoisted(() => ({ store: null }));
vi.mock('@/store/recoveryHelp.store', () => ({ useRecoveryHelpStore: () => H.store }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ contactsMap: { [OWNER]: { name: 'Daria' } }, getUserByHash: () => null }) }));

const { default: Modal } = await import('@/components/modal/views/Modal_Recovery_Help.vue');

const words = ['zoo', 'wrist', 'year', 'arm', 'bone', 'cage', 'dash', 'echo', 'fog', 'gift'];
const holding = { key: 'k1', owner: OWNER, share: { version: 2, shareIndex: 3 }, state: 'stored' };
let mitt;
const render = (inputData = {}) => mount(Modal, { props: { inputData }, global: { provide: { $mitt: mitt } } });

beforeEach(() => {
	vi.useFakeTimers();
	mitt = { emit: vi.fn() };
	H.store = reactive({
		helpable: [holding],
		sessions: {},
		load: vi.fn(async () => {}),
		ask: vi.fn(async ({ peer, holdingKey }) => ({ key: `${holdingKey}|${peer}`, mode: 'dialog', peer, step: 'asked' })),
		askByText: vi.fn(async ({ holdingKey }) => ({ session: { key: `${holdingKey}|text:1`, mode: 'text', step: 'asked' }, text: 'I am helping you … eip155:1:0xabc/0xdef' })),
		bindingOf: vi.fn(async () => null),
		typedBinding: vi.fn(() => ({ candidate: '0x5a', peer: TEMP, words })),
		approve: vi.fn(async (s) => ({ ...s, step: 'approved' })),
		cancel: vi.fn(async () => {}),
		sealFor: vi.fn(async () => ({ block: 'BUCKITUP-SHARE.kem.sealed.u_x.sig', digits: '042917' })),
		markSent: vi.fn(async () => {}),
	});
});
afterEach(() => vi.useRealTimers());

const askInApp = async (w) => {
	await w.find('[data-test="help-code"]').setValue(TEMP);
	await w.find('[data-test="help-ask"]').trigger('click');
	await flushPromises();
};

describe('helping in the app', () => {
	it('asks with the code and the one piece kept, then waits for the answer', async () => {
		const w = render();
		await flushPromises();
		expect(w.find('[data-test="help-holding"]').text()).toContain('Daria');
		await askInApp(w);
		expect(H.store.ask).toHaveBeenCalledWith({ peer: TEMP, holdingKey: 'k1' });
		expect(w.text()).toContain('Waiting for their app to answer');

		H.store.bindingOf = vi.fn(async () => ({ candidate: '0x5a', peer: TEMP, words }));
		await vi.advanceTimersByTimeAsync(4000);
		await flushPromises();
		expect(w.findAll('[data-test="help-words"] li').map((l) => l.text())).toEqual(words);
		expect(H.store.approve).not.toHaveBeenCalled();
	});

	it('reads their dialog again only after the last read ended, and stops when closed', async () => {
		let release;
		H.store.bindingOf = vi.fn(() => new Promise((r) => (release = r)));
		const w = render();
		await flushPromises();
		await w.find('[data-test="help-code"]').setValue(TEMP);
		w.find('[data-test="help-ask"]').trigger('click');
		await flushPromises();
		expect(H.store.bindingOf).toHaveBeenCalledTimes(1);
		// A slow read: no second one starts beside it.
		await vi.advanceTimersByTimeAsync(12_000);
		expect(H.store.bindingOf).toHaveBeenCalledTimes(1);
		release(null);
		await flushPromises();
		await vi.advanceTimersByTimeAsync(4000);
		expect(H.store.bindingOf).toHaveBeenCalledTimes(2);
		w.unmount();
		release(null);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(H.store.bindingOf).toHaveBeenCalledTimes(2);
	});

	it('approves the candidate it checked only when the words match', async () => {
		H.store.bindingOf = vi.fn(async () => ({ candidate: '0x5a', peer: TEMP, words }));
		const w = render();
		await flushPromises();
		await askInApp(w);
		await w.find('[data-test="help-match"]').trigger('click');
		await flushPromises();
		expect(H.store.approve).toHaveBeenCalledWith(expect.objectContaining({ peer: TEMP }), { candidate: '0x5a', peer: TEMP, words });
		expect(w.find('[data-test="help-approved"]').text()).toContain('sends your piece to them by itself');
	});

	it('approves nothing when the words differ, and forgets the request', async () => {
		H.store.bindingOf = vi.fn(async () => ({ candidate: '0x5a', peer: TEMP, words }));
		const w = render();
		await flushPromises();
		await askInApp(w);
		await w.find('[data-test="help-differ"]').trigger('click');
		await flushPromises();
		expect(H.store.approve).not.toHaveBeenCalled();
		expect(H.store.cancel).toHaveBeenCalled();
		expect(w.find('[data-test="help-differ-note"]').exists()).toBe(true);
	});

	it('says why an answer cannot be trusted, and why an approval did not go', async () => {
		H.store.bindingOf = vi.fn(async () => {
			throw new Error('Their answer does not check out. Do not approve.');
		});
		let w = render();
		await flushPromises();
		await askInApp(w);
		expect(w.find('[data-test="help-error"]').text()).toContain('Do not approve');

		H.store.bindingOf = vi.fn(async () => ({ candidate: '0x5a', peer: TEMP, words }));
		H.store.approve = vi.fn(async () => {
			throw new Error('Enough guardians already approved a device without you.');
		});
		w = render();
		await flushPromises();
		await askInApp(w);
		await w.find('[data-test="help-match"]').trigger('click');
		await flushPromises();
		expect(w.find('[data-test="help-error"]').text()).toContain('Enough guardians');
	});
});

describe('helping by another messenger', () => {
	it('gives the request as text, checks the answer pasted back, and compares the words', async () => {
		const w = render();
		await flushPromises();
		await w.find('[data-test="help-by-text"]').setValue(true);
		await w.find('[data-test="help-ask"]').trigger('click');
		await flushPromises();
		expect(w.text()).toContain('eip155:1:0xabc/0xdef');
		await w.find('[data-test="help-binding"]').setValue('BUCKITUP-BINDING.x');
		await w.find('[data-test="help-binding-read"]').trigger('click');
		await flushPromises();
		expect(H.store.typedBinding).toHaveBeenCalledWith(expect.objectContaining({ mode: 'text' }), 'BUCKITUP-BINDING.x');
		await w.find('[data-test="help-match"]').trigger('click');
		await flushPromises();
		expect(w.find('[data-test="help-approved"]').text()).toContain('make the piece');
	});

	it('makes the piece with its six digits, and records it sent', async () => {
		H.store.sessions = { s1: { key: 's1', mode: 'text', step: 'ready', peer: TEMP } };
		const w = render({ sessionKey: 's1' });
		await flushPromises();
		expect(H.store.sealFor).toHaveBeenCalledWith(H.store.sessions.s1);
		expect(w.find('[data-test="help-digits"]').text()).toBe('042917');
		await w.find('[data-test="help-sent"]').trigger('click');
		await flushPromises();
		expect(H.store.markSent).toHaveBeenCalled();
		expect(mitt.emit).toHaveBeenCalledWith('modal::close');
	});

	it('makes no piece before the window', async () => {
		H.store.sessions = { s1: { key: 's1', mode: 'text', step: 'approved', peer: TEMP } };
		H.store.sealFor = vi.fn(async () => {
			throw new Error('Not yet: the waiting period is not over.');
		});
		const w = render({ sessionKey: 's1' });
		await flushPromises();
		expect(w.find('[data-test="help-error"]').text()).toContain('Not yet');
		expect(w.find('[data-test="help-sealed"]').exists()).toBe(false);
	});
});

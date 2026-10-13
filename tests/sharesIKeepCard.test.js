// @vitest-environment jsdom
// "Shares I keep" on Security & Recovery: each piece under the contact who
// sent it, with its state; an empty state; and Give back after a prompt.
// Shown, it reads the slot again and checks the pieces on chain.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));
const H = vi.hoisted(() => ({ store: null, help: null }));
const OWNER = 'u_' + 'o'.repeat(128);
const STRANGER = 'u_' + 's'.repeat(128);
vi.mock('@/store/recoveryHoldings.store', () => ({ useRecoveryHoldingsStore: () => H.store }));
vi.mock('@/store/recoveryHelp.store', () => ({ useRecoveryHelpStore: () => H.help }));
vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ contactsMap: { [OWNER]: { name: 'Daria' } }, getUserByHash: () => null }),
}));

const { default: Card } = await import('@/components/recovery/SharesIKeepCard.vue');

const share = (over = {}) => ({ secretRef: 'x/0x1', version: 2, splitId: 's', shareIndex: 3, shareB64: 'AAAA', ...over });
const held = (key, over = {}) => ({ key, owner: OWNER, share: share(), messageId: 'm', state: 'stored', detail: '', updatedAt: 1, ...over });

let swal;
let modal;
const render = () => mount(Card, { global: { provide: { $swal: swal, $modal: modal } } });
const rows = (w) => w.findAll('[data-test="kept-row"]');

beforeEach(() => {
	H.store = reactive({
		loaded: true,
		list: [],
		load: vi.fn(async () => {}),
		sweep: vi.fn(async () => ({ read: false })),
		giveBack: vi.fn(async () => ({ queued: false })),
	});
	swal = { fire: vi.fn(async () => ({ isConfirmed: true })) };
	modal = { value: { open: vi.fn() } };
	H.help = reactive({ deployment: {}, helpable: [], list: [], load: vi.fn(async () => {}), tick: vi.fn(async () => null) });
});

describe('Shares I keep', () => {
	it('checks the pieces when shown, reads the slot once, and says when there are none', async () => {
		const w = render();
		await flushPromises();
		expect(H.store.sweep).toHaveBeenCalledWith({ force: true });
		expect(H.store.load).toHaveBeenCalledWith({ refresh: true });
		expect(w.find('[data-test="empty"]').text()).toContain("You keep no one's backup piece.");

		// The sweep read the slot: no second read.
		H.store.sweep = vi.fn(async () => ({ read: true }));
		H.store.load = vi.fn(async () => {});
		render();
		await flushPromises();
		expect(H.store.load).not.toHaveBeenCalled();
	});

	it('lists each piece under the contact who sent it, with its version and state', async () => {
		H.store.list = [
			held('k1'),
			held('k2', { owner: STRANGER, state: 'unverified', detail: 'the share does not match its leaf' }),
			held('k3', { state: 'given_back', share: share({ shareB64: '' }) }),
		];
		const w = render();
		await flushPromises();
		expect(rows(w).map((r) => r.text())).toEqual([
			expect.stringMatching(/Daria.*Version 2 · piece 3.*stored ✓.*Give back/),
			expect.stringMatching(/u_ssssssss….*problem: the share does not match its leaf.*Give back/),
			expect.stringMatching(/Daria.*given back$/),
		]);
		expect(w.text()).toContain('the network does not say whose backup it belongs to');
	});

	it('gives a piece back only after the prompt is confirmed', async () => {
		H.store.list = [held('k1')];
		const w = render();
		await flushPromises();
		swal.fire.mockResolvedValueOnce({ isConfirmed: false });
		await w.find('[data-test="give-back"]').trigger('click');
		await flushPromises();
		expect(H.store.giveBack).not.toHaveBeenCalled();
		expect(swal.fire.mock.calls[0][0].title).toBe("Give back Daria's backup piece?");

		await w.find('[data-test="give-back"]').trigger('click');
		await flushPromises();
		expect(H.store.giveBack).toHaveBeenCalledWith('k1');
	});

	it('says why it could not read the slot, and why a give-back failed', async () => {
		H.store.load = vi.fn(async () => { throw new Error('vault locked'); });
		const failed = render();
		await flushPromises();
		expect(failed.find('[data-test="load-error"]').text()).toContain('vault locked');

		H.store.load = vi.fn(async () => {});
		H.store.list = [held('k1')];
		H.store.giveBack = vi.fn(async () => { throw new Error('offline'); });
		const w = render();
		await flushPromises();
		await w.find('[data-test="give-back"]').trigger('click');
		await flushPromises();
		expect(w.find('[data-test="action-error"]').text()).toContain('offline');
	});

	it('says a piece given back offline reaches its owner once online', async () => {
		H.store.list = [held('k1')];
		H.store.giveBack = vi.fn(async () => ({ queued: true }));
		const w = render();
		await flushPromises();
		await w.find('[data-test="give-back"]').trigger('click');
		await flushPromises();
		expect(w.find('[data-test="notice"]').text()).toBe('Your copy is removed. Daria is told when you are online again.');
		expect(w.find('[data-test="action-error"]').exists()).toBe(false);
	});
});

describe('helping someone recover', () => {
	it('opens the help when a piece can be returned, and applies the send gate when shown', async () => {
		let w = render();
		await flushPromises();
		expect(w.find('[data-test="help-someone"]').exists()).toBe(false);
		expect(H.help.tick).toHaveBeenCalled();
		H.help.helpable = [held('k1')];
		w = render();
		await flushPromises();
		await w.find('[data-test="help-someone"]').trigger('click');
		expect(modal.value.open).toHaveBeenCalledWith({ id: 'recovery_help' });
	});

	it('lists each help with where it stands, and the piece to make for one returned by hand', async () => {
		H.help.list = [
			{ key: 'a', owner: OWNER, mode: 'dialog', step: 'approved' },
			{ key: 'b', owner: OWNER, mode: 'text', step: 'ready' },
			{ key: 'c', owner: STRANGER, mode: 'dialog', step: 'stopped', reason: 'the recovery was stopped' },
			{ key: 'd', owner: OWNER, mode: 'dialog', step: 'sent' },
		];
		const w = render();
		await flushPromises();
		expect(w.findAll('[data-test="help-row"]').map((r) => r.text())).toEqual([
			expect.stringMatching(/Daria.*your piece goes to them once the waiting period is over/),
			expect.stringMatching(/Daria.*ready: make the piece.*Make the piece/),
			expect.stringMatching(/stopped: the recovery was stopped/),
			expect.stringMatching(/Daria.*your piece was sent/),
		]);
		await w.find('[data-test="help-make"]').trigger('click');
		expect(modal.value.open).toHaveBeenCalledWith({ id: 'recovery_help', sessionKey: 'b' });
	});
});

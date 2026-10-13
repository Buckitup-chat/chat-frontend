// @vitest-environment jsdom
// "Shares I keep" on Security & Recovery: each piece under the contact who
// sent it, with its state; an empty state; and Give back after a prompt.
// Shown, it reads the slot again and checks the pieces on chain.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';

vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));
const H = vi.hoisted(() => ({ store: null }));
const OWNER = 'u_' + 'o'.repeat(128);
const STRANGER = 'u_' + 's'.repeat(128);
vi.mock('@/store/recoveryHoldings.store', () => ({ useRecoveryHoldingsStore: () => H.store }));
vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ contactsMap: { [OWNER]: { name: 'Daria' } }, getUserByHash: () => null }),
}));

const { default: Card } = await import('@/components/recovery/SharesIKeepCard.vue');

const share = (over = {}) => ({ secretRef: 'x/0x1', version: 2, splitId: 's', shareIndex: 3, shareB64: 'AAAA', ...over });
const held = (key, over = {}) => ({ key, owner: OWNER, share: share(), messageId: 'm', state: 'stored', detail: '', updatedAt: 1, ...over });

let swal;
const render = () => mount(Card, { global: { provide: { $swal: swal } } });
const rows = (w) => w.findAll('[data-test="kept-row"]');

beforeEach(() => {
	H.store = reactive({
		loaded: true,
		list: [],
		load: vi.fn(async () => {}),
		sweep: vi.fn(async () => ({ read: false })),
		giveBack: vi.fn(async () => {}),
	});
	swal = { fire: vi.fn(async () => ({ isConfirmed: true })) };
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
});

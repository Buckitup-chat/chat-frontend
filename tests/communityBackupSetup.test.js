// @vitest-environment jsdom
// The setup screens of a community backup (design §§ 3–6): the guardian
// picker and its rules, Advanced's approvals rule, which nodes can be picked,
// and the fee once a backup outgrows the free service. The draft and the rules
// under it are real; only the store's network is faked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { effectScope } from 'vue';
import { candidate, fakeBackupStore, fakeNav, hash, node } from './helpers/communityBackup';

const H = vi.hoisted(() => ({ store: null, invites: null, user: null, router: null }));
vi.mock('@/store/recoveryBackup.store', () => ({ useRecoveryBackupStore: () => H.store }));
vi.mock('@/store/recoveryInvites.store', () => ({ useRecoveryInvitesStore: () => H.invites }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => H.user }));
vi.mock('vue-router', () => ({ useRouter: () => H.router }));
vi.mock('@/utils/copyToClipboard', () => ({ default: vi.fn(async () => true) }));

const { DRAFT, NAV, createBackupDraft } = await import('@/components/recovery/backup/backupFlow');
const { default: Screen_Guardians } = await import('@/components/recovery/backup/Screen_Guardians.vue');
const { default: Screen_Advanced } = await import('@/components/recovery/backup/Screen_Advanced.vue');
const { default: Screen_Nodes } = await import('@/components/recovery/backup/Screen_Nodes.vue');
const { default: Screen_Fee } = await import('@/components/recovery/backup/Screen_Fee.vue');

const DARIA = candidate('Daria', 'agreed', 'd');
const MILO = candidate('Milo', 'agreed', 'm');
const VITALII = candidate('Vitalii', 'agreed', 'v');
const IVAN = candidate('Ivan', 'agreed', 'i');
const threeOperators = () => [node({ operator: hash('x') }), node({ operator: hash('y') }), node({ operator: hash('z') })];

let scope, draft, nav;
const setup = (storeOver = {}) => {
	H.store = fakeBackupStore({ candidates: [DARIA, MILO, VITALII, IVAN], nodes: threeOperators(), ...storeOver });
	H.invites = { invite: vi.fn(async () => {}) };
	H.user = { contactsMap: { [DARIA.userHash]: { name: 'Daria' } }, currentUserHash: hash('o') };
	H.router = { push: vi.fn() };
	scope = effectScope();
	draft = scope.run(() => createBackupDraft(H.store));
	nav = fakeNav();
};
const render = (C) => mount(C, { global: { provide: { [DRAFT]: draft, [NAV]: nav } } });
const at = (w, sel) => w.find(`[data-test="${sel}"]`);
const rowOf = (w, name) => w.findAll('[data-test="agreed-row"]').find((r) => r.text().includes(name));

afterEach(() => scope?.stop());

describe('Simple: the guardian picker', () => {
	beforeEach(() => setup());

	it('says "any N of M" and recounts on every pick', async () => {
		const w = render(Screen_Guardians);
		expect(at(w, 'headline').text()).toContain('4 guardians');
		expect(at(w, 'headline').text()).toContain('any 3 of them can help you back in');
		expect(at(w, 'next').attributes('disabled')).toBeUndefined();

		await rowOf(w, 'Ivan').trigger('click');
		expect(at(w, 'headline').text()).toContain('3 guardians');
		expect(at(w, 'headline').text()).toContain('any 2 of them can help you back in');
	});

	it('allows two guardians only once the warning is confirmed', async () => {
		const w = render(Screen_Guardians);
		await rowOf(w, 'Ivan').trigger('click');
		await rowOf(w, 'Vitalii').trigger('click');
		expect(at(w, 'two-warning').text()).toContain('If you lose either of them, the backup cannot be used.');
		expect(at(w, 'next').attributes('disabled')).toBeDefined();
		expect(at(w, 'block-reason').text()).toBe('Confirm the warning above to use 2 guardians.');

		await at(w, 'two-ack').setValue(true);
		expect(at(w, 'next').attributes('disabled')).toBeUndefined();
		await at(w, 'next').trigger('click');
		expect(nav.go).toHaveBeenCalledWith('alerts');
	});

	it('blocks one guardian, with the reason under the button', async () => {
		const w = render(Screen_Guardians);
		for (const name of ['Ivan', 'Vitalii', 'Milo']) await rowOf(w, name).trigger('click');
		expect(at(w, 'headline').text()).toContain('1 guardian');
		expect(at(w, 'headline').text()).toContain('Pick at least 2. 3 or more is safer.');
		expect(at(w, 'two-warning').exists()).toBe(false);
		expect(at(w, 'next').attributes('disabled')).toBeDefined();
		expect(at(w, 'block-reason').text()).toBe('One guardian is not enough: a backup needs at least 2.');
	});

	it('says how many node operators are missing, and blocks until they are added', () => {
		setup({ nodes: [node({ operator: hash('x') }), node({ operator: hash('y') })] });
		const w = render(Screen_Guardians);
		expect(at(w, 'operators-short').text()).toContain('1 more node operator needed');
		expect(at(w, 'operators-short').text()).toContain('2 are available now');
		expect(at(w, 'block-reason').text()).toBe('Add 1 more node operator to continue.');
	});

	it('shows the rest with their status and action: Ask, Ask again, Remind', async () => {
		setup({ candidates: [DARIA, MILO, candidate('Olena', 'declined', 'l'), candidate('Yehven', 'waiting', 'y'), candidate('Gaia', 'not_asked', 'g')], hiddenContacts: 6 });
		const w = render(Screen_Guardians);
		const rows = w.findAll('[data-test="other-row"]').map((r) => r.text());
		expect(rows).toEqual([
			expect.stringMatching(/Olena\s*declined\s*Ask again/),
			expect.stringMatching(/Yehven\s*waiting for answer\s*Remind/),
			expect.stringMatching(/Gaia\s*not asked\s*Ask/),
		]);
		expect(w.findAll('[data-test="other-row"] .cb-check.on')).toHaveLength(0);
		expect(w.text()).toContain('Only contacts confirmed in person can be guardians. 6 other contacts are not shown.');

		await w.findAll('[data-test="other-row"]')[0].find('button').trigger('click');
		expect(H.invites.invite).toHaveBeenCalledWith(hash('l'));
		await w.findAll('[data-test="other-row"]')[1].find('button').trigger('click');
		expect(H.router.push).toHaveBeenCalledWith({ name: 'chat', params: { address: hash('y') } });
	});

	it('with nobody agreed leads into asking instead of an empty list', () => {
		setup({ candidates: [candidate('Gaia', 'not_asked', 'g')] });
		const w = render(Screen_Guardians);
		expect(at(w, 'empty').text()).toContain('Ask 3 people you trust to be guardians');
		expect(at(w, 'empty').text()).toContain('A guardian cannot open your account alone');
		expect(at(w, 'next').exists()).toBe(false);
	});
});

describe('Advanced', () => {
	beforeEach(() => setup());

	it('refuses fewer approvals than pieces needed, and Save waits for a fix', async () => {
		const w = render(Screen_Advanced);
		const approvals = at(w, 'approvals');
		expect(at(w, 'approvals-error').exists()).toBe(false);

		await approvals.find('[aria-label="Less"]').trigger('click');
		expect(at(w, 'approvals-error').text()).toBe('Approvals cannot be fewer than pieces needed: an honest recovery could never collect enough pieces.');
		expect(at(w, 'save').attributes('disabled')).toBeDefined();

		await approvals.find('[aria-label="More"]').trigger('click');
		await approvals.find('[aria-label="More"]').trigger('click');
		expect(at(w, 'approvals-error').exists()).toBe(false);
		await at(w, 'save').trigger('click');
		expect(draft.state.custom.approvals).toBe(4);
		expect(draft.settings.value.approvals).toBe(4);
		expect(nav.back).toHaveBeenCalled();
	});

	it('stops the pieces stepper at the number of guardians', async () => {
		const w = render(Screen_Advanced);
		const more = at(w, 'threshold').find('[aria-label="More"]');
		await more.trigger('click');
		expect(at(w, 'threshold').text()).toContain('4');
		expect(more.attributes('disabled')).toBeDefined();
		expect(w.text()).toContain('maximum');
	});
});

describe('Nodes', () => {
	it('offers neither offline nor unsigned nodes, and refuses a guardian\'s node with the way out', async () => {
		const gaiaNode = node({ operator: DARIA.userHash });
		const offline = node({ operator: hash('y'), online: false });
		setup({
			nodes: [node({ operator: hash('x') }), offline, gaiaNode, node({ operator: hash('z') }), node({ operator: hash('w') })],
			refusedNodes: { 'https://ivan-node.org/recovery/node': { state: 'refused', reason: 'not_endorsed' } },
		});
		const w = render(Screen_Nodes);
		const rows = w.findAll('[data-test="node-row"]');
		expect(rows).toHaveLength(6);
		const byText = (t) => rows.find((r) => r.text().includes(t));
		expect(byText('offline').find('[data-test="node-check"]').exists()).toBe(false);
		expect(byText('not ready').find('[data-test="node-check"]').exists()).toBe(false);
		// The suggested set leaves the guardian's node out.
		expect(w.find('[data-test="node-problem"]').exists()).toBe(false);

		await byText('your guardian').trigger('click');
		const problem = w.find('[data-test="node-problem"]');
		expect(problem.text()).toContain('Daria is a guardian and also runs this node. One person would hold both halves.');

		await problem.findAll('button')[1].trigger('click');
		expect(draft.state.selected).not.toContain(DARIA.userHash);
		expect(w.find('[data-test="node-problem"]').exists()).toBe(false);
	});

	it('an offline node cannot be clicked into the set', async () => {
		const offline = node({ operator: hash('y'), online: false });
		setup({ nodes: [...threeOperators(), offline] });
		const w = render(Screen_Nodes);
		await w.findAll('[data-test="node-row"]').find((r) => r.text().includes('offline')).trigger('click');
		expect(draft.nodes.value.map((n) => n.descriptor.id)).not.toContain(offline.descriptor.id);
	});
});

describe('Fee', () => {
	it('past the free service\'s limit switches to paying yourself and says why', async () => {
		const many = Array.from({ length: 33 }, (_, i) => candidate(`G${i}`, 'agreed', String.fromCharCode(0x4e00 + i)));
		setup({
			candidates: many,
			selfPayQuote: vi.fn(async () => ({ address: '0x7a3F' + '0'.repeat(32) + 'c91E', balance: '0.003', estimate: '0.05', enough: false })),
		});
		expect(draft.feePayload.value).toEqual({ kind: 'self' });
		const w = render(Screen_Fee);
		await flushPromises();
		expect(at(w, 'too-big').text()).toBe('This backup has 33 guardians. The free service takes up to 32, so it is paid from your address.');
		expect(at(w, 'tile-buckitup').classes()).toContain('off');
		expect(at(w, 'tile-buckitup').text()).toContain('not available for this backup');
		expect(at(w, 'tile-self').classes()).toContain('picked');
		expect(H.store.selfPayQuote).toHaveBeenCalledWith(33);
		expect(w.text()).toContain('Top up this address with at least 0.05 ETH');
		expect(w.text()).not.toContain('xDAI');
		expect(at(w, 'save').attributes('disabled')).toBeDefined();
		expect(at(w, 'save-reason').text()).toBe('Balance is too low for the fee.');

		await at(w, 'tile-buckitup').trigger('click');
		expect(at(w, 'tile-self').classes()).toContain('picked');
		w.unmount();
	});

	it('within the limit stays free', () => {
		setup();
		expect(draft.feePayload.value).toEqual({ kind: 'relayer' });
		const w = render(Screen_Fee);
		expect(at(w, 'too-big').exists()).toBe(false);
		expect(at(w, 'tile-buckitup').classes()).toContain('picked');
		w.unmount();
	});
});

describe('the modal', () => {
	it('moves between screens and back, and closes through the modal host', async () => {
		setup();
		const { default: Modal } = await import('@/components/modal/views/Modal_Community_Backup.vue');
		const emitted = [];
		const w = mount(Modal, { props: { inputData: { id: 'community_backup', start: 'guardians' } }, global: { provide: { $mitt: { emit: (e) => emitted.push(e) } } } });
		await flushPromises();
		expect(H.store.refreshNodes).toHaveBeenCalled();
		await w.find('[data-test="next"]').trigger('click');
		expect(w.text()).toContain('Where should we warn you?');
		await w.find('[aria-label="Back"]').trigger('click');
		expect(w.find('[data-test="headline"]').exists()).toBe(true);
		await w.find('[aria-label="Close"]').trigger('click');
		expect(emitted).toEqual(['modal::close']);
	});
});

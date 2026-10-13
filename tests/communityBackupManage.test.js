// @vitest-environment jsdom
// The owner's roster of a finished backup (plan § 7.4): who holds a piece
// against what is needed, the spares, the nodes, the waiting period and the
// alert channels; and its controls — a spare, a reshare through the setup
// screens filled in from the record, the waiting period, revoking — which
// wait while a change is being made and are gone once the backup is revoked.
// The draft and the rules under it are real; only the store is faked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { effectScope } from 'vue';
import { candidate, fakeBackupStore, fakeNav, hash, makeRun, node, settings } from './helpers/communityBackup';

const H = vi.hoisted(() => ({ store: null, user: null, invites: null, router: null }));
vi.mock('@/store/recoveryBackup.store', () => ({ useRecoveryBackupStore: () => H.store }));
vi.mock('@/store/recoveryInvites.store', () => ({ useRecoveryInvitesStore: () => H.invites }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => H.user }));
vi.mock('vue-router', () => ({ useRouter: () => H.router }));
vi.mock('@/utils/copyToClipboard', () => ({ default: vi.fn(async () => true) }));

const { DRAFT, NAV, createBackupDraft } = await import('@/components/recovery/backup/backupFlow');
const { default: Screen_Manage } = await import('@/components/recovery/backup/Screen_Manage.vue');
const { default: Screen_Policy } = await import('@/components/recovery/backup/Screen_Policy.vue');
const { default: Screen_AlertHistory } = await import('@/components/recovery/backup/Screen_AlertHistory.vue');
const { default: Screen_Guardians } = await import('@/components/recovery/backup/Screen_Guardians.vue');
const { default: Screen_Advanced } = await import('@/components/recovery/backup/Screen_Advanced.vue');
const { default: Screen_Review } = await import('@/components/recovery/backup/Screen_Review.vue');
const { default: Screen_Done } = await import('@/components/recovery/backup/Screen_Done.vue');

const DARIA = candidate('Daria', 'agreed', 'a');
const MILO = candidate('Milo', 'agreed', 'b');
const VITALII = candidate('Vitalii', 'agreed', 'c');
const IVAN = candidate('Ivan', 'agreed', 'd');
const GAIA = candidate('Gaia', 'agreed', 'g');
const NODES = [node({ operator: hash('x') }), node({ operator: hash('y') }), node({ operator: hash('z') })];
/** Known to this device but not in the backup: the suggested set would take it, a reshare starts from the record's. */
const SPARE_NODE = node({ operator: hash('w') });

/** A finished backup of Daria, Milo, Vitalii and Ivan: 3 pieces needed, 2 spares, 3 nodes, paid by another service. */
const record = (over = {}) => {
	const guardians = [DARIA, MILO, VITALII, IVAN].map((c) => ({ userHash: c.userHash, metaAddress: c.metaAddress }));
	return makeRun({
		step: 'done',
		secretId: '0x1',
		version: 2,
		guardians,
		settings: settings({ threshold: 3, approvals: 3, spares: 2, delaySec: 2 * 86400, windowSec: 5 * 86400, nodeThreshold: 2 }),
		nodes: NODES.map((n) => ({ id: n.descriptor.id, url: n.descriptor.url })),
		nodeOutcomes: Object.fromEntries(NODES.map((n) => [n.descriptor.id, { state: 'held' }])),
		shares: [null, null, null, null, 'U1A1', 'U1A2'],
		sent: Object.fromEntries(guardians.map((g, i) => [g.userHash, { messageId: `m${i}`, shareIndex: i + 1 }])),
		fee: { kind: 'relayer', url: 'https://other.example/relay' },
		...over,
	});
};

let scope, draft, nav;
const setup = (over = {}) => {
	H.store = fakeBackupStore({ candidates: [DARIA, MILO, VITALII, IVAN, GAIA], nodes: [SPARE_NODE, ...NODES], run: record(), ...over });
	H.user = { contactsMap: {}, currentUserHash: hash('o') };
	H.invites = { invite: vi.fn(async () => {}) };
	H.router = { push: vi.fn() };
	scope = effectScope();
	draft = scope.run(() => createBackupDraft(H.store));
	nav = fakeNav();
};
const render = (C) => mount(C, { global: { provide: { [DRAFT]: draft, [NAV]: nav } } });
const at = (w, sel) => w.find(`[data-test="${sel}"]`);
const all = (w, sel) => w.findAll(`[data-test="${sel}"]`);
const rowOf = (w, name) => all(w, 'roster-row').find((r) => r.text().includes(name));
const disabled = (el) => el.attributes('disabled') !== undefined;

afterEach(() => scope?.stop());

describe('the roster', () => {
	beforeEach(() => setup());

	it('shows each guardian’s piece, the holders against the larger of pieces and approvals, and the spares', async () => {
		H.store.run.settings.approvals = 4;
		H.store.run.shares[4] = null;
		H.store.run.sparesGiven = { 5: { guardian: DARIA.userHash, messageId: 'sp' } };
		H.store.receipts = { [DARIA.userHash]: 'stored', [MILO.userHash]: 'delivered', [VITALII.userHash]: 'given_back', [IVAN.userHash]: 'problem' };
		H.store.receiptDetails = { [IVAN.userHash]: { state: 'problem', detail: 'the share does not match its leaf' } };
		const w = render(Screen_Manage);
		await flushPromises();

		expect(w.find('.health-count').text()).toBe('1 of 4');
		expect(w.find('.health-detail').text()).toContain('4 needed');
		expect(all(w, 'roster-row').map((r) => r.find('[data-test="roster-state"]').text())).toEqual(['holds a piece', 'delivered', 'gave it back', 'has a problem']);
		expect(rowOf(w, 'Daria').find('[data-test="spares-held"]').text()).toBe('also holds 1 spare piece');
		expect(rowOf(w, 'Milo').find('[data-test="spares-held"]').exists()).toBe(false);
		expect(rowOf(w, 'Vitalii').find('[data-test="roster-hint"]').text()).toBe('They gave it back. A reshare replaces this piece.');
		expect(rowOf(w, 'Ivan').find('[data-test="roster-hint"]').text()).toContain('They report: the share does not match its leaf.');
		expect(at(w, 'spares-left').text()).toBe('1');
		expect(w.text()).toContain('Guardians · version 2');
		expect(H.store.refreshReceipts).toHaveBeenCalled();
	});

	it('asks for a reshare to replace pieces given back or with a problem', async () => {
		H.store.receipts = { [DARIA.userHash]: 'stored', [MILO.userHash]: 'stored', [VITALII.userHash]: 'stored', [IVAN.userHash]: 'given_back' };
		const w = render(Screen_Manage);
		expect(at(w, 'reshare-prompt').text()).toContain('Ivan no longer keeps a piece that counts.');
		expect(at(w, 'reshare-cta').text()).toBe('Reshare to replace');
		await at(w, 'reshare-cta').trigger('click');
		expect(draft.state.reshare).toMatchObject({ secretId: '0x1', version: 2 });
		expect(nav.go).toHaveBeenCalledWith('guardians');
	});

	it('warns at the threshold, says nothing while the backup has a margin', () => {
		H.store.receipts = Object.fromEntries([DARIA, MILO, VITALII, IVAN].map((c) => [c.userHash, 'stored']));
		H.store.run.settings.threshold = 4;
		H.store.run.settings.approvals = 4;
		expect(at(render(Screen_Manage), 'reshare-prompt').text()).toContain('One more lost piece and the backup stops working.');
		H.store.run.settings.threshold = 2;
		H.store.run.settings.approvals = 2;
		expect(at(render(Screen_Manage), 'reshare-prompt').exists()).toBe(false);
	});

	it('shows each node by what it did with its part', () => {
		H.store.run.skippedNodes = [NODES[1].descriptor.id];
		H.store.run.nodeOutcomes[NODES[1].descriptor.id] = { state: 'failed', error: 'down', at: 1 };
		H.store.run.nodeOutcomes[NODES[2].descriptor.id] = { state: 'failed', error: 'down', at: 1 };
		const w = render(Screen_Manage);
		expect(w.text()).toContain('Nodes · 2 of 3 needed');
		expect(all(w, 'node-row').map((r) => r.text())).toEqual([
			expect.stringMatching(/node\d+\.example\.org.*holds its part/),
			expect.stringMatching(/left out$/),
			expect.stringMatching(/did not take its part$/),
		]);
	});

	it('shows the waiting period, and the warning while no alert channel outside the app is on', () => {
		H.store.run.alerts = { channels: ['app'], skipped: true };
		const w = render(Screen_Manage);
		expect(at(w, 'delay').text()).toBe('2 days');
		expect(at(w, 'window').text()).toBe('5 days');
		expect(at(w, 'no-alerts').text()).toContain('No alerts. You may not learn about an attempt in time to stop it.');
	});
});

describe('a spare piece', () => {
	beforeEach(() => setup());

	it('goes to a guardian while spares are left', async () => {
		const w = render(Screen_Manage);
		const give = rowOf(w, 'Milo').find('[data-test="give-spare"]');
		expect(disabled(give)).toBe(false);
		await give.trigger('click');
		await flushPromises();
		expect(H.store.giveSpare).toHaveBeenCalledWith(MILO.userHash);
	});

	it('cannot be given once none is left', async () => {
		H.store.run.shares = [null, null, null, null, null, null];
		const w = render(Screen_Manage);
		expect(at(w, 'spares-left').text()).toBe('0');
		expect(all(w, 'give-spare').every(disabled)).toBe(true);
		await all(w, 'give-spare')[0].trigger('click');
		expect(H.store.giveSpare).not.toHaveBeenCalled();
	});

	it('says why when it could not be given', async () => {
		H.store.giveSpare = vi.fn(async () => {
			throw new Error('No spare pieces are left.');
		});
		const w = render(Screen_Manage);
		await all(w, 'give-spare')[0].trigger('click');
		await flushPromises();
		expect(at(w, 'action-error').text()).toBe('No spare pieces are left.');
	});
});

describe('a reshare from the roster', () => {
	beforeEach(() => setup());

	const enter = async () => {
		const w = render(Screen_Manage);
		await at(w, 'reshare').trigger('click');
		return w;
	};

	it('fills the setup in from the record: its guardians, counts, nodes and fee', async () => {
		await enter();
		expect(nav.refreshNodes).toHaveBeenCalled();
		expect(nav.go).toHaveBeenCalledWith('guardians');
		expect(draft.guardianHashes.value).toEqual([DARIA, MILO, VITALII, IVAN].map((c) => c.userHash));
		expect(draft.settings.value).toEqual({ threshold: 3, approvals: 3, spares: 2, delaySec: 2 * 86400, windowSec: 5 * 86400, nodeThreshold: 2 });
		expect(draft.nodes.value.map((n) => n.descriptor.id)).toEqual(NODES.map((n) => n.descriptor.id));
		expect(draft.feeChoice.value).toBe('other');
		expect(draft.state.fee.url).toBe('https://other.example/relay');

		const g = render(Screen_Guardians);
		expect(g.text()).toContain('Change your backup');
		expect(at(g, 'reshare-intro').exists()).toBe(true);
		expect(g.findAll('[data-test="agreed-row"].picked').map((r) => r.text())).toEqual([
			expect.stringContaining('Daria'), expect.stringContaining('Milo'), expect.stringContaining('Vitalii'), expect.stringContaining('Ivan'),
		]);
		expect(at(g, 'next').text()).toBe('Next: review');
		await at(g, 'next').trigger('click');
		expect(nav.go).toHaveBeenLastCalledWith('review');
	});

	it('drops one guardian, adds another, and starts the reshare with them and the record’s settings', async () => {
		H.store.run.settings.threshold = 4;
		H.store.run.settings.approvals = 4;
		await enter();
		expect(draft.settings.value).toMatchObject({ threshold: 4, approvals: 4 });
		const g = render(Screen_Guardians);
		const pick = (name) => g.findAll('[data-test="agreed-row"]').find((r) => r.text().includes(name)).trigger('click');
		await pick('Ivan');
		await pick('Gaia');

		const r = render(Screen_Review);
		expect(r.text()).toContain('Change your backup');
		expect(at(r, 'joining').text()).toBe('Joining: Gaia');
		expect(at(r, 'leaving').text()).toBe('Leaving: Ivan');
		expect(at(r, 'create').text()).toBe('Reshare');
		await at(r, 'create').trigger('click');
		await flushPromises();

		expect(H.store.start).toHaveBeenCalledTimes(1);
		const arg = H.store.start.mock.calls[0][0];
		expect(arg.reshare).toBe(true);
		expect(arg.guardians).toEqual([DARIA, MILO, VITALII, GAIA].map((c) => ({ userHash: c.userHash, metaAddress: c.metaAddress })));
		// A new count of guardians starts its pieces and approvals from the defaults; the rest is the record's.
		expect(arg.settings).toEqual({ threshold: 3, approvals: 3, spares: 2, delaySec: 2 * 86400, windowSec: 5 * 86400, nodeThreshold: 2 });
		expect(arg.nodes.map((n) => n.descriptor.id)).toEqual(NODES.map((n) => n.descriptor.id));
		expect(arg.fee).toEqual({ kind: 'relayer', url: 'https://other.example/relay' });
		expect(arg).not.toHaveProperty('alerts');
		expect(nav.reset).toHaveBeenCalledWith('progress');
	});

	it('changes the pieces needed in Advanced, which keeps the waiting period out of it', async () => {
		await enter();
		const a = render(Screen_Advanced);
		expect(at(a, 'reshare-time').text()).toContain('The waiting period (2 days) and the time to finish (5 days) stay as they are.');
		expect(a.find('[aria-label="Waiting period"]').exists()).toBe(false);
		await at(a, 'threshold').find('[aria-label="Less"]').trigger('click');
		await at(a, 'save').trigger('click');
		expect(draft.settings.value).toMatchObject({ threshold: 2, approvals: 3, delaySec: 2 * 86400, windowSec: 5 * 86400 });

		await render(Screen_Review).find('[data-test="create"]').trigger('click');
		await flushPromises();
		expect(H.store.start.mock.calls[0][0]).toMatchObject({ reshare: true, settings: { threshold: 2, approvals: 3 } });
	});

	it('leaves out a guardian who no longer agrees, and says so', async () => {
		H.store.candidates = [DARIA, MILO, { ...VITALII, status: 'declined', metaAddress: null }, IVAN, GAIA];
		await enter();
		expect(draft.guardianHashes.value).toEqual([DARIA, MILO, IVAN].map((c) => c.userHash));
		// Fewer guardians than the record's: the counts start from their defaults.
		expect(draft.settings.value).toMatchObject({ threshold: 2, approvals: 2, spares: 2 });
		const g = render(Screen_Guardians);
		expect(at(g, 'reshare-gone').text()).toBe('Vitalii no longer agrees to be a guardian, so is not in the new version.');
	});
});

describe('the waiting period', () => {
	beforeEach(() => setup());

	const setDuration = async (w, sel, amount, unit) => {
		await at(w, sel).find('input').setValue(amount);
		await at(w, sel).find('select').setValue(unit);
	};

	it('saves only a change within the contract’s bounds', async () => {
		const w = render(Screen_Policy);
		expect(disabled(at(w, 'save-policy'))).toBe(true);

		await setDuration(w, 'delay', 5, 60);
		expect(at(w, 'delay-error').text()).toBe('The waiting period must be between 10 minutes and 365 days.');
		expect(disabled(at(w, 'save-policy'))).toBe(true);

		await setDuration(w, 'delay', 1, 86400);
		await setDuration(w, 'window', 31, 86400);
		expect(at(w, 'delay-error').exists()).toBe(false);
		expect(at(w, 'window-error').text()).toBe('The time to finish must be between 1 hour and 30 days.');
		expect(disabled(at(w, 'save-policy'))).toBe(true);

		await setDuration(w, 'window', 12, 3600);
		expect(disabled(at(w, 'save-policy'))).toBe(false);
		await at(w, 'save-policy').trigger('click');
		await flushPromises();
		expect(H.store.setPolicy).toHaveBeenCalledWith({ delaySec: 86400, windowSec: 12 * 3600 });
		expect(nav.back).toHaveBeenCalled();
	});

	it('stays put and says why when the network refused it', async () => {
		H.store.setPolicy = vi.fn(async () => {
			throw new Error('The service refused.');
		});
		const w = render(Screen_Policy);
		await setDuration(w, 'delay', 4, 86400);
		await at(w, 'save-policy').trigger('click');
		await flushPromises();
		expect(at(w, 'policy-error').text()).toBe('The service refused.');
		expect(nav.back).not.toHaveBeenCalled();
	});
});

describe('revoking', () => {
	beforeEach(() => setup());

	it('asks twice, the second time to type the word, before it revokes', async () => {
		const w = render(Screen_Manage);
		await at(w, 'revoke').trigger('click');
		expect(H.store.revoke).not.toHaveBeenCalled();
		expect(at(w, 'revoke-confirm').text()).toContain('this cannot be undone. Type REVOKE to confirm.');
		expect(disabled(at(w, 'revoke-final'))).toBe(true);

		await at(w, 'revoke-input').setValue('revoke');
		expect(disabled(at(w, 'revoke-final'))).toBe(true);
		await at(w, 'revoke-final').trigger('click');
		expect(H.store.revoke).not.toHaveBeenCalled();

		await at(w, 'revoke-input').setValue('REVOKE');
		expect(disabled(at(w, 'revoke-final'))).toBe(false);
		await at(w, 'revoke-final').trigger('click');
		await flushPromises();
		expect(H.store.revoke).toHaveBeenCalledTimes(1);
	});

	it('a revoked backup shows only that it is revoked', async () => {
		H.store.run.revokedAt = 1_700_000_500;
		const w = render(Screen_Manage);
		await flushPromises();
		expect(at(w, 'revoked').text()).toContain('Revoked for good');
		for (const sel of ['give-spare', 'reshare', 'change-policy', 'revoke', 'add-channel', 'remove-subscription']) expect(at(w, sel).exists()).toBe(false);
		expect(w.find('.health').exists()).toBe(false);
		expect(H.store.subscriptions).not.toHaveBeenCalled();
	});
});

describe('alerts', () => {
	beforeEach(() => setup());

	it('lists the channels and removes one, recording what is left', async () => {
		H.store.subscriptions = vi.fn(async () => [
			{ id: 's1', kind: 'telegram', createdAt: '2026-10-01T10:00:00Z' },
			{ id: 's2', kind: 'webhook', createdAt: '2026-10-02T10:00:00Z' },
		]);
		const w = render(Screen_Manage);
		await flushPromises();
		expect(all(w, 'subscription').map((r) => r.text())).toEqual([expect.stringContaining('Telegram'), expect.stringContaining('Webhook')]);

		await all(w, 'remove-subscription')[0].trigger('click');
		await flushPromises();
		expect(H.store.removeSubscription).toHaveBeenCalledWith('s1');
		expect(all(w, 'subscription').map((r) => r.text())).toEqual([expect.stringContaining('Webhook')]);
		expect(H.store.setAlerts).toHaveBeenCalledWith({ channels: ['app', 'webhook'], skipped: false });

		await at(w, 'add-channel').trigger('click');
		expect(nav.go).toHaveBeenCalledWith('alerts');
		await at(w, 'open-history').trigger('click');
		expect(nav.go).toHaveBeenCalledWith('history');
	});

	it('shows the alert history, or that there is none', async () => {
		H.store.history = vi.fn(async () => [
			{ type: 'QUORUM_REACHED', kind: 'telegram', emitted: true, createdAt: '2026-10-03T10:00:00Z' },
			{ type: 'RECOVERY_STARTED', kind: 'webhook', emitted: false, createdAt: '2026-10-02T10:00:00Z' },
		]);
		const w = render(Screen_AlertHistory);
		await flushPromises();
		expect(all(w, 'history-row').map((r) => r.text())).toEqual([
			expect.stringMatching(/^Enough guardians approved a recovery\s*Telegram · .*sent$/),
			expect.stringMatching(/^A recovery was started\s*Webhook · .*not sent yet$/),
		]);

		H.store.history = vi.fn(async () => []);
		const empty = render(Screen_AlertHistory);
		await flushPromises();
		expect(at(empty, 'history-empty').exists()).toBe(true);
	});
});

describe('while a change of the backup is being made', () => {
	beforeEach(() => setup({ reshare: makeRun({ runId: 'r2', step: 'registered', secretId: '0x1', version: 3, reshareOf: { secretId: '0x1', version: 2 } }) }));

	it('holds every control with the reason, and leads to the change', async () => {
		const w = render(Screen_Manage);
		expect(at(w, 'blocked').text()).toContain('Finish or discard the change first.');
		for (const sel of ['reshare', 'change-policy', 'revoke']) expect(disabled(at(w, sel))).toBe(true);
		expect(all(w, 'give-spare').every(disabled)).toBe(true);
		await at(w, 'reshare').trigger('click');
		await all(w, 'give-spare')[0].trigger('click');
		expect(draft.state.reshare).toBeNull();
		expect(H.store.giveSpare).not.toHaveBeenCalled();
		// Alert channels are not the backup's: they stay open.
		expect(disabled(at(w, 'add-channel'))).toBe(false);
		await at(w, 'show-change').trigger('click');
		expect(nav.go).toHaveBeenCalledWith('progress');
	});

	it('holds the waiting period too', async () => {
		const w = render(Screen_Policy);
		await at(w, 'delay').find('input').setValue(4);
		expect(at(w, 'blocked').text()).toContain('Finish or discard the change first.');
		expect(disabled(at(w, 'save-policy'))).toBe(true);
	});
});

describe('the summary after a run', () => {
	beforeEach(() => setup());

	it('links to the roster', async () => {
		const w = render(Screen_Done);
		await at(w, 'manage').trigger('click');
		expect(nav.go).toHaveBeenCalledWith('manage');
	});
});

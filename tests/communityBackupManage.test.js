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
const { default: Screen_Alerts } = await import('@/components/recovery/backup/Screen_Alerts.vue');
const { default: Modal } = await import('@/components/modal/views/Modal_Community_Backup.vue');
const { default: Screen_Nodes } = await import('@/components/recovery/backup/Screen_Nodes.vue');
const { default: Screen_Progress } = await import('@/components/recovery/backup/Screen_Progress.vue');

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
		expect(at(w, 'reshare-prompt-cta').text()).toBe('Reshare to replace');
		await at(w, 'reshare-prompt-cta').trigger('click');
		expect(draft.state.reshare).toEqual({
			guardians: [DARIA, MILO, VITALII, IVAN].map((c) => c.userHash),
			nodes: NODES.map((n) => ({ id: n.descriptor.id, url: n.descriptor.url })),
		});
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

	it('after a recovery keeps only the guardians named, as a change the owner can still edit, and starts it as a reshare', async () => {
		draft.beginReshare(H.store.run, { keep: [DARIA.userHash, MILO.userHash, IVAN.userHash] });
		expect(draft.guardianHashes.value).toEqual([DARIA, MILO, IVAN].map((c) => c.userHash));
		// Fewer guardians than the record's: pieces and approvals start from the defaults; the rest is the record's.
		expect(draft.settings.value).toEqual({ threshold: 2, approvals: 2, spares: 2, delaySec: 2 * 86400, windowSec: 5 * 86400, nodeThreshold: 2 });
		const r = render(Screen_Review);
		expect(at(r, 'leaving').text()).toBe('Leaving: Vitalii');
		await at(r, 'create').trigger('click');
		await flushPromises();
		expect(H.store.start.mock.calls[0][0]).toMatchObject({ reshare: true, guardians: [DARIA, MILO, IVAN].map((c) => ({ userHash: c.userHash })) });
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
		H.store.subs = [
			{ id: 's1', kind: 'telegram', createdAt: '2026-10-01T10:00:00Z' },
			{ id: 's2', kind: 'webhook', createdAt: '2026-10-02T10:00:00Z' },
		];
		const w = render(Screen_Manage);
		await flushPromises();
		expect(H.store.subscriptions).toHaveBeenCalledWith();
		expect(all(w, 'subscription').map((r) => r.text())).toEqual([expect.stringContaining('Telegram'), expect.stringContaining('Webhook')]);

		// The store removes it and records what is left; the screen shows its list.
		await all(w, 'remove-subscription')[0].trigger('click');
		await flushPromises();
		expect(H.store.removeSubscription).toHaveBeenCalledWith('s1');
		expect(all(w, 'subscription').map((r) => r.text())).toEqual([expect.stringContaining('Webhook')]);

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

describe('what the nodes hold now', () => {
	beforeEach(() => setup());
	afterEach(() => vi.useRealTimers());

	it('is checked when the roster opens and every few minutes while it is open', async () => {
		vi.useFakeTimers();
		const w = render(Screen_Manage);
		await flushPromises();
		expect(H.store.checkHoldings).toHaveBeenCalledTimes(1);
		expect(H.store.checkHoldings).toHaveBeenLastCalledWith(undefined);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(H.store.checkHoldings).toHaveBeenCalledTimes(2);
		// The timer checks whatever the last check's age; so does Check again.
		expect(H.store.checkHoldings).toHaveBeenLastCalledWith({ force: true });
		await at(w, 'check-nodes').trigger('click');
		expect(H.store.checkHoldings).toHaveBeenCalledTimes(3);
		expect(H.store.checkHoldings).toHaveBeenLastCalledWith({ force: true });
		w.unmount();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(H.store.checkHoldings).toHaveBeenCalledTimes(3);
	});

	it('shows a node that lost its part or does not answer, and asks for a reshare once a loss eats into the spare', () => {
		const [a, b, c] = NODES.map((n) => n.descriptor.id);
		H.store.holdings = { runId: H.store.run.runId, byNode: { [a]: 'holds', [b]: 'lost', [c]: 'unreachable' }, at: 1 };
		const w = render(Screen_Manage);
		expect(all(w, 'node-row').map((r) => r.text())).toEqual([
			expect.stringMatching(/holds its part$/), expect.stringMatching(/lost its part$/), expect.stringMatching(/not answering$/),
		]);
		expect(at(w, 'node-prompt').text()).toContain('1 node lost its part: 1 of 3 hold it, 2 needed. The node half cannot be rebuilt now');
		expect(at(w, 'node-prompt-cta').text()).toBe('Reshare to replace');

		H.store.holdings = { runId: H.store.run.runId, byNode: { [a]: 'holds', [b]: 'holds', [c]: 'unreachable' }, at: 1 };
		expect(at(render(Screen_Manage), 'node-prompt').exists()).toBe(false);
		// A check made for another record says nothing about this one.
		H.store.holdings = { runId: 'other', byNode: { [a]: 'lost' }, at: 1 };
		expect(at(render(Screen_Manage), 'node-prompt').exists()).toBe(false);
	});
});

describe('a revoked backup', () => {
	beforeEach(() => setup());

	it('offers a new backup in its place', async () => {
		H.store.run.revokedAt = 1_700_000_500;
		draft.beginReshare(H.store.run);
		const w = render(Screen_Manage);
		await at(w, 'create-new').trigger('click');
		expect(draft.state.reshare).toBeNull();
		expect(nav.reset).toHaveBeenCalledWith('guardians');
	});
});

describe('the modal', () => {
	beforeEach(() => setup());
	const open = (start) => mount(Modal, { props: { inputData: { id: 'community_backup', start } }, global: { provide: { $mitt: { emit: vi.fn() } } } });

	it('opened for a reshare starts on the guardians, filled in, over the roster', async () => {
		const w = open('reshare');
		await flushPromises();
		expect(at(w, 'reshare-intro').exists()).toBe(true);
		expect(w.findAll('[data-test="agreed-row"].picked')).toHaveLength(4);
		await w.find('[aria-label="Back"]').trigger('click');
		expect(w.text()).toContain('Guardians · version 2');
	});

	it('opened from the finale of a recovery picks only the guardians to keep, and the counts start from their defaults', async () => {
		const keep = [DARIA.userHash, MILO.userHash, VITALII.userHash];
		const w = mount(Modal, { props: { inputData: { id: 'community_backup', start: 'reshare', keep } }, global: { provide: { $mitt: { emit: vi.fn() } } } });
		await flushPromises();
		expect(at(w, 'reshare-intro').exists()).toBe(true);
		expect(w.findAll('[data-test="agreed-row"].picked').map((r) => r.text())).toEqual([
			expect.stringContaining('Daria'),
			expect.stringContaining('Milo'),
			expect.stringContaining('Vitalii'),
		]);
	});

	it('checks the nodes once while it is open, however often a reshare is entered', async () => {
		const w = open('manage');
		await flushPromises();
		expect(H.store.staleSubscriptions).toHaveBeenCalledTimes(1);
		expect(H.store.refreshNodes).not.toHaveBeenCalled();
		await at(w, 'reshare').trigger('click');
		await w.find('[aria-label="Back"]').trigger('click');
		await at(w, 'reshare').trigger('click');
		expect(H.store.refreshNodes).toHaveBeenCalledTimes(1);
	});
});

describe('adding a channel to a finished backup', () => {
	beforeEach(() => setup());

	it('can add another webhook when one is on', async () => {
		H.store.subs = [{ id: 'w1', kind: 'webhook', createdAt: 'x' }];
		const w = render(Screen_Alerts);
		await flushPromises();
		expect(at(w, 'tile-webhook').text()).toContain('Add another');
		await at(w, 'tile-webhook').trigger('click');
		expect(w.find('[aria-label="Webhook address"]').exists()).toBe(true);
	});

	it('in the first setup, a connected webhook is the one', async () => {
		H.store.run = null;
		H.store.subs = [{ id: 'w1', kind: 'webhook', createdAt: 'x' }];
		const w = render(Screen_Alerts);
		await flushPromises();
		await at(w, 'tile-webhook').trigger('click');
		expect(w.find('[aria-label="Webhook address"]').exists()).toBe(false);
	});
});

describe('review fixes', () => {
	beforeEach(() => setup());

	it('a node checked while a change is being made reads as being changed, not lost', () => {
		const [a, b, c] = NODES.map((n) => n.descriptor.id);
		H.store.holdings = { runId: H.store.run.runId, byNode: { [a]: 'holds', [b]: 'changing', [c]: 'changing' }, at: 1 };
		const w = render(Screen_Manage);
		expect(all(w, 'node-row').map((r) => r.text())).toEqual([
			expect.stringMatching(/holds its part$/), expect.stringMatching(/being changed$/), expect.stringMatching(/being changed$/),
		]);
		expect(at(w, 'node-prompt').exists()).toBe(false);
	});

	it('the modal marks the alert channels stale before its first screen reads them', async () => {
		mount(Modal, { props: { inputData: { id: 'community_backup', start: 'manage' } }, global: { provide: { $mitt: { emit: vi.fn() } } } });
		await flushPromises();
		expect(H.store.subscriptions).toHaveBeenCalled();
		expect(H.store.staleSubscriptions.mock.invocationCallOrder[0]).toBeLessThan(H.store.subscriptions.mock.invocationCallOrder[0]);
	});

	it('Alerts sets each channel from the server’s list, off as well as on, whenever it is read', async () => {
		draft.state.alerts.telegram = true;
		H.store.subs = [{ id: 'w1', kind: 'webhook', createdAt: 'x' }];
		render(Screen_Alerts);
		await flushPromises();
		expect(draft.state.alerts).toMatchObject({ telegram: false, webhook: true });
		H.store.subs = [{ id: 't1', kind: 'telegram', createdAt: 'x' }];
		await flushPromises();
		expect(draft.state.alerts).toMatchObject({ telegram: true, webhook: false });
	});

	it('a reshare keeps a backup node this device does not list now, as not answering, until the owner removes it', async () => {
		const [gone, ...rest] = NODES;
		H.store.nodes = [SPARE_NODE, ...rest];
		draft.beginReshare(H.store.run);
		expect(draft.nodes.value.map((n) => n.descriptor.id)).toEqual(NODES.map((n) => n.descriptor.id));

		draft.state.nodesLoading = true;
		expect(draft.blockReason.value).toBe('Looking for nodes…');
		const loading = render(Screen_Nodes);
		expect(all(loading, 'node-row').find((r) => r.text().includes(new URL(gone.descriptor.url).host)).text()).toContain('checking…');

		draft.state.nodesLoading = false;
		expect(draft.blockReason.value).toBe('The nodes need attention: open Change settings, then Nodes.');
		const w = render(Screen_Nodes);
		const row = all(w, 'node-row').find((r) => r.text().includes(new URL(gone.descriptor.url).host));
		expect(row.text()).toContain('not answering now');
		expect(all(w, 'node-problem').map((p) => p.text())).toEqual([expect.stringContaining('is not answering now. Remove it, or wait until it answers.')]);

		await row.trigger('click');
		await all(w, 'node-row').find((r) => r.text().includes(new URL(SPARE_NODE.descriptor.url).host)).trigger('click');
		expect(draft.blockReason.value).toBeNull();
		const r = render(Screen_Review);
		expect(at(r, 'nodes-leaving').text()).toBe(`Nodes leaving: ${new URL(gone.descriptor.url).host}`);
		expect(at(r, 'nodes-joining').text()).toBe(`Nodes joining: ${new URL(SPARE_NODE.descriptor.url).host}`);
	});

	it('a reshare does not judge the waiting period it keeps', async () => {
		H.store.run.settings.delaySec = 60;
		draft.beginReshare(H.store.run);
		expect(draft.blockReason.value).toBeNull();
		const a = render(Screen_Advanced);
		expect(disabled(at(a, 'save'))).toBe(false);
	});

	it('offers no spare to a guardian whose piece no longer counts', () => {
		H.store.receipts = { [DARIA.userHash]: 'stored', [MILO.userHash]: 'given_back', [VITALII.userHash]: 'problem', [IVAN.userHash]: 'dropped' };
		const w = render(Screen_Manage);
		expect(rowOf(w, 'Daria').find('[data-test="give-spare"]').exists()).toBe(true);
		for (const name of ['Milo', 'Vitalii', 'Ivan']) expect(rowOf(w, name).find('[data-test="give-spare"]').exists()).toBe(false);
	});

	it('says the backup changed when the run it followed was a reshare, however it was opened', async () => {
		H.store.reshare = makeRun({ runId: 'r2', step: 'registered', secretId: '0x1', version: 3, reshareOf: { secretId: '0x1', version: 2 } });
		H.store.running = true;
		const w = render(Screen_Progress);
		expect(w.text()).toContain('Changing your backup');
		H.store.run = { ...H.store.run, runId: 'r2', version: 3 };
		H.store.reshare = null;
		H.store.running = false;
		await flushPromises();
		expect(nav.replace).toHaveBeenCalledWith('done');
		expect(draft.state.justFinished).toBe('changed');
		expect(at(render(Screen_Done), 'created').text()).toBe('Backup changed. Every piece has been sent.');
	});
});

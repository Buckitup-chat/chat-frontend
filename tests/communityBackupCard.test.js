// @vitest-environment jsdom
// The Community backup card on Security & Recovery (design § 1): what it says
// and offers with no backup, with an unfinished run, and with a finished one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { candidate, fakeBackupStore, makeRun } from './helpers/communityBackup';

const H = vi.hoisted(() => ({ store: null }));
vi.mock('@/store/recoveryBackup.store', () => ({ useRecoveryBackupStore: () => H.store }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ contactsMap: {} }) }));

const { default: Card } = await import('@/components/recovery/backup/CommunityBackupCard.vue');

let opened;
const render = () => {
	opened = [];
	const $modal = ref({ open: (d) => opened.push(d) });
	return mount(Card, { global: { provide: { $modal } } });
};
const text = (w, sel) => w.find(`[data-test="${sel}"]`);

beforeEach(() => {
	H.store = fakeBackupStore();
});

describe('with no backup', () => {
	it('keeps Create off with the reason under it until two guardians agreed', async () => {
		H.store.candidates = [candidate('Daria', 'agreed', 'd'), candidate('Milo', 'waiting', 'm')];
		const w = render();
		await flushPromises();
		expect(text(w, 'agreed').text()).toBe('1 guardian has agreed');
		expect(text(w, 'create').attributes('disabled')).toBeDefined();
		expect(text(w, 'create-reason').text()).toBe('Create backup needs 2 guardians who agreed. 1 more to go.');
		expect(w.text()).not.toContain('Restore');
	});

	it('opens the setup once two agreed', async () => {
		H.store.candidates = [candidate('Daria', 'agreed', 'd'), candidate('Milo', 'agreed', 'm')];
		const w = render();
		await flushPromises();
		expect(text(w, 'create-reason').exists()).toBe(false);
		await text(w, 'create').trigger('click');
		expect(opened).toEqual([{ id: 'community_backup', start: 'guardians' }]);
	});

	it('reads the backup when shown and follows it while shown, and says when this build has no network', async () => {
		const shown = render();
		expect(H.store.load).toHaveBeenCalledTimes(1);
		expect(H.store.follow).toHaveBeenCalledTimes(1);
		shown.unmount();
		expect(H.store.unfollow).toHaveBeenCalledTimes(1);
		H.store = fakeBackupStore({ deployment: null });
		const w = render();
		expect(w.text()).toContain('Not available in this version of the app.');
		expect(H.store.load).not.toHaveBeenCalled();
	});
});

describe('with an unfinished run', () => {
	it('says where it stopped and offers Discard while nothing is on the network', async () => {
		H.store.run = makeRun({ step: 'published' });
		const w = render();
		expect(text(w, 'unfinished').text()).toContain('Your backup was not finished');
		expect(text(w, 'unfinished').text()).toContain('Stopped at step 2 of 6: saving the sealed copy.');
		expect(text(w, 'discard').exists()).toBe(true);
		await text(w, 'discard').trigger('click');
		expect(H.store.discard).toHaveBeenCalled();
	});

	it('from step 3 offers only Continue, which resumes and shows the progress', async () => {
		H.store.run = makeRun({ step: 'registered', secretId: '0x1', version: 1 });
		const w = render();
		expect(text(w, 'unfinished').text()).toContain('Stopped at step 4 of 6: handing the node half to nodes.');
		expect(text(w, 'discard').exists()).toBe(false);
		await text(w, 'continue').trigger('click');
		expect(opened).toEqual([{ id: 'community_backup', start: 'progress' }]);
		expect(H.store.resume).toHaveBeenCalledTimes(1);
	});

	it('on another device shows the progress and never starts a second run', async () => {
		H.store.run = makeRun({ step: 'published', device: 'phone-77' });
		H.store.runsHere = false;
		const w = render();
		expect(text(w, 'unfinished').text()).toContain('being created on your phone-77');
		expect(text(w, 'discard').exists()).toBe(false);
		expect(text(w, 'continue').text()).toBe('Show progress');
		await text(w, 'continue').trigger('click');
		expect(H.store.resume).not.toHaveBeenCalled();
	});
});

describe('with a run another device stopped moving', () => {
	it('offers to continue it on this device', async () => {
		H.store.run = makeRun({ step: 'registered', device: 'phone-lost', updatedAt: Math.floor(Date.now() / 1000) - 3600 });
		H.store.runsHere = false;
		H.store.canTakeOver = true;
		const w = render();
		expect(text(w, 'unfinished').text()).toContain('No progress for 1 hour');
		await text(w, 'take-over').trigger('click');
		expect(H.store.takeOver).toHaveBeenCalled();
		expect(opened).toEqual([{ id: 'community_backup', start: 'progress' }]);
		expect(H.store.resume).not.toHaveBeenCalled();
	});

	it('says so when another tab of this device drives it', () => {
		H.store.run = makeRun({ step: 'published' });
		H.store.runsHere = false;
		H.store.heldElsewhere = true;
		const w = render();
		expect(text(w, 'unfinished').text()).toContain('being created in another tab');
		expect(text(w, 'continue').text()).toBe('Show progress');
		expect(text(w, 'take-over').exists()).toBe(false);
	});
});

describe('with a finished backup', () => {
	const done = (alerts) => {
		const run = makeRun({
			step: 'done',
			settings: { threshold: 2, approvals: 3, spares: 2, delaySec: 86400 * 3, windowSec: 86400 * 7, nodeThreshold: 2 },
			alerts,
			// The guardians' pieces leave the record once sent; the spares stay.
			shares: [null, null, null, 'U1A0', 'U1A1'],
		});
		run.sent = Object.fromEntries(run.guardians.map((g, i) => [g.userHash, { messageId: `m${i}`, shareIndex: i + 1 }]));
		return run;
	};

	it('shows the health line, needed being the larger of pieces and approvals', () => {
		H.store.run = done({ channels: ['app', 'telegram'], skipped: false });
		const w = render();
		expect(w.text()).toContain('0 of 3');
		expect(w.text()).toContain('guardians hold a piece');
		expect(w.text()).toContain('3 needed · 3 pieces on the way · 2 spare pieces · alerts: app, Telegram');
		expect(text(w, 'no-alerts').exists()).toBe(false);
		expect(w.text()).toContain('Manage');
	});

	it('reads the guardians’ receipts when shown, and counts as holders only the pieces stored', async () => {
		H.store.run = done({ channels: ['app', 'telegram'], skipped: false });
		const [a, b, c] = H.store.run.guardians.map((g) => g.userHash);
		H.store.receipts = { [a]: 'stored', [b]: 'delivered', [c]: 'given_back' };
		const w = render();
		await flushPromises();
		expect(H.store.refreshReceipts).toHaveBeenCalledTimes(1);
		expect(w.find('.health-count').text()).toBe('1 of 3');
		expect(w.findAll('.health-seg.held')).toHaveLength(1);
		expect(w.findAll('.health-seg.way')).toHaveLength(1);
		expect(w.text()).toContain('3 needed. Fewer than 3 guardians keep their piece: the backup stopped working.');
	});

	it('counts the spare pieces still in the record, and opens the roster from Manage', async () => {
		H.store.run = done({ channels: ['app', 'telegram'], skipped: false });
		H.store.run.shares[3] = null;
		H.store.run.sparesGiven = { 4: { guardian: H.store.run.guardians[0].userHash, messageId: 'm' } };
		const w = render();
		expect(w.text()).toContain('3 pieces on the way · 1 spare piece · alerts');
		await text(w, 'manage').trigger('click');
		expect(opened).toEqual([{ id: 'community_backup', start: 'manage' }]);
	});

	it('says a revoked backup protects nothing, with no health line', () => {
		H.store.run = { ...done({ channels: ['app', 'telegram'], skipped: false }), revokedAt: 1_700_000_500 };
		const w = render();
		expect(text(w, 'revoked').text()).toBe('This backup was revoked for good. No recovery can use it.');
		expect(w.find('.health').exists()).toBe(false);
		expect(text(w, 'no-alerts').exists()).toBe(false);
	});

	it('warns for as long as no channel outside the app is on', () => {
		H.store.run = done({ channels: ['app'], skipped: true });
		const w = render();
		expect(text(w, 'no-alerts').text()).toContain('No alerts. You may not learn about an attempt in time to stop it.');
		expect(w.text()).toContain('Set up alerts');
	});
});

describe('with a change of the finished backup being made', () => {
	const base = () => {
		const run = makeRun({ step: 'done', secretId: '0x1', version: 1, alerts: { channels: ['app', 'telegram'], skipped: false } });
		run.sent = Object.fromEntries(run.guardians.map((g, i) => [g.userHash, { messageId: `m${i}`, shareIndex: i + 1 }]));
		return run;
	};

	it('shows the change in progress, with Discard while allowed and Continue, over the backup’s health', async () => {
		H.store.run = base();
		H.store.reshare = makeRun({ runId: 'r2', step: 'published', reshareOf: { secretId: '0x1', version: 1 } });
		const w = render();
		await flushPromises();
		expect(text(w, 'unfinished').text()).toContain('The change to your backup was not finished');
		expect(text(w, 'unfinished').text()).toContain('Stopped at step 2 of 6');
		expect(w.find('.health-count').text()).toBe('0 of 3');
		expect(w.text()).not.toContain('Manage');
		await text(w, 'discard').trigger('click');
		expect(H.store.discard).toHaveBeenCalled();
		await text(w, 'continue').trigger('click');
		expect(H.store.resume).toHaveBeenCalled();
		expect(opened).toEqual([{ id: 'community_backup', start: 'progress' }]);
	});

	it('once on the network, offers no Discard; on another device, shows where it runs', () => {
		H.store.run = base();
		H.store.reshare = makeRun({ runId: 'r2', step: 'registered', secretId: '0x1', version: 2, reshareOf: { secretId: '0x1', version: 1 }, device: 'phone-9' });
		H.store.runsHere = false;
		const w = render();
		expect(text(w, 'unfinished').text()).toContain('Your backup is being changed on your phone-9');
		expect(text(w, 'discard').exists()).toBe(false);
		expect(text(w, 'continue').text()).toBe('Show progress');
	});
});

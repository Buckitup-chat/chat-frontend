// @vitest-environment jsdom
// The Community backup card on Security & Recovery (design § 1): what it says
// and offers with no backup, with an unfinished run, and with a finished one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { candidate, fakeBackupStore, makeRun } from './helpers/communityBackup';

const H = vi.hoisted(() => ({ store: null }));
vi.mock('@/store/recoveryBackup.store', () => ({ useRecoveryBackupStore: () => H.store }));

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

	it('reads the backup when shown, and says when this build has no network', async () => {
		render();
		expect(H.store.load).toHaveBeenCalledTimes(1);
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

describe('with a finished backup', () => {
	const done = (alerts) => {
		const run = makeRun({ step: 'done', settings: { threshold: 2, approvals: 3, spares: 2, delaySec: 86400 * 3, windowSec: 86400 * 7, nodeThreshold: 2 }, alerts });
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

	it('warns for as long as no channel outside the app is on', () => {
		H.store.run = done({ channels: ['app'], skipped: true });
		const w = render();
		expect(text(w, 'no-alerts').text()).toContain('No alerts. You may not learn about an attempt in time to stop it.');
		expect(w.text()).toContain('Set up alerts');
	});
});

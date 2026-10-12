// @vitest-environment jsdom
// The last setup step and the run (design §§ 7–8): alerts are set up or
// skipped twice over, Telegram is enrolled from the bot's chat, and the
// progress screen offers Cancel, Retry and Finish-without only when the run
// allows them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { effectScope, nextTick } from 'vue';
import { candidate, fakeBackupStore, fakeNav, hash, makeRun, node } from './helpers/communityBackup';

const H = vi.hoisted(() => ({ store: null, user: null }));
vi.mock('@/store/recoveryBackup.store', () => ({ useRecoveryBackupStore: () => H.store }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => H.user }));
vi.mock('@/utils/copyToClipboard', () => ({ default: vi.fn(async () => true) }));

const { DRAFT, NAV, createBackupDraft } = await import('@/components/recovery/backup/backupFlow');
const { default: Screen_Alerts } = await import('@/components/recovery/backup/Screen_Alerts.vue');
const { default: Screen_Telegram } = await import('@/components/recovery/backup/Screen_Telegram.vue');
const { default: Screen_Progress } = await import('@/components/recovery/backup/Screen_Progress.vue');
const { ALERTS_BOT } = await import('@/config/recovery');

let scope, draft, nav;
const setup = (storeOver = {}) => {
	H.store = fakeBackupStore({
		candidates: [candidate('Daria', 'agreed', 'a'), candidate('Milo', 'agreed', 'b'), candidate('Vitalii', 'agreed', 'c')],
		nodes: [node({ operator: hash('x') }), node({ operator: hash('y') }), node({ operator: hash('z') })],
		...storeOver,
	});
	H.user = { contactsMap: {}, currentUserHash: hash('o') };
	scope = effectScope();
	draft = scope.run(() => createBackupDraft(H.store));
	nav = fakeNav();
};
const render = (C) => mount(C, { global: { provide: { [DRAFT]: draft, [NAV]: nav } } });
const at = (w, sel) => w.find(`[data-test="${sel}"]`);

afterEach(() => {
	scope?.stop();
	vi.useRealTimers();
});

describe('Alerts', () => {
	beforeEach(() => setup());

	it('keeps Next off until a channel outside the app is connected', async () => {
		H.store.addWebhook = vi.fn(async () => ({ id: 's1', secret: 'whsec_once' }));
		const w = render(Screen_Alerts);
		await flushPromises();
		expect(at(w, 'next').attributes('disabled')).toBeDefined();

		await at(w, 'tile-telegram').trigger('click');
		expect(nav.go).toHaveBeenCalledWith('telegram');

		await at(w, 'tile-webhook').trigger('click');
		await w.find('[aria-label="Webhook address"]').setValue('https://hooks.example.org/buckitup');
		await at(w, 'tile-webhook').findAll('button').find((b) => b.text() === 'Connect').trigger('click');
		await flushPromises();
		expect(H.store.addWebhook).toHaveBeenCalledWith('https://hooks.example.org/buckitup');
		expect(at(w, 'tile-webhook').text()).toContain('whsec_once');
		expect(at(w, 'next').attributes('disabled')).toBeUndefined();

		await at(w, 'next').trigger('click');
		expect(nav.go).toHaveBeenLastCalledWith('review');
		expect(draft.startPayload().alerts).toEqual({ channels: ['app', 'webhook'], skipped: false });
	});

	it('counts a channel the account already has', async () => {
		H.store.subscriptions = vi.fn(async () => [{ id: 't', kind: 'telegram', createdAt: '' }]);
		const w = render(Screen_Alerts);
		await flushPromises();
		expect(at(w, 'tile-telegram').text()).toContain('connected');
		expect(at(w, 'next').attributes('disabled')).toBeUndefined();
	});

	it('asks a second time before skipping', async () => {
		const w = render(Screen_Alerts);
		await at(w, 'skip').trigger('click');
		expect(w.text()).toContain('Continue without alerts?');
		expect(w.text()).toContain('Without alerts you may not learn about an attempt in time to stop it.');
		expect(nav.go).not.toHaveBeenCalled();

		await at(w, 'back-to-alerts').trigger('click');
		expect(at(w, 'next').exists()).toBe(true);

		await at(w, 'skip').trigger('click');
		await at(w, 'skip-anyway').trigger('click');
		expect(draft.state.alerts.skipped).toBe(true);
		expect(nav.go).toHaveBeenCalledWith('review');
		expect(draft.startPayload().alerts).toEqual({ channels: ['app'], skipped: true });
	});
});

describe('Telegram', () => {
	beforeEach(() => setup());

	it('sends the address, signs the bot\'s reply, and waits for the bot', async () => {
		vi.useFakeTimers();
		const subs = [[], [{ id: 't', kind: 'telegram', createdAt: '' }]];
		H.store.subscriptions = vi.fn(async () => subs.shift() ?? []);
		H.store.telegramLine = vi.fn(async (text) => {
			if (!text.includes('Backitup')) throw new Error('This is not the message the bot sends for this wallet.');
			return '0xabab 0xsig 1700000000';
		});
		const w = render(Screen_Telegram);
		await vi.waitFor(() => expect(w.text()).toContain('0x' + 'ab'.repeat(20)));
		expect(w.text()).toContain(`Open @${ALERTS_BOT} and send it your address`);
		expect(w.find(`a[href="https://t.me/${ALERTS_BOT}"]`).exists()).toBe(true);

		await w.find('textarea').setValue('hello');
		await w.findAll('button').find((b) => b.text() === 'Continue').trigger('click');
		await vi.waitFor(() => expect(at(w, 'reply-error').text()).toContain('not the message the bot sends'));

		await w.find('textarea').setValue('Backitup notifications subscribe\nwallet: 0xabab');
		await w.findAll('button').find((b) => b.text() === 'Continue').trigger('click');
		await vi.waitFor(() => expect(w.text()).toContain('0xabab 0xsig 1700000000'));
		expect(w.text()).toContain('Waiting for the bot…');
		expect(draft.state.alerts.telegram).toBe(false);

		await vi.advanceTimersByTimeAsync(4000);
		expect(at(w, 'connected').exists()).toBe(false);
		await vi.advanceTimersByTimeAsync(4000);
		await nextTick();
		expect(at(w, 'connected').exists()).toBe(true);
		expect(draft.state.alerts.telegram).toBe(true);
		w.unmount();
	});
});

describe('Progress', () => {
	beforeEach(() => setup());

	const registered = (outcomes, over = {}) =>
		makeRun({
			step: 'registered',
			secretId: '0x1',
			version: 1,
			nodeOutcomes: outcomes,
			sent: { [hash('a')]: { messageId: 'm1', shareIndex: 1 } },
			...over,
		});

	it('offers Cancel at steps 1–2 only', async () => {
		for (const [step, cancel] of [['prepared', true], ['published', true], ['submitted', false], ['registered', false]]) {
			H.store.run = makeRun({ step, secretId: '0x1', version: 1 });
			const w = render(Screen_Progress);
			expect(at(w, 'cancel').exists(), step).toBe(cancel);
			w.unmount();
		}
		H.store.run = makeRun({ step: 'published' });
		const w = render(Screen_Progress);
		await at(w, 'cancel').trigger('click');
		await flushPromises();
		expect(H.store.discard).toHaveBeenCalled();
		expect(nav.close).toHaveBeenCalled();
		w.unmount();
	});

	it('holds Cancel while the run is moving', () => {
		H.store.run = makeRun({ step: 'prepared' });
		H.store.running = true;
		const w = render(Screen_Progress);
		expect(at(w, 'cancel').attributes('disabled')).toBeDefined();
		w.unmount();
	});

	it('offers to finish without a node only when the others reach the threshold', async () => {
		H.store.run = registered({ n1: { state: 'held' }, n2: { state: 'staged' }, n3: { state: 'failed', error: 'down', at: 1 } });
		H.store.stopped = 'nodes_failed';
		let w = render(Screen_Progress);
		expect(at(w, 'nodes-failed').text()).toContain('2 of 3 nodes have their part. 2 are needed, so you can finish without');
		await at(w, 'finish-without').trigger('click');
		expect(H.store.finishWithoutPendingNodes).toHaveBeenCalled();
		await at(w, 'keep-retrying').trigger('click');
		expect(H.store.resume).toHaveBeenCalled();
		w.unmount();

		H.store.run = registered({ n1: { state: 'held' }, n2: { state: 'failed', error: 'down', at: 1 }, n3: { state: 'failed', error: 'down', at: 1 } });
		w = render(Screen_Progress);
		expect(at(w, 'nodes-failed').text()).toContain('1 of 3 nodes have their part. 2 are needed, so the backup waits for more.');
		expect(at(w, 'keep-retrying').exists()).toBe(true);
		expect(at(w, 'finish-without').exists()).toBe(false);
		w.unmount();
	});

	it('shows no finish-without while the run is still going', () => {
		H.store.run = registered({});
		H.store.running = true;
		const w = render(Screen_Progress);
		expect(at(w, 'nodes-failed').exists()).toBe(false);
		expect(at(w, 'finish-without').exists()).toBe(false);
		w.unmount();
	});

	it('marks each guardian sent or waiting', () => {
		H.store.run = registered({ n1: { state: 'held' } });
		H.store.running = true;
		const w = render(Screen_Progress);
		const rows = w.findAll('[data-test="guardian-outcome"]').map((r) => r.text());
		expect(rows).toEqual([expect.stringMatching(/Daria.*sent/), expect.stringMatching(/Milo.*waiting/), expect.stringMatching(/Vitalii.*waiting/)]);
		w.unmount();
	});

	it('on another device shows the banner instead of Continue', () => {
		H.store.run = makeRun({ step: 'published', device: 'laptop-1' });
		H.store.runsHere = false;
		const w = render(Screen_Progress);
		expect(at(w, 'other-device').text()).toContain('Running on your laptop-1');
		expect(at(w, 'continue').exists()).toBe(false);
		expect(at(w, 'cancel').exists()).toBe(false);
		w.unmount();
	});

	it('an interrupted run offers Continue, which resumes', async () => {
		H.store.run = makeRun({ step: 'submitted', secretId: '0x1' });
		const w = render(Screen_Progress);
		expect(at(w, 'interrupted').text()).toContain('The backup already exists on the network');
		await at(w, 'continue').trigger('click');
		expect(H.store.resume).toHaveBeenCalled();
		w.unmount();
	});

	it('hands over to the summary when the run is done', () => {
		H.store.run = makeRun({ step: 'done' });
		const w = render(Screen_Progress);
		expect(nav.replace).toHaveBeenCalledWith('done');
		w.unmount();
	});
});

describe('Review', () => {
	beforeEach(() => setup());

	it('starts the backup with the drafted setup and follows it to the progress screen', async () => {
		const { default: Screen_Review } = await import('@/components/recovery/backup/Screen_Review.vue');
		draft.state.alerts.telegram = true;
		let finish;
		H.store.start = vi.fn(() => new Promise((r) => (finish = r)));
		const w = render(Screen_Review);
		expect(at(w, 'review-headline').text()).toBe('any 2 of 3');
		expect(w.text()).toContain('If fewer than 2 guardians keep their piece, the backup stops working. You will see it here.');

		await at(w, 'create').trigger('click');
		const payload = H.store.start.mock.calls[0][0];
		expect(payload.guardians).toEqual([hash('a'), hash('b'), hash('c')].map((userHash) => ({ userHash, metaAddress: expect.any(String) })));
		expect(payload.settings).toMatchObject({ threshold: 2, approvals: 2, spares: 2, nodeThreshold: 2 });
		expect(payload.nodes).toHaveLength(3);
		expect(payload.fee).toEqual({ kind: 'relayer' });
		expect(payload.alerts).toEqual({ channels: ['app', 'telegram'], skipped: false });
		expect(nav.reset).not.toHaveBeenCalled();

		// The run is saved before anything leaves: from then on the progress screen shows it.
		H.store.run = makeRun({ runId: 'fresh' });
		await nextTick();
		expect(nav.reset).toHaveBeenCalledWith('progress');
		finish();
		w.unmount();
	});

	it('stays put and says why when the backup could not be started', async () => {
		const { default: Screen_Review } = await import('@/components/recovery/backup/Screen_Review.vue');
		draft.state.alerts.skipped = true;
		H.store.start = vi.fn(async () => {
			throw new Error('A backup is already being created.');
		});
		const w = render(Screen_Review);
		await at(w, 'create').trigger('click');
		await flushPromises();
		expect(at(w, 'create-error').text()).toBe('A backup is already being created.');
		expect(nav.reset).not.toHaveBeenCalled();
		w.unmount();
	});
});

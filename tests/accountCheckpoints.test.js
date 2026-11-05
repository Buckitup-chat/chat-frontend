// @vitest-environment jsdom
// The Checkpoints screen: every dialog this device holds a checkpoint for,
// the ones that moved since apart from the ones that did not, what changed,
// and the dialogs that could not be checked — with a way to try again. The
// pure logic and the comparison loader are real; only the dialogs store is
// fake, and it keeps the store's contract: refreshCheckpointAlert returns the
// alert and puts it in checkpointAlerts, null when the dialog holds no
// checkpoint, and throws when the dialog's history did not load.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { useBreakpoint } from '@/composables/useBreakpoint';

const ME = 'u_' + 'a'.repeat(128);
const MILO = 'u_' + 'b'.repeat(128);
const OLENA = 'u_' + 'c'.repeat(128);
const HUB = 'u_' + 'd'.repeat(128);
const STRANGER = 'u_' + 'e'.repeat(128);

const H = vi.hoisted(() => ({ dialogs: null, user: null }));
vi.mock('@/store/dialogs.store', () => ({ useDialogsStore: () => H.dialogs }));
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => H.user }));

const { default: Page } = await import('@/views/account/Page_Account_Checkpoints.vue');

const at = (month, day, h, m) => Math.floor(new Date(new Date().getFullYear(), month, day, h, m).getTime() / 1000);

/**
 * The dialogs as the store would find them. Per peer: the checkpoint
 * (messageId, createdAt), whether the view moved, what the comparison
 * shows, and how many checks fail before one succeeds.
 */
let world;

const fakeDialogs = () => {
	const store = reactive({
		checkpointAlerts: new Map(),
		async checkpointPeers(peers) {
			return peers.filter((p) => p && p !== ME && world.has(p));
		},
		async refreshCheckpointAlert(peerHash) {
			const d = world.get(peerHash);
			if (d.hold) await d.hold;
			if (d.fails > 0) {
				d.fails -= 1;
				throw new Error('refresh budget exceeded');
			}
			if (!d.messageId) {
				const next = new Map(store.checkpointAlerts);
				next.delete(peerHash);
				store.checkpointAlerts = next;
				return null;
			}
			const alert = { changed: d.changed, createdAt: d.createdAt, messageId: d.messageId };
			store.checkpointAlerts = new Map(store.checkpointAlerts).set(peerHash, alert);
			return alert;
		},
		async readCheckpointPart(peerHash, messageId) {
			const d = world.get(peerHash);
			return d?.messageId === messageId ? { kind: 'checkpoint', createdAt: d.createdAt } : null;
		},
		async verifyDialogCheckpoint() {
			return { status: 'valid' };
		},
		async compareDialogCheckpoint(peerHash) {
			return { verdict: world.get(peerHash).changed ? 'VIEW_CHANGED' : 'EXACT_MATCH' };
		},
		async describeCheckpointDiff(peerHash) {
			const d = world.get(peerHash);
			return { status: 'ok', changes: d.changes ?? [], futureAdded: d.futureAdded ?? { count: 0, firstMessageId: null } };
		},
	});
	return store;
};

const card = (user_hash, name) => ({ user_hash, name });

const push = vi.fn();
const render = () => mount(Page, {
	global: {
		provide: { $router: { push } },
		stubs: { FullContentBlock: { template: '<div><slot name="header" /><slot name="content" /></div>' } },
	},
});

/** The checks run one after another; let them all land. */
const settle = async () => {
	for (let i = 0; i < 20; i++) await flushPromises();
};

const groupText = (w, which) => w.find(`[data-test="checkpoints-${which}"]`);
const row = (w, peerHash) => w.find(`[data-peer="${peerHash}"]`);

const setWidth = (px) => {
	window.innerWidth = px;
	useBreakpoint().init();
};

beforeEach(() => {
	push.mockReset();
	setWidth(1280);
	world = new Map();
	H.dialogs = fakeDialogs();
	H.user = reactive({
		currentUser: { user_hash: ME },
		currentUserHash: ME,
		allNetworkUsers: [card(ME, 'Me'), card(MILO, 'Milo'), card(OLENA, 'Olena'), card(HUB, 'Kyiv Hub'), card(STRANGER, 'Stranger')],
		contactsMap: {},
		getUserByHash(h) { return this.allNetworkUsers.find((u) => u.user_hash === h); },
	});
});

afterEach(() => setWidth(1024));

const milo = () => world.set(MILO, {
	messageId: 'dmsg_cp_milo', createdAt: at(9, 12, 18, 4), changed: true,
	changes: [
		{ type: 'MESSAGE_EDITED', messageId: 'dmsg_1', senderHash: MILO, oldText: 'Meet at six', newText: 'Meet at seven' },
		{ type: 'MESSAGE_EDITED', messageId: 'dmsg_2', senderHash: MILO, oldText: 'The deposit is 200', newText: 'The deposit is 150' },
		{ type: 'MESSAGE_DELETED', messageId: 'dmsg_3', senderHash: MILO, oldText: "I'll bring the keys on Friday" },
	],
	futureAdded: { count: 3, firstMessageId: 'dmsg_9' },
});
const olena = (extra = {}) => world.set(OLENA, { messageId: 'dmsg_cp_olena', createdAt: at(9, 3, 9, 12), changed: false, ...extra });
const hub = () => world.set(HUB, { messageId: 'dmsg_cp_hub', createdAt: at(8, 28, 14, 40), changed: false });

describe('the Checkpoints screen', () => {
	it('with no checkpoint on this device, says how to sign one', async () => {
		const w = render();
		await settle();
		expect(w.find('[data-test="checkpoints-empty"]').text()).toContain('No checkpoints yet');
		expect(w.text()).toContain('Open a dialog and tap the checkpoint button at the top');
		expect(groupText(w, 'changed').exists()).toBe(false);
		expect(groupText(w, 'unchanged').exists()).toBe(false);
		expect(w.find('[data-test="checkpoints-loading"]').exists()).toBe(false);
	});

	it('a pointer whose dialog turns out to hold no checkpoint is not listed', async () => {
		world.set(OLENA, { messageId: null });
		const w = render();
		await settle();
		expect(row(w, OLENA).exists()).toBe(false);
		expect(w.find('[data-test="checkpoints-empty"]').exists()).toBe(true);
	});

	it('puts the dialogs that moved apart from those that did not, with what changed', async () => {
		milo(); olena(); hub();
		const w = render();
		await settle();

		expect(w.find('[data-test="checkpoints-empty"]').exists()).toBe(false);
		expect(w.text()).toContain('Changed · 1');
		expect(w.text()).toContain('Unchanged · 2');

		const changed = groupText(w, 'changed');
		expect(changed.findAll('.ui-row')).toHaveLength(1);
		expect(row(w, MILO).text()).toContain('Milo');
		expect(row(w, MILO).text()).toContain('2 edits, 1 deleted · 3 new after');
		expect(row(w, MILO).text()).toContain('checkpoint 12 Oct, 18:04');
		expect(row(w, MILO).find('._dot').exists()).toBe(true);

		const unchanged = groupText(w, 'unchanged');
		// newest checkpoint first
		expect(unchanged.findAll('.ui-row').map((r) => r.attributes('data-peer'))).toEqual([OLENA, HUB]);
		expect(row(w, OLENA).text()).toContain('Unchanged');
		expect(row(w, OLENA).text()).toContain('checkpoint 3 Oct, 09:12');
		expect(row(w, HUB).text()).toContain('checkpoint 28 Sep, 14:40');
		expect(row(w, OLENA).find('._icon_verified').exists()).toBe(true);

		// a peer without a pointer is never checked or listed
		expect(row(w, STRANGER).exists()).toBe(false);
	});

	it('on a desktop shows the comparison beside the list, from the dialog\'s own diff', async () => {
		milo(); olena();
		const w = render();
		await settle();

		const panel = w.find('[data-test="checkpoints-panel"]');
		expect(panel.text()).toContain('Milo · since the checkpoint');
		expect(panel.text()).toContain('12 Oct, 18:04 · 3 changes to signed history · 3 new after');
		expect(panel.findAll('.cd-change')).toHaveLength(4); // three changes and the "after" marker
		expect(panel.find('mark.cd-added').text()).toBe('seven');
		expect(row(w, MILO).classes()).toContain('_selected');

		await panel.find('.ui-btn').trigger('click');
		expect(push).toHaveBeenLastCalledWith({ name: 'chat', params: { address: MILO } });
		await panel.find('.cd-change').trigger('click');
		expect(push).toHaveBeenLastCalledWith({ name: 'chat', params: { address: MILO }, query: { checkpoint: 'dmsg_cp_milo' } });
	});

	it('on a phone opens the dialog on its comparison instead', async () => {
		setWidth(390);
		milo();
		const w = render();
		await settle();
		expect(w.find('[data-test="checkpoints-panel"]').exists()).toBe(false);
		await row(w, MILO).trigger('click');
		expect(push).toHaveBeenCalledWith({ name: 'chat', params: { address: MILO }, query: { checkpoint: 'dmsg_cp_milo' } });
	});

	it('shows what is already checked while the rest load', async () => {
		let release;
		olena({ hold: new Promise((r) => { release = r; }) });
		hub();
		// the dialogs list's sweep already checked Olena this session
		H.dialogs.checkpointAlerts = new Map([[OLENA, { changed: false, createdAt: at(9, 3, 9, 12), messageId: 'dmsg_cp_olena' }]]);
		const w = render();
		await settle();

		expect(row(w, OLENA).text()).toContain('Unchanged');
		const loading = w.find('[data-test="checkpoints-loading"]');
		expect(loading.text()).toContain('Checking 2 dialogs…');
		expect(loading.findAll('._skel_row')).toHaveLength(1); // Kyiv Hub, nothing known yet
		expect(w.find('[data-test="checkpoints-empty"]').exists()).toBe(false);

		release();
		await settle();
		expect(w.find('[data-test="checkpoints-loading"]').exists()).toBe(false);
		expect(row(w, HUB).text()).toContain('Unchanged');
	});

	it('names the dialogs it could not check, keeps the rest, and tries again', async () => {
		milo();
		olena({ fails: 1 });
		const w = render();
		await settle();

		const error = w.find('[data-test="checkpoints-error"]');
		expect(error.text()).toContain("Couldn't check 1 dialog");
		expect(error.text()).toContain("Its history didn't load on this device. The other results are up to date.");
		expect(row(w, OLENA).exists()).toBe(false);
		expect(row(w, MILO).text()).toContain('2 edits, 1 deleted · 3 new after');
		expect(w.find('[data-test="checkpoints-empty"]').exists()).toBe(false);

		await w.find('[data-test="checkpoints-retry"]').trigger('click');
		await settle();
		expect(w.find('[data-test="checkpoints-error"]').exists()).toBe(false);
		expect(row(w, OLENA).text()).toContain('Unchanged');
	});

	it('does not show a stale result for a dialog whose check failed', async () => {
		olena({ fails: 1 });
		H.dialogs.checkpointAlerts = new Map([[OLENA, { changed: false, createdAt: at(9, 3, 9, 12), messageId: 'dmsg_cp_olena' }]]);
		const w = render();
		await settle();
		expect(w.find('[data-test="checkpoints-error"]').exists()).toBe(true);
		expect(row(w, OLENA).exists()).toBe(false);
	});
});

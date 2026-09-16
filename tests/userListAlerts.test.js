// @vitest-environment jsdom
// The dot on the dialogs list: it appears for peers the store flags, the scan
// is kicked off on open, and it does not collide with the transfer marker.
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const PEER_A = 'u_' + 'a'.repeat(128);
const PEER_B = 'u_' + 'b'.repeat(128);

const scanCheckpointAlerts = vi.fn();
let alerting = new Set();
let alertEntries = new Map();
let transferPeers = new Set();

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({
		allNetworkUsers: [
			{ user_hash: PEER_A, name: 'Ирина' },
			{ user_hash: PEER_B, name: 'Пётр' },
		],
		currentUserHash: 'u_' + 'f'.repeat(128),
	}),
}));
vi.mock('@/store/dialogs.store', () => ({
	useDialogsStore: () => ({ alertingPeers: alerting, checkpointAlerts: alertEntries, scanCheckpointAlerts }),
}));
vi.mock('@/store/transfers.store', () => ({
	useTransfersStore: () => ({ transferPeers }),
}));

const UserList = (await import('@/components/UserList.vue')).default;

const mountList = () => {
	setActivePinia(createPinia());
	return mount(UserList, {
		props: { selected: [] },
		global: { stubs: { Account_Item_PQ: true, SyncStatus: true } },
	});
};

describe('checkpoint alerts in the dialogs list', () => {
	it('scans the listed peers when the list opens', () => {
		scanCheckpointAlerts.mockClear();
		mountList();
		expect(scanCheckpointAlerts).toHaveBeenCalledWith([PEER_A, PEER_B]);
	});

	it('marks only the dialogs that moved', () => {
		alerting = new Set([PEER_B]);
		const w = mountList();
		const dots = w.findAll('._checkpoint_dot');
		expect(dots).toHaveLength(1);
		expect(w.findAll('._user')[1].find('._checkpoint_dot').exists()).toBe(true);
		expect(w.findAll('._user')[0].find('._checkpoint_dot').exists()).toBe(false);
	});

	it('shows nothing when no checkpoint has moved', () => {
		alerting = new Set();
		expect(mountList().findAll('._checkpoint_dot')).toHaveLength(0);
	});

	// The dot's entire purpose is the payload: it opens the dialog ALREADY
	// asking for this alert's comparison, and it must not double-fire the
	// row's plain select underneath (.stop).
	it('tapping the dot selects the peer with that checkpoint, once', async () => {
		const CP_ID = 'dmsg_0192aaaa-0000-7000-8000-0000000000ff';
		alerting = new Set([PEER_A]);
		alertEntries = new Map([[PEER_A, { changed: true, messageId: CP_ID }]]);
		const w = mountList();
		await w.find('._checkpoint_dot').trigger('click');
		expect(w.emitted('select')).toEqual([[PEER_A, { checkpoint: CP_ID }]]);
		alertEntries = new Map();
	});

	it('sits alongside the transfer marker rather than replacing it', () => {
		alerting = new Set([PEER_A]);
		transferPeers = new Set([PEER_A]);
		const row = mountList().findAll('._user')[0];
		expect(row.find('._transfer_dot').exists()).toBe(true);
		expect(row.find('._checkpoint_dot').exists()).toBe(true);
		transferPeers = new Set();
	});
});

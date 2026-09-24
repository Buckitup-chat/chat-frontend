// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reactive, nextTick, watch } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
	_setStorageForTests, enqueue, recordFailure, markServerAccepted, markReconciled, resolveEntry,
	requeueEntry, discardEntry,
} from '@/lib/data/outbox';
import { accountSyncState, useAccountSyncStatus } from '@/composables/useAccountSyncStatus';
import { _setIntentStorageForTests, enqueueIntent, updateIntent, resolveIntent } from '@/lib/data/intents';
import { effectScope } from 'vue';
import { IngestError } from '@/lib/data/ingest';
import type { StringStore } from '@/lib/data/secureStore';
import type { AccountSyncState } from '@/composables/useAccountSyncStatus';

const ME = 'u_' + 'f'.repeat(128);
const OTHER = 'u_' + 'e'.repeat(128);
const PEER = 'u_' + 'a'.repeat(128);

const userPQ = reactive({
	allNetworkUsers: [{ user_hash: PEER, name: 'Peer' }],
	currentUserHash: ME,
	isOnline: true,
});

vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => userPQ }));
vi.mock('@/store/dialogs.store', () => ({
	useDialogsStore: () => ({ alertingPeers: new Set(), checkpointAlerts: new Map(), scanCheckpointAlerts: () => {} }),
}));
vi.mock('@/store/transfers.store', () => ({
	useTransfersStore: () => ({ transferPeers: new Set() }),
}));

const UserList = (await import('@/components/UserList.vue')).default;

const memoryStore = () => ({
	_map: new Map<string, string>(),
	async get(k: string) { return this._map.get(k) ?? null; },
	async set(k: string, v: string) { this._map.set(k, v); },
	async delete(k: string) { this._map.delete(k); },
	async keys() { return [...this._map.keys()]; },
	async clear() { this._map.clear(); },
});

const message = { type: 'insert', syncMetadata: { relation: 'dialog_messages' } };

const mountList = () => {
	setActivePinia(createPinia());
	return mount(UserList, { props: { selected: [] }, global: { stubs: { Account_Item_PQ: true } } });
};
const statusText = (w: ReturnType<typeof mountList>) => w.find('.sync-status .status-text').text();
const statusDot = (w: ReturnType<typeof mountList>) => w.find('.sync-status .status-dot');
const rejected = () => new IngestError('ingest HTTP 422', { permanent: true, status: 422 });

let currentStore: StringStore;

beforeEach(() => {
	currentStore = memoryStore();
	_setStorageForTests(currentStore);
	_setIntentStorageForTests(memoryStore());
	userPQ.currentUserHash = ME;
	userPQ.isOnline = true;
});

describe('global sync status', () => {
	it('is Synced when online with an empty queue', async () => {
		const w = mountList();
		await vi.waitFor(() => expect(statusText(w)).toBe('Synced'));
	});

	it('is Offline without a connection, whatever the queue holds', async () => {
		userPQ.isOnline = false;
		const w = mountList();
		await vi.waitFor(() => expect(statusText(w)).toBe('Offline'));
	});

	it('an offline write keeps the chip off Synced once the connection returns, until it lands', async () => {
		userPQ.isOnline = false;
		const w = mountList();
		const id = await enqueue([message], ME);
		await recordFailure(id, new IngestError('ingest network error', { permanent: false }));
		await vi.waitFor(() => expect(statusText(w)).toBe('Offline'));

		userPQ.isOnline = true;
		await vi.waitFor(() => expect(statusText(w)).toBe('Syncing'));
	});

	it('follows one write through pending → SERVER_ACCEPTED → reconciled; only the last is Synced', async () => {
		const w = mountList();
		await vi.waitFor(() => expect(statusText(w)).toBe('Synced'));

		const id = await enqueue([message], ME);
		await vi.waitFor(() => expect(statusText(w)).toBe('Syncing'));

		await recordFailure(id, new IngestError('ingest HTTP 503', { permanent: false, status: 503 }));
		await markServerAccepted(id);
		await nextTick();
		await vi.waitFor(() => expect(statusText(w)).toBe('Syncing'));

		await markReconciled(id);
		await resolveEntry(id);
		await vi.waitFor(() => expect(statusText(w)).toBe('Synced'));
	});

	it("another account's queued writes do not count against this account", async () => {
		const w = mountList();
		await enqueue([message], OTHER);
		await vi.waitFor(() => expect(statusText(w)).toBe('Synced'));
	});

	it('a quarantined write is Needs attention, never the green Synced', async () => {
		const w = mountList();
		await vi.waitFor(() => expect(statusText(w)).toBe('Synced'));

		const id = await enqueue([message], ME);
		await recordFailure(id, rejected());

		await vi.waitFor(() => expect(statusText(w)).toBe('Needs attention'));
		expect(statusDot(w).classes()).toContain('needs_attention');
		expect(statusDot(w).classes()).not.toContain('synced');
	});

	it('Retry on a quarantined write (requeue) is Syncing again', async () => {
		const id = await enqueue([message], ME) as string;
		await recordFailure(id, rejected());
		const w = mountList();
		await vi.waitFor(() => expect(statusText(w)).toBe('Needs attention'));

		await requeueEntry(id);

		await vi.waitFor(() => expect(statusText(w)).toBe('Syncing'));
	});

	it('discarding the last quarantined write is Synced', async () => {
		const id = await enqueue([message], ME) as string;
		await recordFailure(id, rejected());
		const w = mountList();
		await vi.waitFor(() => expect(statusText(w)).toBe('Needs attention'));

		await discardEntry(id);

		await vi.waitFor(() => expect(statusText(w)).toBe('Synced'));
	});

	it('switching from an empty account never shows the previous Synced for the next one', async () => {
		await enqueue([message], OTHER);
		const w = mountList();
		await vi.waitFor(() => expect(statusText(w)).toBe('Synced'));

		let openRead!: (value?: unknown) => void;
		const gate = new Promise((resolve) => { openRead = resolve; });
		const readKeys = currentStore.keys.bind(currentStore);
		currentStore.keys = async () => { await gate; return readKeys(); };

		userPQ.currentUserHash = OTHER;
		await nextTick();
		expect(statusText(w)).toBe('Syncing');

		openRead();
		await vi.waitFor(() => expect(statusText(w)).toBe('Syncing'));
		await nextTick();
		expect(statusText(w)).toBe('Syncing');
	});
});

describe('global sync status priority', () => {
	it('orders offline, unknown, attention, unfinished, synced', () => {
		expect(accountSyncState(false, { intents: 0, unfinished: 0, quarantined: 1 })).toBe('offline');
		expect(accountSyncState(true, null)).toBe('syncing');
		expect(accountSyncState(true, { intents: 1, unfinished: 3, quarantined: 1 })).toBe('needs_attention');
		expect(accountSyncState(true, { intents: 0, unfinished: 0, quarantined: 1 })).toBe('needs_attention');
		expect(accountSyncState(true, { intents: 0, unfinished: 1, quarantined: 0 })).toBe('syncing');
		expect(accountSyncState(true, { intents: 1, unfinished: 0, quarantined: 0 })).toBe('syncing');
		expect(accountSyncState(true, { intents: 0, unfinished: 0, quarantined: 0 })).toBe('synced');
	});

	it('an unreadable queue is Syncing, not Synced', async () => {
		_setStorageForTests({ ...memoryStore(), async keys() { throw new Error('storage unavailable'); } });
		const w = mountList();
		await nextTick();
		await vi.waitFor(() => expect(statusText(w)).toBe('Syncing'));
	});
});

describe('global sync status: durable intents not yet in the outbox', () => {
	const unsignedMessage = { kind: 'message', relation: 'dialog_messages', messageId: 'dmsg_x' };

	const recordChip = (userHash = () => ME) => {
		const scope = effectScope();
		const seen: AccountSyncState[] = [];
		scope.run(() => {
			const state = useAccountSyncStatus(userHash, () => true);
			watch(state, (v) => seen.push(v), { immediate: true, flush: 'sync' });
		});
		return { seen, stop: () => scope.stop() };
	};

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it('an unsigned durable intent with no outbox entry is Syncing, never Synced', async () => {
		const intentId = await enqueueIntent(unsignedMessage, ME, 'dialog_messages') as string;
		const chip = recordChip();
		const w = mountList();
		await settle();

		expect(chip.seen).toEqual(['syncing']);
		expect(statusText(w)).toBe('Syncing');

		await resolveIntent(intentId, { outcome: 'superseded' });
		await vi.waitFor(() => expect(chip.seen.at(-1)).toBe('synced'));
		chip.stop();
	});

	it('a new intent flips an already Synced chip to Syncing', async () => {
		const w = mountList();
		await vi.waitFor(() => expect(statusText(w)).toBe('Synced'));

		await enqueueIntent(unsignedMessage, ME, 'dialog_messages');

		await vi.waitFor(() => expect(statusText(w)).toBe('Syncing'));
	});

	it('intent → outbox entry → resolved intent marker → reconciled never shows Synced before the end', async () => {
		const chip = recordChip();
		await vi.waitFor(() => expect(chip.seen.at(-1)).toBe('synced'));
		chip.seen.length = 0;

		const intentId = await enqueueIntent(unsignedMessage, ME, 'dialog_messages') as string;
		await vi.waitFor(() => expect(chip.seen).toContain('syncing'));
		await updateIntent(intentId, { ...unsignedMessage, signedMutation: message });
		const outboxId = await enqueue([message], ME, { sourceIntentId: intentId });
		await resolveIntent(intentId, { outcome: 'durably-dispatched', ref: outboxId });
		await markServerAccepted(outboxId);
		await nextTick();
		expect(chip.seen).not.toContain('synced');

		await markReconciled(outboxId);
		await resolveEntry(outboxId);
		await vi.waitFor(() => expect(chip.seen.at(-1)).toBe('synced'));
		expect(chip.seen.slice(0, -1)).not.toContain('synced');
		chip.stop();
	});

	it("another account's unresolved intent does not affect this account", async () => {
		await enqueueIntent(unsignedMessage, OTHER, 'dialog_messages');
		const w = mountList();
		await vi.waitFor(() => expect(statusText(w)).toBe('Synced'));
	});
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
	_setStorageForTests, startLeaderElection, stopLeaderElection,
	pendingEntries, quarantinedEntries, recordFailure, markServerAccepted,
} from '@/lib/data/outbox';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setOwnObservedTailsStorageForTests } from '@/lib/data/ownObservedTails';
import { _setProjectionStorageForTests } from '@/lib/data/messageProjections';
import { IngestError } from '@/lib/data/ingest';
import { _setIntentStorageForTests, intentsOf } from '@/lib/data/intents';
import { effectScope, nextTick } from 'vue';
import { useAccountSyncStatus } from '@/composables/useAccountSyncStatus';
import type * as Ingest from '@/lib/data/ingest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const PEER_HASH = 'u_' + 'b'.repeat(128);
const DIALOG_HASH = 'di_' + '3'.repeat(128);

const memoryStore = () => ({
	_map: new Map<string, string>(),
	async get(k: string) { return this._map.get(k) ?? null; },
	async set(k: string, v: string) { this._map.set(k, v); },
	async delete(k: string) { this._map.delete(k); },
	async keys() { return [...this._map.keys()]; },
	async clear() { this._map.clear(); },
});

const makeCollection = (rows: Record<string, unknown> = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key: string) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
});

type Collection = ReturnType<typeof makeCollection>;

let collections: {
	cards: Collection;
	dialog: { keys: Collection; messages: Collection; reactions: Collection; receipts: Collection; versions: Collection };
};
let networkSend: (mutations: unknown[]) => Promise<unknown>;

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: MY_HASH }),
}));

vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

vi.mock('@/lib/data/ingest', async (importActual) => {
	const actual = await importActual<typeof Ingest>();
	return {
		...actual,
		sendMutationsAndAwaitShape: async (mutations: unknown[], _skey: unknown, opts: { sourceIntentId?: string; onDurable?: (outboxId: string | null) => unknown } = {}) => {
			const outbox = await import('@/lib/data/outbox');
			const outboxId = await outbox.enqueue(mutations, MY_HASH, { sourceIntentId: opts.sourceIntentId });
			await opts.onDurable?.(outboxId);
			try {
				await networkSend(mutations);
			} catch (e) {
				await outbox.recordFailure(outboxId, e);
				throw e;
			}
			await outbox.markServerAccepted(outboxId);
			return { outboxId, phase: 'accepted', acceptance: outbox.awaitEntryOutcome(outboxId!, MY_HASH) };
		},
	};
});

vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string) => ({
			type, relation, row,
			changes: { ...row, sign_hash: `sign_hash(${row.message_id})` },
			syncMetadata: { relation },
		}),
	},
}));

vi.mock('@/libs/enigma', () => ({
	decodeHexOrBase64: (s: string) => (s ? new Uint8Array([1, 2, 3]) : null),
}));

let vaultLocked: boolean;
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			currentUserHash: MY_HASH,
			exportVaultKeys: async () => {
				if (vaultLocked) throw new Error('vault is locked');
				return { sign_skey: 'AAAA', crypt_skey: 'AAAA', evm_skey: 'cc' };
			},
		}),
	},
}));

vi.mock('@/libs/DialogCrypto', () => ({
	DialogCrypto: {
		computeDialogHash: () => DIALOG_HASH,
		deriveSenderMsgKey: () => new Uint8Array(32),
		wrapSenderMsgKey: async () => ({ peerKemWrapKeyB64: 'wrap', peerWrappedMsgKeyB64: 'wrapped' }),
		encryptContent: async (_k: unknown, text: string) => `enc(${text})`,
		decryptContent: async () => null,
	},
}));

const { useDialogsStore } = await import('@/store/dialogs.store');

beforeEach(() => {
	vaultLocked = false;
	_setIntentStorageForTests(memoryStore());
	stopLeaderElection();
	startLeaderElection(MY_HASH, () => {});
	setActivePinia(createPinia());
	_setStorageForTests(memoryStore());
	_setAcceptedSnapshotStorageForTests(memoryStore());
	_setProjectionStorageForTests((() => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); }, keys: async () => [...m.keys()], clear: async () => { m.clear(); } }; })());
	_setOwnObservedTailsStorageForTests(memoryStore());
	collections = {
		cards: makeCollection({ [PEER_HASH]: { user_hash: PEER_HASH, crypt_pkey: 'AAAA' } }),
		dialog: {
			keys: makeCollection({
				[`${DIALOG_HASH}|${MY_HASH}`]: { dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, peer_hash: PEER_HASH, deleted_flag: false },
			}),
			messages: makeCollection(),
			reactions: makeCollection(),
			receipts: makeCollection(),
			versions: makeCollection(),
		},
	};
	networkSend = async () => ({ txids: [] });
});

const watchGlobalChip = () => {
	const scope = effectScope();
	const state = scope.run(() => useAccountSyncStatus(() => MY_HASH, () => true))!;
	return { state, stop: () => scope.stop() };
};

const sendFromChat = async (text: string) => {
	const store = useDialogsStore();
	const captured = await store.captureMessageIntent(PEER_HASH, text);
	const optimisticId = store.addOptimisticMessageWithId(DIALOG_HASH, captured.payload.messageId, text, captured.payload.ownerTimestamp as never);
	const statuses: string[] = [];
	await store.dispatchMessageIntent(captured.intentId, captured.payload, captured.token, (s: string) => {
		statuses.push(s);
		store.updateOptimisticStatus(optimisticId, s);
	});
	return { store, optimisticId, statuses };
};

describe('message status follows the durable outbox entry', () => {
	it('exact success is SERVER_ACCEPTED — one check, not yet a delivery', async () => {
		const { store, optimisticId, statuses } = await sendFromChat('hello');

		expect(statuses).toEqual(['syncing', 'synced']);
		expect(store.optimisticItems.get(optimisticId).status).toBe('synced');
	});

	it('offline: the message is durably queued for retry, not shown as failed', async () => {
		networkSend = async () => {
			throw new IngestError('ingest network error: TypeError: Failed to fetch', { permanent: false });
		};

		const { store, optimisticId, statuses } = await sendFromChat('written offline');

		expect(statuses).toEqual(['syncing', 'queued']);
		expect(store.optimisticItems.get(optimisticId).status).toBe('queued');
		const [entry] = await pendingEntries(MY_HASH);
		expect(entry.relation).toBe('dialog_messages');
		expect(entry.nextAttemptAt).toBeGreaterThan(0);
	});

	it('retryable failure: the retry\'s exact SERVER_ACCEPTED alone turns the queued bubble into one check', async () => {
		networkSend = async () => {
			throw new IngestError('ingest HTTP 503', { permanent: false, status: 503 });
		};
		const { store, optimisticId, statuses } = await sendFromChat('retry me');
		expect(statuses).toEqual(['syncing', 'queued']);

		const [entry] = await pendingEntries(MY_HASH);
		await markServerAccepted(entry.id);

		await vi.waitFor(() => expect(store.optimisticItems.get(optimisticId).status).toBe('synced'));
		expect(statuses).toEqual(['syncing', 'queued', 'synced']);
		expect((await pendingEntries(MY_HASH)).map((e) => e.status)).toEqual(['server_accepted_pending_reconcile']);
		expect(store.optimisticItems.has(optimisticId)).toBe(true);
	});

	it('retryable failure that a later attempt gets permanently rejected ends in the red "!"', async () => {
		networkSend = async () => {
			throw new IngestError('ingest HTTP 503', { permanent: false, status: 503 });
		};
		const { store, optimisticId, statuses } = await sendFromChat('doomed later');
		const [entry] = await pendingEntries(MY_HASH);

		await recordFailure(entry.id, new IngestError('ingest HTTP 422', { permanent: true, status: 422 }));

		await vi.waitFor(() => expect(store.optimisticItems.get(optimisticId).status).toBe('error'));
		expect(statuses).toEqual(['syncing', 'queued', 'error']);
	});

	it('permanent rejection on the first attempt is quarantined and shown as the red "!" at once', async () => {
		networkSend = async () => {
			throw new IngestError('ingest HTTP 422', { permanent: true, status: 422 });
		};

		const { store, optimisticId, statuses } = await sendFromChat('rejected');

		expect(statuses).toEqual(['syncing', 'error']);
		expect(store.optimisticItems.get(optimisticId).status).toBe('error');
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);
	});
});

describe('before the outbox: a durable intent is not a failure', () => {
	it('a locked vault shows 🔒 awaiting_unlock, the chip stays Syncing, no network attempt is recorded', async () => {
		vaultLocked = true;
		const chip = watchGlobalChip();

		const { store, optimisticId, statuses } = await sendFromChat('while locked');

		expect(statuses).toEqual(['syncing', 'awaiting_unlock']);
		expect(store.optimisticItems.get(optimisticId).status).toBe('awaiting_unlock');
		expect((await intentsOf(MY_HASH)).entries).toHaveLength(1);
		expect(await pendingEntries(MY_HASH)).toEqual([]);
		await vi.waitFor(() => expect(chip.state.value).toBe('syncing'));
		await nextTick();
		expect(chip.state.value).toBe('syncing');
		chip.stop();
	});

	it('a retryable prerequisite failure (own dialog key cannot be published offline) is awaiting_recovery, not "!"', async () => {
		collections.dialog.keys.rows.clear();
		networkSend = async () => {
			throw new IngestError('ingest network error: TypeError: Failed to fetch', { permanent: false });
		};
		const chip = watchGlobalChip();

		const { store, optimisticId, statuses } = await sendFromChat('first message, offline');

		expect(statuses).toEqual(['syncing', 'awaiting_recovery']);
		expect(store.optimisticItems.get(optimisticId).status).toBe('awaiting_recovery');
		const { entries } = await intentsOf(MY_HASH);
		expect(entries.map((e) => e.relation)).toContain('dialog_messages');
		expect((await pendingEntries(MY_HASH)).map((e) => e.relation)).toEqual(['dialog_keys']);
		await vi.waitFor(() => expect(chip.state.value).toBe('syncing'));
		chip.stop();
	});

	it('a permanently rejected prerequisite is still the red "!"', async () => {
		collections.dialog.keys.rows.clear();
		networkSend = async () => {
			throw new IngestError('ingest HTTP 422', { permanent: true, status: 422 });
		};

		const { statuses } = await sendFromChat('key rejected');

		expect(statuses).toEqual(['syncing', 'error']);
	});
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { _setStorageForTests, startLeaderElection, stopLeaderElection } from '@/lib/data/outbox';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setOwnObservedTailsStorageForTests } from '@/lib/data/ownObservedTails';
import { _setProjectionStorageForTests } from '@/lib/data/messageProjections';
import { _setIntentStorageForTests } from '@/lib/data/intents';
import type * as Ingest from '@/lib/data/ingest';
import { makeTestIdentity, signedDialogKeyRow } from './helpers/signedFixtures';

// The dialogs store tells listeners of every message this account stores
// for sending, once it is durable: the avatars store sends its gallery into
// a dialog from there (pq_avatars § Delivery, rule 2). Harness as in
// messageSyncStatus.test.ts.

const ME = makeTestIdentity(1, 'me');
const PEER = makeTestIdentity(2, 'peer');
const MY_HASH = ME.userHash;
const PEER_HASH = PEER.userHash;
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
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string) => {
			const signed = { ...row, sign_hash: `sign_hash(${row.message_id})` };
			return type === 'insert'
				? { type, relation, row, modified: signed, syncMetadata: { relation } }
				: { type, relation, row, original: {}, changes: signed, syncMetadata: { relation } };
		},
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
				return ME.vault;
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
		cards: makeCollection({ [MY_HASH]: ME.card, [PEER_HASH]: PEER.card }),
		dialog: {
			keys: makeCollection({
				[`${DIALOG_HASH}|${MY_HASH}`]: signedDialogKeyRow(ME, { dialog_hash: DIALOG_HASH, peer_hash: PEER_HASH }),
			}),
			messages: makeCollection(),
			reactions: makeCollection(),
			receipts: makeCollection(),
			versions: makeCollection(),
		},
	};
	networkSend = async () => ({ txids: [] });
});


describe('onOwnSend', () => {
	it('is told of a message once it is stored, with its peer and parts', async () => {
		const store = useDialogsStore();
		const heard: unknown[] = [];
		store.onOwnSend((peerHash: string, parts: unknown[]) => heard.push([peerHash, parts]));
		const captured = await store.captureMessageIntent(PEER_HASH, 'hello');
		expect(heard).toEqual([[PEER_HASH, [{ kind: 'text', text: 'hello' }]]]);
		expect(captured.intentId).toBeTruthy();
	});

	it('is not told of a message that could not be stored', async () => {
		const store = useDialogsStore();
		const heard: unknown[] = [];
		store.onOwnSend((...args: unknown[]) => heard.push(args));
		_setProjectionStorageForTests({
			get: async () => null, set: async () => { throw new Error('disk full'); },
			delete: async () => {}, keys: async () => [], clear: async () => {},
		});
		await expect(store.captureMessageIntent(PEER_HASH, 'hello')).rejects.toThrow();
		expect(heard).toEqual([]);
	});

	it('a listener that throws does not fail the send, and an unsubscribed one hears nothing', async () => {
		const store = useDialogsStore();
		const heard: unknown[] = [];
		store.onOwnSend(() => { throw new Error('listener bug'); });
		const off = store.onOwnSend((...args: unknown[]) => heard.push(args));
		off();
		await expect(store.captureMessageIntent(PEER_HASH, 'hello')).resolves.toBeTruthy();
		expect(heard).toEqual([]);
	});
});

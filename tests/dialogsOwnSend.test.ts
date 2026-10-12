import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { _setStorageForTests, startLeaderElection, stopLeaderElection } from '@/lib/data/outbox';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setOwnObservedTailsStorageForTests } from '@/lib/data/ownObservedTails';
import { _setProjectionStorageForTests } from '@/lib/data/messageProjections';
import { _setIntentStorageForTests } from '@/lib/data/intents';
import { encodeContent } from '@/lib/pq/content';
import type * as Ingest from '@/lib/data/ingest';
import { makeTestIdentity, signedDialogKeyRow } from './helpers/signedFixtures';

// What the avatars store needs of the dialogs store (pq_avatars § Delivery):
// a hook told of every message this account stores for sending, and one read
// of what a dialog says about this account. Harness as in
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
	withDialogCollections: (_dialogHash: string, read: (c: unknown) => unknown) => read(collections.dialog),
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
		// The inverse of encryptContent above; anything else does not decrypt.
		decryptContent: async (_k: unknown, s: string) => {
			if (!s?.startsWith('enc(')) throw new Error('does not decrypt');
			return s.slice(4, -1);
		},
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

	it('is one hook: setting another replaces it, and one that throws does not fail the send', async () => {
		const store = useDialogsStore();
		const heard: unknown[] = [];
		store.onOwnSend((...args: unknown[]) => heard.push(args));
		store.onOwnSend(() => { throw new Error('hook bug'); });
		await expect(store.captureMessageIntent(PEER_HASH, 'hello')).resolves.toBeTruthy();
		expect(heard).toEqual([]);
	});
});

describe('decryptMessageRow: a profile photo is its sender\'s file', () => {
	it('stamps the row\'s sender on an avatar\'s image photo, as on any attachment', async () => {
		const store = useDialogsStore();
		const image = { kind: 'image' as const, widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: 'a.jpg', size: 1, mimeType: 'image/jpeg', createdAt: 0, fileId: 'f_1', encSecretB64: 'k' };
		const content = encodeContent([{ kind: 'avatar', avatarId: 'a'.repeat(32), photo: image }, { ...image, fileId: 'f_2' }]);
		const row = { message_id: 'dmsg_1', dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, sign_hash: 'dms_1', content_b64: `enc(${content})` };
		const { parts } = await store.decryptMessageRow(row);
		expect(parts[0].photo.uploaderHash).toBe(MY_HASH);
		expect(parts[1].uploaderHash).toBe(MY_HASH);
	});
});

describe('ownDialogCarriesAvatar', () => {
	const avatarPart = {
		kind: 'avatar' as const, avatarId: 'a'.repeat(32),
		photo: { kind: 'inline_image' as const, widthAspect: 1, heightAspect: 1, thumbHashB64: '', name: 'a.jpg', size: 1, mimeType: 'image/jpeg', createdAt: 0, dataB64: 'AA' },
	};
	const ownRow = (messageId: string, content: string, over: Record<string, unknown> = {}) => ({
		message_id: messageId, dialog_hash: DIALOG_HASH, sender_hash: MY_HASH, sign_hash: `dms_${messageId}`,
		content_b64: content, deleted_flag: false, ...over,
	});

	it('counts a photo message still waiting in the outbox intents as carrying', async () => {
		const store = useDialogsStore();
		vaultLocked = true; // stored, not sent: it stays an intent
		await store.captureMessageIntent(PEER_HASH, [avatarPart]);
		vaultLocked = false;
		expect(collections.dialog.messages.toArray).toEqual([]);
		expect(await store.ownDialogCarriesAvatar(PEER_HASH)).toMatchObject({ carries: true });
	});

	it('is false for a dialog of text only, a waiting text intent included', async () => {
		const store = useDialogsStore();
		await store.captureMessageIntent(PEER_HASH, 'hello');
		collections.dialog.messages.rows.set('dmsg_1', ownRow('dmsg_1', `enc(${encodeContent([{ kind: 'text', text: 'hi' }])})`));
		expect(await store.ownDialogCarriesAvatar(PEER_HASH)).toMatchObject({ carries: false });
	});

	it('reads own rows under the key it derives itself, stops at a photo, and skips a deleted one', async () => {
		const store = useDialogsStore();
		collections.dialog.messages.rows.set('dmsg_1', ownRow('dmsg_1', `enc(${encodeContent([avatarPart])})`, { deleted_flag: true }));
		expect(await store.ownDialogCarriesAvatar(PEER_HASH)).toMatchObject({ carries: false });
		collections.dialog.messages.rows.set('dmsg_2', ownRow('dmsg_2', `enc(${encodeContent([avatarPart])})`));
		expect(await store.ownDialogCarriesAvatar(PEER_HASH)).toMatchObject({ carries: true });
	});

	it('is null, not false, when one of its messages does not decrypt', async () => {
		const store = useDialogsStore();
		collections.dialog.messages.rows.set('dmsg_1', ownRow('dmsg_1', 'garbage'));
		expect(await store.ownDialogCarriesAvatar(PEER_HASH)).toMatchObject({ carries: null });
	});

	it('with requireOwnKey, a dialog without this account\'s key is not read further', async () => {
		const store = useDialogsStore();
		collections.dialog.keys.rows.clear();
		collections.dialog.messages.rows.set('dmsg_1', ownRow('dmsg_1', `enc(${encodeContent([avatarPart])})`));
		expect(await store.ownDialogCarriesAvatar(PEER_HASH, { requireOwnKey: true })).toEqual({ ownKey: false, carries: null });
		collections.dialog.keys.rows.set(`${DIALOG_HASH}|${MY_HASH}`, signedDialogKeyRow(ME, { dialog_hash: DIALOG_HASH, peer_hash: PEER_HASH }));
		expect(await store.ownDialogCarriesAvatar(PEER_HASH, { requireOwnKey: true })).toEqual({ ownKey: true, carries: true });
	});
});

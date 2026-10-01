import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { fromBase64 } from '@/lib/pq/signature';
import { makeTestIdentity, signedDialogKeyRow } from './helpers/signedFixtures';
import { encodeContent } from '@/lib/pq/content';
import { markTouched, _resetTouchedForTests } from '@/lib/data/readCache';
import { setDialogCacheRow, clearDialogCacheDb } from './helpers/mainDialogCache';

type KeysCollection = {
	preload(): Promise<void>;
	get(k: string): unknown;
	readonly toArray: unknown[];
	subscribeChanges(): { unsubscribe(): void };
};

const me = makeTestIdentity(1, 'me');
const peer = makeTestIdentity(2, 'peer');
const MY_HASH = me.userHash;
const PEER_HASH = peer.userHash;
const DIALOG_HASH = 'di_' + '5'.repeat(128);
const myKemPublicKey = fromBase64(me.card.crypt_pkey as string);
const cardsByHash = new Map([[me.userHash, me.card], [peer.userHash, peer.card]]);

const peerKeyRow = async (msgKey: Uint8Array, ownerTimestamp: number) => {
	const wrapped = await DialogCrypto.wrapSenderMsgKey(msgKey, myKemPublicKey);
	return signedDialogKeyRow(peer, {
		dialog_hash: DIALOG_HASH, peer_hash: MY_HASH,
		peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64,
		peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
		deleted_flag: false, owner_timestamp: ownerTimestamp,
	});
};

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: MY_HASH }),
}));

let collections: { cards: { preload(): Promise<void>; get: (k: string) => unknown }; dialog: { keys: KeysCollection } };
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => me.vault,
		}),
	},
}));

const flakyKeysCollection = () => ({
	async preload() { throw new Error('OPFS/Electric unavailable'); },
	get() { return undefined; },
	get toArray() { return []; },
	subscribeChanges() { return { unsubscribe() {} }; },
});

const succeedingEmptyKeysCollection = () => ({
	async preload() {},
	get() { return undefined; },
	get toArray() { return []; },
	subscribeChanges() { return { unsubscribe() {} }; },
});

const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');

beforeEach(async () => {
	setActivePinia(createPinia());
	await clearDialogCacheDb();
	_resetTouchedForTests();
	collections = { cards: { async preload() {}, get: (k: string) => cardsByHash.get(k) }, dialog: { keys: flakyKeysCollection() } };
});

describe('getSenderMsgKey / decryptMessageRow: dialog_keys disk fallback', () => {
	it('decrypts a message using a peer key row served only from the disk cache when the live collection cannot deliver it', async () => {
		await setDialogCacheRow('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`, await peerKeyRow(new Uint8Array(32).fill(7), 1000));

		const store = useDialogsStore();
		const contentB64 = await DialogCrypto.encryptContent(new Uint8Array(32).fill(7), encodeContent([{ kind: 'text', text: 'hello from cache' }]));
		const row = {
			message_id: 'dmsg_1', dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH,
			content_b64: contentB64, deleted_flag: false, refs_map_b64: null, owner_timestamp: 1000,
		};

		const decrypted = await store.decryptMessageRow(row);

		expect(decrypted.decrypted).toBe(true);
		expect(decrypted.text).toBe('hello from cache');
	});

	it('never resurrects a key row this session already knows is deleted (touched), even though a stale copy is on disk', async () => {
		await setDialogCacheRow('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`, await peerKeyRow(new Uint8Array(32).fill(7), 1000));
		markTouched('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`);

		const store = useDialogsStore();
		const contentB64 = await DialogCrypto.encryptContent(new Uint8Array(32).fill(7), encodeContent([{ kind: 'text', text: 'should stay locked' }]));
		const row = {
			message_id: 'dmsg_2', dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH,
			content_b64: contentB64, deleted_flag: false, refs_map_b64: null, owner_timestamp: 1000,
		};

		const decrypted = await store.decryptMessageRow(row);

		expect(decrypted.decrypted).toBe(false);
		expect(decrypted.text).toBe('Waiting for keys...');
	});

	it('a successful preload with no live key never falls back to a stale cached key — absence is authoritative', async () => {
		collections.dialog.keys = succeedingEmptyKeysCollection();
		await setDialogCacheRow('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`, await peerKeyRow(new Uint8Array(32).fill(7), 1000));

		const store = useDialogsStore();
		const contentB64 = await DialogCrypto.encryptContent(new Uint8Array(32).fill(7), encodeContent([{ kind: 'text', text: 'must not decrypt' }]));
		const row = {
			message_id: 'dmsg_4', dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH,
			content_b64: contentB64, deleted_flag: false, refs_map_b64: null, owner_timestamp: 1000,
		};

		const decrypted = await store.decryptMessageRow(row);

		expect(decrypted.decrypted).toBe(false);
		expect(decrypted.text).toBe('Waiting for keys...');
	});

	it('a preload failure never hides a live key the collection already has from warm persistence', async () => {
		const liveRow = await peerKeyRow(new Uint8Array(32).fill(8), 2000);
		collections.dialog.keys = {
			async preload() { throw new Error('OPFS/Electric unavailable'); },
			get: (k) => (k === `${DIALOG_HASH}|${PEER_HASH}`
				? liveRow
				: undefined),
			get toArray() { return []; },
			subscribeChanges() { return { unsubscribe() {} }; },
		};
		await setDialogCacheRow('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`, await peerKeyRow(new Uint8Array(32).fill(7), 1000));

		const store = useDialogsStore();
		const contentB64 = await DialogCrypto.encryptContent(new Uint8Array(32).fill(8), encodeContent([{ kind: 'text', text: 'from the warm live key' }]));
		const row = {
			message_id: 'dmsg_5', dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH,
			content_b64: contentB64, deleted_flag: false, refs_map_b64: null, owner_timestamp: 1000,
		};

		const decrypted = await store.decryptMessageRow(row);

		expect(decrypted.decrypted).toBe(true);
		expect(decrypted.text).toBe('from the warm live key');
	});

	it('a live key row always wins over a cached one', async () => {
		const liveRow = await peerKeyRow(new Uint8Array(32).fill(8), 2000);
		collections.dialog.keys = {
			async preload() {},
			get: (k) => (k === `${DIALOG_HASH}|${PEER_HASH}`
				? liveRow
				: undefined),
			get toArray() { return []; },
			subscribeChanges() { return { unsubscribe() {} }; },
		};
		await setDialogCacheRow('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`, await peerKeyRow(new Uint8Array(32).fill(7), 1000));

		const store = useDialogsStore();
		const contentB64 = await DialogCrypto.encryptContent(new Uint8Array(32).fill(8), encodeContent([{ kind: 'text', text: 'from the live key' }]));
		const row = {
			message_id: 'dmsg_3', dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH,
			content_b64: contentB64, deleted_flag: false, refs_map_b64: null, owner_timestamp: 1000,
		};

		const decrypted = await store.decryptMessageRow(row);

		expect(decrypted.decrypted).toBe(true);
		expect(decrypted.text).toBe('from the live key');
	});
});

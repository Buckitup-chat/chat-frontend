import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { toBase64 } from '@/lib/pq/signature';
import { encodeContent } from '@/lib/pq/content';
import { markTouched, _setReadCacheStorageForTests, _resetTouchedForTests } from '@/lib/data/readCache';
import { setDialogCacheRow, clearDialogCacheDb } from './helpers/mainDialogCache';

type KeysCollection = {
	preload(): Promise<void>;
	get(k: string): unknown;
	readonly toArray: unknown[];
	subscribeChanges(): { unsubscribe(): void };
};

const MY_HASH = 'u_' + 'a'.repeat(128);
const PEER_HASH = 'u_' + 'b'.repeat(128);
const DIALOG_HASH = 'di_' + '5'.repeat(128);

const myKem = ml_kem1024.keygen(new Uint8Array(64).fill(1));

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: MY_HASH }),
}));

let collections: { cards: { preload(): Promise<void>; get: () => undefined }; dialog: { keys: KeysCollection } };
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			exportVaultKeys: async () => ({
				sign_skey: toBase64(new Uint8Array(32).fill(9)),
				crypt_skey: toBase64(myKem.secretKey),
				evm_skey: 'cc',
			}),
		}),
	},
}));

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

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
	_setReadCacheStorageForTests(makeStorage());
	_resetTouchedForTests();
	collections = { cards: { async preload() {}, get: () => undefined }, dialog: { keys: flakyKeysCollection() } };
});

describe('getSenderMsgKey / decryptMessageRow: dialog_keys disk fallback', () => {
	it('decrypts a message using a peer key row served only from the disk cache when the live collection cannot deliver it', async () => {
		const wrapped = await DialogCrypto.wrapSenderMsgKey(
			new Uint8Array(32).fill(7),
			myKem.publicKey
		);
		await setDialogCacheRow('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH, peer_hash: MY_HASH,
			peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64,
			peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
			deleted_flag: false, owner_timestamp: 1000,
		});

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
		const wrapped = await DialogCrypto.wrapSenderMsgKey(new Uint8Array(32).fill(7), myKem.publicKey);
		await setDialogCacheRow('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH, peer_hash: MY_HASH,
			peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64,
			peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
			deleted_flag: false, owner_timestamp: 1000,
		});
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
		const wrapped = await DialogCrypto.wrapSenderMsgKey(new Uint8Array(32).fill(7), myKem.publicKey);
		await setDialogCacheRow('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH, peer_hash: MY_HASH,
			peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64,
			peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
			deleted_flag: false, owner_timestamp: 1000,
		});

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
		const liveWrapped = await DialogCrypto.wrapSenderMsgKey(new Uint8Array(32).fill(8), myKem.publicKey);
		collections.dialog.keys = {
			async preload() { throw new Error('OPFS/Electric unavailable'); },
			get: (k) => (k === `${DIALOG_HASH}|${PEER_HASH}`
				? {
					dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH, peer_hash: MY_HASH,
					peer_kem_wrap_key_b64: liveWrapped.peerKemWrapKeyB64,
					peer_wrapped_msg_key_b64: liveWrapped.peerWrappedMsgKeyB64,
					deleted_flag: false, owner_timestamp: 2000,
				}
				: undefined),
			get toArray() { return []; },
			subscribeChanges() { return { unsubscribe() {} }; },
		};
		const staleWrapped = await DialogCrypto.wrapSenderMsgKey(new Uint8Array(32).fill(7), myKem.publicKey);
		await setDialogCacheRow('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH, peer_hash: MY_HASH,
			peer_kem_wrap_key_b64: staleWrapped.peerKemWrapKeyB64,
			peer_wrapped_msg_key_b64: staleWrapped.peerWrappedMsgKeyB64,
			deleted_flag: false, owner_timestamp: 1000,
		});

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
		const liveWrapped = await DialogCrypto.wrapSenderMsgKey(new Uint8Array(32).fill(8), myKem.publicKey);
		collections.dialog.keys = {
			async preload() {},
			get: (k) => (k === `${DIALOG_HASH}|${PEER_HASH}`
				? {
					dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH, peer_hash: MY_HASH,
					peer_kem_wrap_key_b64: liveWrapped.peerKemWrapKeyB64,
					peer_wrapped_msg_key_b64: liveWrapped.peerWrappedMsgKeyB64,
					deleted_flag: false, owner_timestamp: 2000,
				}
				: undefined),
			get toArray() { return []; },
			subscribeChanges() { return { unsubscribe() {} }; },
		};
		const staleWrapped = await DialogCrypto.wrapSenderMsgKey(new Uint8Array(32).fill(7), myKem.publicKey);
		await setDialogCacheRow('dialog_keys', `${DIALOG_HASH}|${PEER_HASH}`, {
			dialog_hash: DIALOG_HASH, sender_hash: PEER_HASH, peer_hash: MY_HASH,
			peer_kem_wrap_key_b64: staleWrapped.peerKemWrapKeyB64,
			peer_wrapped_msg_key_b64: staleWrapped.peerWrappedMsgKeyB64,
			deleted_flag: false, owner_timestamp: 1000,
		});

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

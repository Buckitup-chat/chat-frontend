import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { encodeContent } from '@/lib/pq/content';
import { resetCardRegistry } from '@/lib/data/cardRegistry';
import { _setReadCacheStorageForTests, _resetTouchedForTests } from '@/lib/data/readCache';
import { setDialogCacheRow, clearDialogCacheDb } from './helpers/mainDialogCache';
import type { SignableValue } from '@/lib/pq/signature';
import type { UserCardRow } from '@/lib/data/types';

const DIALOG_HASH = 'di_' + '6'.repeat(128);

const makeIdentity = (seed: number) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactSk = new Uint8Array(32).fill(seed);
	const contactPk = secp.getPublicKey(contactSk, true);
	const userHash = 'u_' + bytesToHex(sha3_512(sign.publicKey));
	const card = {
		user_hash: userHash, sign_pkey: toBase64(sign.publicKey), crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk), contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name: `sender-${seed}`, deleted_flag: false, owner_timestamp: 1_700_000_000,
	} as UserCardRow;
	card.sign_b64 = signFields(card as never, sign.secretKey);
	return {
		sign, kem, contactSk, userHash, card,
		vault: { sign_skey: toBase64(sign.secretKey), crypt_skey: toBase64(kem.secretKey), evm_skey: bytesToHex(contactSk) },
	};
};

const me = makeIdentity(40);
const peer = makeIdentity(41);

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: me.userHash }),
}));

let collections: {
	cards: ReturnType<typeof workingCardsCollection>;
	dialog: { keys: unknown; versions: ReturnType<typeof flakyVersionsCollection> | ReturnType<typeof workingEmptyVersionsCollection> | null };
};
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
}));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({ exportVaultKeys: async () => me.vault }),
	},
}));

const makeStorage = () => {
	const map = new Map();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const workingCardsCollection = () => ({
	rows: new Map([[me.userHash, me.card], [peer.userHash, peer.card]]),
	async preload() {},
	get(k: string) { return this.rows.get(k); },
	get toArray() { return [...this.rows.values()]; },
	subscribeChanges() { return { unsubscribe() {} }; },
});

const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');

let senderKey: ReturnType<typeof DialogCrypto.deriveSenderMsgKey>;
let keysRowKey: string;

beforeEach(async () => {
	setActivePinia(createPinia());
	resetCardRegistry();
	await clearDialogCacheDb();
	_setReadCacheStorageForTests(makeStorage());
	_resetTouchedForTests();

	senderKey = DialogCrypto.deriveSenderMsgKey(peer.sign.secretKey, peer.kem.secretKey, bytesToHex(peer.contactSk), me.userHash);
	const wrapped = await DialogCrypto.wrapSenderMsgKey(senderKey, me.kem.publicKey);
	keysRowKey = `${DIALOG_HASH}|${peer.userHash}`;

	collections = {
		cards: workingCardsCollection(),
		dialog: {
			keys: {
				async preload() {},
				get: (k: string) => (k === keysRowKey
					? { dialog_hash: DIALOG_HASH, sender_hash: peer.userHash, peer_hash: me.userHash,
						peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64, peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
						deleted_flag: false, owner_timestamp: 999 }
					: undefined),
				get toArray() { return []; },
				subscribeChanges() { return { unsubscribe() {} }; },
			},
			versions: null,
		},
	};
});

const signedVersion = async (messageId: string, text: string, tweak: Record<string, SignableValue> = {}) => {
	const fields = {
		message_id: messageId, dialog_hash: DIALOG_HASH, sender_hash: peer.userHash,
		content_b64: await DialogCrypto.encryptContent(senderKey, encodeContent([{ kind: 'text', text }])),
		deleted_flag: false, refs_map_b64: null, parent_sign_hash: null, owner_timestamp: 1_700_000_400, ...tweak,
	};
	const sign_b64 = signFields(fields, peer.sign.secretKey);
	return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
};

const flakyVersionsCollection = () => ({
	async preload() { throw new Error('OPFS/Electric unavailable'); },
	get toArray() { return []; },
});

const workingEmptyVersionsCollection = () => ({
	async preload() {},
	get toArray() { return []; },
});

describe('getMessageHistory: dialog_messages_versions disk fallback', () => {
	it('a valid cached version is available in history when preload fails', async () => {
		const messageId = 'dmsg_' + 'a'.repeat(8) + '-0000-7000-8000-000000000000';
		const version = await signedVersion(messageId, 'the old text');
		await setDialogCacheRow('dialog_messages_versions', `${version.message_id}|${version.sign_hash}`, version);
		collections.dialog.versions = flakyVersionsCollection();

		const store = useDialogsStore();
		const history = await store.getMessageHistory(DIALOG_HASH, messageId);

		expect(history).toHaveLength(1);
		expect(history[0].verified).toBe(true);
		expect(history[0].text).toBe('the old text');
	});

	it('a forged cached version never displays as authentic history text', async () => {
		const messageId = 'dmsg_' + 'b'.repeat(8) + '-0000-7000-8000-000000000000';
		const honest = await signedVersion(messageId, 'authentic old text');
		const forged = { ...honest, content_b64: await DialogCrypto.encryptContent(senderKey, encodeContent([{ kind: 'text', text: 'forged old text' }])) };
		await setDialogCacheRow('dialog_messages_versions', `${forged.message_id}|${forged.sign_hash}`, forged);
		collections.dialog.versions = flakyVersionsCollection();

		const store = useDialogsStore();
		const history = await store.getMessageHistory(DIALOG_HASH, messageId);

		expect(history).toHaveLength(1);
		expect(history[0].verified).toBe(false);
		expect(history[0].text).not.toBe('forged old text');
		expect(history[0].text).toBe('Unverifiable revision');
	});

	it('a successful (empty) preload never falls back to stale cached history', async () => {
		const messageId = 'dmsg_' + 'c'.repeat(8) + '-0000-7000-8000-000000000000';
		const staleVersion = await signedVersion(messageId, 'stale text from a previous session');
		await setDialogCacheRow('dialog_messages_versions', `${staleVersion.message_id}|${staleVersion.sign_hash}`, staleVersion);
		collections.dialog.versions = workingEmptyVersionsCollection();

		const store = useDialogsStore();
		const history = await store.getMessageHistory(DIALOG_HASH, messageId);

		expect(history).toEqual([]);
	});

	it('never mixes in a cached version of a different dialog_hash or message_id', async () => {
		const messageId = 'dmsg_' + 'd'.repeat(8) + '-0000-7000-8000-000000000000';
		const version = await signedVersion(messageId, 'mine');
		await setDialogCacheRow('dialog_messages_versions', `${version.message_id}|${version.sign_hash}`, version);

		const otherMessageVersion = await signedVersion('dmsg_' + 'e'.repeat(8) + '-0000-7000-8000-000000000000', 'not mine');
		await setDialogCacheRow('dialog_messages_versions', `${otherMessageVersion.message_id}|${otherMessageVersion.sign_hash}`, otherMessageVersion);

		const foreignDialogHash = 'di_' + '7'.repeat(128);
		const foreignVersion = await signedVersion(messageId, 'foreign dialog', { dialog_hash: foreignDialogHash });
		const foreignSignB64 = signFields({ ...foreignVersion, dialog_hash: foreignDialogHash }, peer.sign.secretKey);
		await setDialogCacheRow('dialog_messages_versions', `${messageId}|${deriveSignHash('dms_', foreignSignB64)}`, {
			...foreignVersion, dialog_hash: foreignDialogHash, sign_b64: foreignSignB64, sign_hash: deriveSignHash('dms_', foreignSignB64),
		});

		collections.dialog.versions = flakyVersionsCollection();

		const store = useDialogsStore();
		const history = await store.getMessageHistory(DIALOG_HASH, messageId);

		expect(history).toHaveLength(1);
		expect(history[0].text).toBe('mine');
	});
});

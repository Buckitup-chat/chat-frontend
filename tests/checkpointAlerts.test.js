// Checkpoint alerts: entering the dialogs list marks the dialogs that moved
// since the state this account confirmed. The scan runs on real ML-DSA rows
// through the store, with the pointer store backed by memory.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { resetCardRegistry } from '@/lib/data/cardRegistry';
import { _setStoreForTests } from '@/lib/data/localStore';

let messagePreloads = 0;
const makeCollection = (rows = {}, counted = false) => ({
	rows: new Map(Object.entries(rows)),
	async preload() { if (counted) messagePreloads++; },
	get(key) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
});

let collections;
let opened;

vi.mock('@/store/userPQ.store', () => ({
	userPQStore: () => ({ currentUserHash: MY_HASH_HOLDER.value }),
}));
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
	withDialogCollections: async (h, read) => { opened.push(h); return read(collections.dialog); },
}));
vi.mock('@/lib/data/ingest', () => ({ sendMutationsAndAwaitShape: async () => ({ ok: true }) }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => ({}) }) },
}));

const MY_HASH_HOLDER = { value: '' };
const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');
const { encodeContent } = await import('@/lib/pq/content');

const makeIdentity = (seed) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactPk = secp.getPublicKey(new Uint8Array(32).fill(seed), true);
	const userHash = 'u_' + bytesToHex(sha3_512(sign.publicKey));
	const card = {
		user_hash: userHash,
		sign_pkey: toBase64(sign.publicKey),
		crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk),
		contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name: `u-${seed}`,
		deleted_flag: false,
		owner_timestamp: 1_700_000_000,
	};
	card.sign_b64 = signFields(card, sign.secretKey);
	return { sign, userHash, card };
};

const M1 = 'dmsg_0192aaaa-0000-7000-8000-000000000001';
const M2 = 'dmsg_0192aabb-0000-7000-8000-000000000002';
const CP = 'dmsg_0192aacc-0000-7000-8000-000000000003';

describe('checkpoint alerts', () => {
	let store, me, peer, dialogHash, key, mem;

	const row = async (messageId, contentParts, tweak = {}) => {
		const fields = {
			message_id: messageId,
			dialog_hash: dialogHash,
			sender_hash: me.userHash,
			content_b64: await DialogCrypto.encryptContent(key, encodeContent(contentParts)),
			deleted_flag: false,
			refs_map_b64: null,
			parent_sign_hash: null,
			owner_timestamp: 1_700_000_500,
			...tweak,
		};
		const sign_b64 = signFields(fields, me.sign.secretKey);
		return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
	};

	const seed = (...rows) => { for (const r of rows) collections.dialog.messages.rows.set(r.message_id, r); };

	beforeEach(async () => {
		setActivePinia(createPinia());
		resetCardRegistry();
		opened = [];
		mem = new Map();
		_setStoreForTests({
			async get(k) { return mem.get(k) ?? null; },
			async set(k, v) { mem.set(k, v); },
			async delete(k) { mem.delete(k); },
			async keys() { return [...mem.keys()]; },
			async clear() { mem.clear(); },
		});
		me = makeIdentity(11);
		MY_HASH_HOLDER.value = me.userHash;
		peer = makeIdentity(12).userHash;
		collections = {
			cards: makeCollection({ [me.userHash]: me.card }),
			dialog: { keys: makeCollection(), messages: makeCollection({}, true), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
		};
		store = useDialogsStore();
		dialogHash = store.getDialogHash(peer);
		key = new Uint8Array(32).fill(9);
	});

	// The store derives sender keys from the vault; in this harness the vault is
	// empty, so a dialog whose content cannot be decrypted must simply produce
	// no alert rather than throwing into the dialogs list.
	it('a dialog whose content will not decrypt raises no alert', async () => {
		seed(await row(M1, [{ kind: 'text', text: 'hi' }]));
		await store.scanCheckpointAlerts([peer]);
		expect(store.alertingPeers.has(peer)).toBe(false);
		expect(store.checkpointAlerts.get(peer)).toBeUndefined();
	});

	// The sweep must not join the warm set: one entry per dialog would evict
	// the dialog the user is in, and the open view would keep a collection
	// that has stopped syncing.
	it('reads dialogs through the non-registering path', async () => {
		seed(await row(M1, [{ kind: 'text', text: 'hi' }]));
		await store.scanCheckpointAlerts([peer]);
		expect(opened).toEqual([dialogHash]);
	});

	it('skips the current user and empty entries', async () => {
		await store.scanCheckpointAlerts([me.userHash, '', null]);
		expect(store.checkpointAlerts.size).toBe(0);
	});

	// One sweep at a time: each dialog's collections open a shape, so a second
	// entry into the list must not put a second scan on the wire.
	it('a scan already in flight is not started twice', async () => {
		seed(await row(M1, [{ kind: 'text', text: 'hi' }]));
		messagePreloads = 0;
		const a = store.scanCheckpointAlerts([peer]);
		const b = store.scanCheckpointAlerts([peer]);
		await Promise.all([a, b]);
		expect(messagePreloads).toBe(1);
	});

});

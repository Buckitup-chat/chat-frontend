// Checkpoint alerts: entering the dialogs list marks the dialogs that moved
// since the state this account confirmed. The scan runs on real ML-DSA rows
// through the store, with real content encryption (the vault keys are the
// author's own) and the pointer store backed by memory.
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
import { savePointer, loadPointer } from '@/lib/data/checkpointAlerts';
import {
	deriveFrontierRoot, buildViewTree,
	CHECKPOINT_VERSION, REDUCER_VERSION, TREE_VERSION,
} from '@/lib/pq/checkpoint';

let messagePreloads = 0;
const makeCollection = (rows = {}, counted = false) => ({
	rows: new Map(Object.entries(rows)),
	async preload() { if (counted) messagePreloads++; },
	get(key) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
});

let collections;
let opened;
let registeredOpens;

const HOLDER = vi.hoisted(() => ({ user: null, vault: {} }));

vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	HOLDER.user = reactive({ currentUserHash: '' });
	return { userPQStore: () => HOLDER.user };
});
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	// The registering path: every call would push the dialog into the LRU on
	// the live stack, so the sweep must never come through here.
	getDialogCollections: () => { registeredOpens++; return collections.dialog; },
	withDialogCollections: async (h, read) => { opened.push(h); return read(collections.dialog); },
}));
vi.mock('@/lib/data/ingest', () => ({ sendMutationsAndAwaitShape: async () => ({ ok: true }) }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => HOLDER.vault }) },
}));

const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');
const { encodeContent } = await import('@/lib/pq/content');

const makeIdentity = (seed) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactSk = new Uint8Array(32).fill(seed);
	const contactPk = secp.getPublicKey(contactSk, true);
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
	return {
		sign, kem, contactSk, userHash, card,
		vault: {
			sign_skey: toBase64(sign.secretKey),
			crypt_skey: toBase64(kem.secretKey),
			evm_skey: bytesToHex(contactSk),
		},
	};
};

const M1 = 'dmsg_0192aaaa-0000-7000-8000-000000000001';
const M2 = 'dmsg_0192aadd-0000-7000-8000-000000000002';
const CP = 'dmsg_0192aacc-0000-7000-8000-000000000003';

describe('checkpoint alerts', () => {
	let store, me, peer, dialogHash, key, mem;

	const row = async (messageId, contentParts, refs = {}, tweak = {}) => {
		const fields = {
			message_id: messageId,
			dialog_hash: dialogHash,
			sender_hash: me.userHash,
			content_b64: await DialogCrypto.encryptContent(key, encodeContent(contentParts)),
			deleted_flag: false,
			refs_map_b64: await DialogCrypto.encryptContent(key, JSON.stringify(refs)),
			parent_sign_hash: null,
			owner_timestamp: 1_700_000_500,
			...tweak,
		};
		const sign_b64 = signFields(fields, me.sign.secretKey);
		return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
	};

	// A real checkpoint part over the given rows, like createDialogCheckpoint
	// would have produced at that moment.
	const checkpointPart = (rows) => {
		const state = Object.fromEntries(rows.map((r) => [r.message_id, { signHash: r.sign_hash, deleted: !!r.deleted_flag }]));
		const frontier = Object.fromEntries(rows.map((r) => [r.message_id, r.sign_hash]));
		return {
			kind: 'checkpoint',
			version: CHECKPOINT_VERSION,
			reducerVersion: REDUCER_VERSION,
			treeVersion: TREE_VERSION,
			frontierRoot: deriveFrontierRoot(frontier),
			viewRoot: buildViewTree(state).root,
			frontier,
			createdAt: 1_700_000_600,
		};
	};

	const seed = (...rows) => { for (const r of rows) collections.dialog.messages.rows.set(r.message_id, r); };

	const keyRowId = () => `${dialogHash}|${me.userHash}`;
	const seedKeyRow = () => collections.dialog.keys.rows.set(keyRowId(), {
		dialog_hash: dialogHash, sender_hash: me.userHash, peer_hash: peer, deleted_flag: false,
	});

	// The sweep only visits dialogs holding a checkpoint pointer — the same
	// registration signing a checkpoint performs.
	const indexDialog = () => savePointer(me.userHash, dialogHash, {
		checkpoint: { messageId: M1, viewRoot: 'dvr_x', frontierRoot: 'dfr_x', createdAt: 1 },
		scannedTo: 0,
	});

	beforeEach(async () => {
		setActivePinia(createPinia());
		resetCardRegistry();
		opened = [];
		registeredOpens = 0;
		mem = new Map();
		_setStoreForTests({
			async get(k) { return mem.get(k) ?? null; },
			async set(k, v) { mem.set(k, v); },
			async delete(k) { mem.delete(k); },
			async keys() { return [...mem.keys()]; },
			async clear() { mem.clear(); },
		});
		me = makeIdentity(11);
		HOLDER.user.currentUserHash = me.userHash;
		HOLDER.vault = me.vault;
		peer = makeIdentity(12).userHash;
		collections = {
			cards: makeCollection({ [me.userHash]: me.card }),
			dialog: { keys: makeCollection(), messages: makeCollection({}, true), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
		};
		store = useDialogsStore();
		dialogHash = store.getDialogHash(peer);
		seedKeyRow();
		key = DialogCrypto.deriveSenderMsgKey(me.sign.secretKey, me.kem.secretKey, bytesToHex(me.contactSk), peer);
	});

	// The full pipeline on real rows: a signed checkpoint in the feed, the
	// pointer picked up by the scan, and the dot following the view root.
	it('an unmoved dialog stays silent; a new message raises the alert', async () => {
		const r1 = await row(M1, [{ kind: 'text', text: 'hi' }]);
		const cp = await row(CP, [checkpointPart([r1])], { [M1]: r1.sign_hash });
		seed(r1, cp);

		const first = await store.refreshCheckpointAlert(peer);
		expect(first).toMatchObject({ changed: false, messageId: CP });
		expect(store.alertingPeers.has(peer)).toBe(false);

		seed(await row(M2, [{ kind: 'text', text: 'later' }], { [CP]: cp.sign_hash }));
		const second = await store.refreshCheckpointAlert(peer);
		expect(second).toMatchObject({ changed: true, messageId: CP });
		expect(store.alertingPeers.has(peer)).toBe(true);
	});

	// The watermark must not outrun decryption: a dialog key that has not
	// replicated yet makes rows temporarily unreadable, and a scan that
	// advanced past them would never look again — the alert dot for this
	// dialog would be dead for good after one cold start.
	it('rows that failed to decrypt are rescanned once their key arrives', async () => {
		const r1 = await row(M1, [{ kind: 'text', text: 'hi' }]);
		const cp = await row(CP, [checkpointPart([r1])], { [M1]: r1.sign_hash });
		seed(r1, cp);
		collections.dialog.keys.rows.delete(keyRowId()); // key not here yet

		expect(await store.refreshCheckpointAlert(peer)).toBe(null);
		const blind = await loadPointer(me.userHash, dialogHash);
		expect(blind.checkpoint).toBe(null);

		seedKeyRow(); // the key row replicates
		const found = await store.refreshCheckpointAlert(peer);
		expect(found).toMatchObject({ changed: false, messageId: CP });
	});

	// Roots from other checkpoint semantics are incomparable with locally
	// derived ones — adopting a v1 carrier as the pointer would light a
	// "changed" dot that no state can ever put out.
	it('a checkpoint from other semantics never becomes the pointer', async () => {
		const r1 = await row(M1, [{ kind: 'text', text: 'hi' }]);
		const stale = { ...checkpointPart([r1]), version: 1, treeVersion: 'dialog-view-tree-v1' };
		seed(r1, await row(CP, [stale], { [M1]: r1.sign_hash }));

		expect(await store.refreshCheckpointAlert(peer)).toBe(null);
		expect(store.alertingPeers.has(peer)).toBe(false);
		const pointer = await loadPointer(me.userHash, dialogHash);
		expect(pointer.checkpoint).toBe(null);
	});

	// The gated sweep can only see indexed dialogs, and the index used to be
	// written only by the sweep itself — a closed loop. Opening the dialog
	// (Page_Chat calls refreshCheckpointAlert) is the bootstrap: a checkpoint
	// signed by this account on ANOTHER device is discovered and registered
	// here, and the sweep sees the dialog from then on.
	it('a dialog visit bootstraps the index for the sweep', async () => {
		const r1 = await row(M1, [{ kind: 'text', text: 'hi' }]);
		seed(r1, await row(CP, [checkpointPart([r1])], { [M1]: r1.sign_hash }));

		await store.scanCheckpointAlerts([peer]);
		expect(opened).toEqual([]); // not indexed: the sweep must not open it

		await store.refreshCheckpointAlert(peer); // = opening the dialog
		opened = []; // count only what the SWEEP opens from here
		await store.scanCheckpointAlerts([peer]);
		expect(opened).toEqual([dialogHash]); // now indexed and swept
	});

	// The index entry can be lost independently of the pointer (a clobbered
	// write); revisiting the dialog must restore it even though the pointer
	// itself did not change.
	it('a revisit restores a lost index entry', async () => {
		const r1 = await row(M1, [{ kind: 'text', text: 'hi' }]);
		seed(r1, await row(CP, [checkpointPart([r1])], { [M1]: r1.sign_hash }));

		await store.refreshCheckpointAlert(peer); // indexes the dialog
		mem.delete(`cpptr-index|${me.userHash}`); // the entry is lost

		await store.refreshCheckpointAlert(peer); // pointer unchanged — but
		opened = [];
		await store.scanCheckpointAlerts([peer]);
		expect(opened).toEqual([dialogHash]); // the index came back
	});

	it('a dialog whose content will not decrypt raises no alert', async () => {
		// direct refresh (the probe/manual path): rows exist but their key is
		// absent, so no checkpoint can be found — and that must mean silence,
		// not an error thrown into the dialogs list
		seed(await row(M1, [{ kind: 'text', text: 'hi' }]));
		collections.dialog.keys.rows.delete(keyRowId());
		expect(await store.refreshCheckpointAlert(peer)).toBe(null);
		expect(store.alertingPeers.has(peer)).toBe(false);
		expect(store.checkpointAlerts.get(peer)).toBeUndefined();
	});

	// The sweep must not join the warm set: one entry per dialog would evict
	// the dialog the user is in, and the open view would keep a collection
	// that has stopped syncing. That includes the decryption inside the scan —
	// a key lookup through the registering path is the same eviction with
	// extra steps.
	it('reads and decrypts dialogs through the non-registering path only', async () => {
		await indexDialog();
		const r1 = await row(M1, [{ kind: 'text', text: 'hi' }]);
		seed(r1, await row(CP, [checkpointPart([r1])], { [M1]: r1.sign_hash }));
		await store.scanCheckpointAlerts([peer]);
		expect(opened).toEqual([dialogHash]);
		expect(registeredOpens).toBe(0);
	});

	// A shared backend replicates hundreds of stranger cards; a dialog where
	// this account never signed a checkpoint cannot alert, so the sweep must
	// not open its shape at all.
	it('skips dialogs without a pointer without opening their collections', async () => {
		seed(await row(M1, [{ kind: 'text', text: 'hi' }]));
		await store.scanCheckpointAlerts([peer]);
		expect(opened).toEqual([]);
		expect(store.checkpointAlerts.size).toBe(0);
	});

	it('skips the current user and empty entries', async () => {
		await store.scanCheckpointAlerts([me.userHash, '', null]);
		expect(store.checkpointAlerts.size).toBe(0);
	});

	// One sweep at a time: each dialog's collections open a shape, so a second
	// entry into the list must not put a second scan on the wire.
	it('a scan already in flight is not started twice', async () => {
		await indexDialog();
		seed(await row(M1, [{ kind: 'text', text: 'hi' }]));
		messagePreloads = 0;
		const a = store.scanCheckpointAlerts([peer]);
		const b = store.scanCheckpointAlerts([peer]);
		await Promise.all([a, b]);
		expect(messagePreloads).toBe(1);
	});

});

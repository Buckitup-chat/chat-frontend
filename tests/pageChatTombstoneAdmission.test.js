// @vitest-environment jsdom
//
// The feed's admission pipeline through the real component: a tombstone is a
// signed tip revision that outgoing refs_map entries point at (pq_dialogs.md
// §Tail calculation), so Page_Chat must feed it to the gate even though it is
// never decrypted or rendered as content. With the tombstone skipped before
// admission, every message sent after a deletion pins an unadmitted revision
// and parks as "waiting" forever — on both sides of the dialog.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { resetCardRegistry } from '@/lib/data/cardRegistry';
import { _setStoreForTests } from '@/lib/data/localStore';

const makeCollection = (rows = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
	subscribeChanges() { return { unsubscribe() {} }; },
});

let collections;
const HOLDER = vi.hoisted(() => ({ user: null, vault: {}, peer: '' }));

vi.mock('vue-router', () => ({
	useRoute: () => ({ params: { get address() { return HOLDER.peer; } }, query: {} }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	HOLDER.user = reactive({
		currentUserHash: '', contacts: [], getUserByHash: () => null,
	});
	return { userPQStore: () => HOLDER.user };
});
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
	withDialogCollections: async (h, read) => read(collections.dialog),
}));
vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async () => ({ txids: [] }),
}));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => HOLDER.vault }) },
}));

const PageChat = (await import('@/views/chats/Page_Chat.vue')).default;
const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');

const makeIdentity = (seed) => {
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
	};
	card.sign_b64 = signFields(card, sign.secretKey);
	return { sign, kem, contactSk, userHash, card,
		vault: { sign_skey: toBase64(sign.secretKey), crypt_skey: toBase64(kem.secretKey), evm_skey: bytesToHex(contactSk) } };
};

const M1 = 'dmsg_0192aaaa-0000-7000-8000-000000000001';
const M2 = 'dmsg_0192aaaa-0000-7000-8000-000000000002';

describe('tombstone admission through the feed', () => {
	let store, author, peerId, dialogHash, senderKey;

	const makeRow = async (mid, refs, tweak = {}) => {
		const fields = {
			message_id: mid, dialog_hash: dialogHash, sender_hash: author.userHash,
			content_b64: toBase64(new Uint8Array([5, 6, 7])), deleted_flag: false,
			refs_map_b64: await DialogCrypto.encryptContent(senderKey, JSON.stringify(refs)),
			parent_sign_hash: null, owner_timestamp: 1_700_000_500, ...tweak,
		};
		const sign_b64 = signFields(fields, author.sign.secretKey);
		return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
	};

	beforeEach(async () => {
		setActivePinia(createPinia());
		resetCardRegistry();
		const mem = new Map();
		_setStoreForTests({
			async get(k) { return mem.get(k) ?? null; }, async set(k, v) { mem.set(k, v); },
			async delete(k) { mem.delete(k); }, async keys() { return [...mem.keys()]; }, async clear() { mem.clear(); },
		});
		author = makeIdentity(7);
		peerId = makeIdentity(3);
		HOLDER.peer = peerId.userHash;
		HOLDER.user.currentUserHash = author.userHash;
		HOLDER.vault = author.vault;
		collections = {
			cards: makeCollection({ [author.userHash]: author.card, [peerId.userHash]: peerId.card }),
			dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
		};
		store = useDialogsStore();
		dialogHash = store.getDialogHash(peerId.userHash);
		collections.dialog.keys.rows.set(`${dialogHash}|${author.userHash}`, {
			dialog_hash: dialogHash, sender_hash: author.userHash, peer_hash: peerId.userHash, deleted_flag: false });
		senderKey = DialogCrypto.deriveSenderMsgKey(author.sign.secretKey, author.kem.secretKey, bytesToHex(author.contactSk), peerId.userHash);
	});

	it('a message whose refs pin a tombstone revision verifies once the feed runs', async () => {
		// Server state after "send M1, delete M1, send M2": the tip of M1 is
		// the tombstone, the pre-delete revision is archived, and M2's refs
		// pin the tombstone's sign_hash — exactly what computeObservedTails
		// produces under §Tail calculation.
		const r1 = await makeRow(M1, {});
		const tomb = await makeRow(M1, { [M1]: r1.sign_hash }, {
			content_b64: null, deleted_flag: true,
			parent_sign_hash: r1.sign_hash, owner_timestamp: 1_700_000_600,
		});
		const m2 = await makeRow(M2, { [M1]: tomb.sign_hash }, { owner_timestamp: 1_700_000_700 });
		collections.dialog.messages.rows.set(M1, tomb);
		collections.dialog.messages.rows.set(M2, m2);
		collections.dialog.versions.rows.set(`${M1}|${r1.sign_hash}`, r1);

		const wrapper = mount(PageChat, {
			global: {
				provide: { $swal: { fire: async () => ({}) } },
				stubs: {
					ChatWindow: true, TransferPanel: true, FileStateModal: true,
					EditHistoryModal: true, CheckpointDiffModal: true,
				},
			},
		});
		try {
			// scheduleDecrypt debounces 200ms and the versions watcher re-runs
			// it; poll the gate instead of racing a fixed sleep.
			const deadline = Date.now() + 4000;
			while (!store.isMessageAdmitted(dialogHash, M2, m2.sign_hash) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 100));
			}
			// The tombstone was admitted (it is a refs target), so M2 drains
			// to verified instead of parking behind an unadmitted revision.
			expect(store.isMessageAdmitted(dialogHash, M1, tomb.sign_hash)).toBe(true);
			expect(store.isMessageAdmitted(dialogHash, M2, m2.sign_hash)).toBe(true);
		} finally {
			wrapper.unmount();
		}
	});
});

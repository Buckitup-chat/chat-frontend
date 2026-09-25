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
import { _setStorageForTests as _setOutboxStorageForTests, _setActiveSessionForTests } from '@/lib/data/outbox';
import { _setIntentStorageForTests } from '@/lib/data/intents';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';

const makeCollection = (rows = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
	subscribeChanges() { return { unsubscribe() {} }; },
});

let collections;
const HOLDER = vi.hoisted(() => ({ user: null, vault: {}, peer: '', mutations: [] }));

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
// Only the transport is faked; the durable intent → outbox path above it is
// real, so the fake answers the way a delivery handle does.
vi.mock('@/lib/data/ingest', async (importOriginal) => ({
	...(await importOriginal()),
	sendMutationsAndAwaitShape: async (mutations) => {
		HOLDER.mutations.push(...mutations);
		return { txids: [], phase: 'accepted', acceptance: Promise.resolve({ kind: 'accepted' }) };
	},
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
	let store, author, peerId, dialogHash, senderKey, peerSenderKey;

	const makeRow = async (mid, refs, tweak = {}, who = null, key = null) => {
		const signer = who ?? author;
		const fields = {
			message_id: mid, dialog_hash: dialogHash, sender_hash: signer.userHash,
			content_b64: toBase64(new Uint8Array([5, 6, 7])), deleted_flag: false,
			refs_map_b64: await DialogCrypto.encryptContent(key ?? senderKey, JSON.stringify(refs)),
			parent_sign_hash: null, owner_timestamp: 1_700_000_500, ...tweak,
		};
		const sign_b64 = signFields(fields, signer.sign.secretKey);
		return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
	};

	const makePeerRow = (mid, refs, tweak = {}) => makeRow(mid, refs, tweak, peerId, peerSenderKey);

	const mountPage = () => mount(PageChat, {
		global: {
			provide: { $swal: { fire: async () => ({}) } },
			stubs: {
				ChatWindow: true, TransferPanel: true, FileStateModal: true,
				EditHistoryModal: true, CheckpointDiffModal: true,
			},
		},
	});

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
		// Writes are fenced to the signed-in account and go through durable
		// intents and the outbox, so both need a session and a store here.
		const memoryStore = () => {
			const m = new Map();
			return {
				async get(k) { return m.get(k) ?? null; }, async set(k, v) { m.set(k, v); },
				async delete(k) { m.delete(k); }, async keys() { return [...m.keys()]; }, async clear() { m.clear(); },
			};
		};
		_setIntentStorageForTests(memoryStore());
		_setOutboxStorageForTests(memoryStore());
		_setAcceptedSnapshotStorageForTests(memoryStore());
		_setActiveSessionForTests(author.userHash);
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

		// The peer's own sending key, published to us the way the protocol
		// does it: wrapped to our ML-KEM public key in the peer's dialog_keys
		// row. Without it the gate parks the peer's rows on "no key" and
		// nothing downstream — including receipts — ever happens.
		peerSenderKey = DialogCrypto.deriveSenderMsgKey(peerId.sign.secretKey, peerId.kem.secretKey, bytesToHex(peerId.contactSk), author.userHash);
		const wrapped = await DialogCrypto.wrapSenderMsgKey(peerSenderKey, author.kem.publicKey);
		collections.dialog.keys.rows.set(`${dialogHash}|${peerId.userHash}`, {
			dialog_hash: dialogHash, sender_hash: peerId.userHash, peer_hash: author.userHash,
			peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64,
			peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
			deleted_flag: false,
		});
		HOLDER.mutations.length = 0;
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

		const wrapper = mountPage();
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

	it("a peer's tombstone is acknowledged like any other arrival", async () => {
		// §4.3: a delivered receipt binds to a revision, and a deletion is a
		// revision. Acknowledging it tells the sender the retraction reached
		// the peer's device and not merely the server — the one fact the
		// sender of a deletion actually wants.
		const tomb = await makePeerRow(M1, {}, { content_b64: null, deleted_flag: true });
		collections.dialog.messages.rows.set(M1, tomb);

		const wrapper = mountPage();
		try {
			const receipt = await vi.waitFor(() => {
				const r = HOLDER.mutations.find((m) => (
					m.syncMetadata?.relation === 'dialog_message_receipts'
					&& m.modified?.message_id === M1
				))?.modified;
				expect(r).toBeTruthy();
				return r;
			}, { timeout: 5000, interval: 100 });
			expect(receipt.type).toBe('delivered');
			// bound to the tombstone, not to the revision it retracted
			expect(receipt.message_sign_hash).toBe(tomb.sign_hash);
		} finally {
			wrapper.unmount();
		}
	});

	it('a row that drains inside the gate is still acknowledged', async () => {
		// The batch is admitted oldest-first, so a child whose owner_timestamp
		// undercuts its parent's is admitted while the parent is still absent:
		// it parks, the parent's arrival drains it inside the gate, and its
		// UI entry is reconciled rather than re-admitted. The receipt has to
		// come from that reconcile or it is never sent at all.
		const tomb = await makePeerRow(M1, {}, {
			content_b64: null, deleted_flag: true, owner_timestamp: 1_700_000_900,
		});
		const child = await makePeerRow(M2, { [M1]: tomb.sign_hash }, { owner_timestamp: 1_700_000_800 });
		collections.dialog.messages.rows.set(M1, tomb);
		collections.dialog.messages.rows.set(M2, child);

		const wrapper = mountPage();
		try {
			const acknowledged = await vi.waitFor(() => {
				const ids = HOLDER.mutations
					.filter((m) => m.syncMetadata?.relation === 'dialog_message_receipts')
					.map((m) => m.modified?.message_id);
				expect(ids).toContain(M2);
				return ids;
			}, { timeout: 5000, interval: 100 });
			expect(acknowledged).toContain(M1);
		} finally {
			wrapper.unmount();
		}
	});

	it('a tombstone the gate rejects keeps the warning instead of reading as a deletion', async () => {
		// Otherwise a forged revision under the peer's name erases their text
		// from the feed — precisely what the gate exists to prevent.
		const tomb = await makePeerRow(M1, {}, { content_b64: null, deleted_flag: true });
		collections.dialog.messages.rows.set(M1, { ...tomb, owner_timestamp: tomb.owner_timestamp + 1 });

		const wrapper = mountPage();
		try {
			const shown = await vi.waitFor(() => {
				const msgs = wrapper.findComponent({ name: 'ChatWindow' }).props('messages');
				const entry = msgs.find((m) => m.id === M1);
				expect(entry?._verify).toBeDefined();
				return entry;
			}, { timeout: 5000, interval: 100 });
			expect(shown._verify).toBe('invalid');
			expect(shown._deleted).toBeFalsy();
		} finally {
			wrapper.unmount();
		}
	});
});

// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { encodeContent } from '@/lib/pq/content';
import { resetCardRegistry } from '@/lib/data/cardRegistry';
import { _setStoreForTests } from '@/lib/data/localStore';
import { startLeaderElection, stopLeaderElection } from '@/lib/data/outbox';
import { _setIntentStorageForTests } from '@/lib/data/intents';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setOwnObservedTailsStorageForTests } from '@/lib/data/ownObservedTails';
import { _setReadCacheStorageForTests, _resetTouchedForTests } from '@/lib/data/readCache';
import { setDialogCacheRow, clearDialogCacheDb } from './helpers/mainDialogCache';
import type { SignableValue } from '@/lib/pq/signature';
import type { UserCardRow } from '@/lib/data/types';

const makeMemStringStore = () => {
	const map = new Map();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const unreachableCollection = () => ({
	async preload() { throw new Error('OPFS/Electric unavailable'); },
	get() { return undefined; },
	get toArray() { return []; },
	subscribeChanges() { return { unsubscribe() {} }; },
});

let collections: { cards: ReturnType<typeof makeCollection>; dialog: Record<string, ReturnType<typeof unreachableCollection>> };
const HOLDER = vi.hoisted(() => ({ user: null as { currentUserHash: string; contacts: unknown[]; getUserByHash: () => null } | null, vault: {}, peer: '' }));

vi.mock('vue-router', () => ({
	useRoute: () => ({ params: { get address() { return HOLDER.peer; } }, query: {} }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	HOLDER.user = reactive({ currentUserHash: '', contacts: [], getUserByHash: () => null });
	return { userPQStore: () => HOLDER.user };
});
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
	withDialogCollections: async (h: string, read: (dialog: typeof collections.dialog) => unknown) => read(collections.dialog),
}));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => HOLDER.vault }) },
}));

const PageChat = (await import('@/views/chats/Page_Chat.vue')).default;
const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');

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

const waitUntil = async (predicate: () => boolean, timeoutMs = 4000) => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('waitUntil: condition never became true');
		await new Promise((r) => setTimeout(r, 50));
	}
};

const makeCollection = (rows: Record<string, unknown> = {}) => ({
	rows: new Map(Object.entries(rows)),
	async preload() {},
	get(key: string) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
	subscribeChanges() { return { unsubscribe() {} }; },
});

describe('IndexedDB read-cache fallback: real dialog gate through Page_Chat.vue when every dialog collection is unreachable', () => {
	let me: ReturnType<typeof makeIdentity>, peer: ReturnType<typeof makeIdentity>, dialogHash: string, senderKey: ReturnType<typeof DialogCrypto.deriveSenderMsgKey>;

	beforeEach(async () => {
		setActivePinia(createPinia());
		resetCardRegistry();
		_setStoreForTests(makeMemStringStore());
		_setIntentStorageForTests(makeMemStringStore());
		_setAcceptedSnapshotStorageForTests(makeMemStringStore());
		_setOwnObservedTailsStorageForTests(makeMemStringStore());
		await clearDialogCacheDb();
	_setReadCacheStorageForTests(makeMemStringStore());
		_resetTouchedForTests();

		me = makeIdentity(30);
		peer = makeIdentity(31);
		HOLDER.peer = peer.userHash;
		HOLDER.user!.currentUserHash = me.userHash;
		HOLDER.vault = me.vault;
		collections = {
			cards: makeCollection({ [me.userHash]: me.card, [peer.userHash]: peer.card }),
			dialog: {
				keys: unreachableCollection(), messages: unreachableCollection(), versions: unreachableCollection(),
				reactions: unreachableCollection(), receipts: unreachableCollection(),
			},
		};
		stopLeaderElection();
		startLeaderElection(me.userHash, () => {});

		const store = useDialogsStore();
		dialogHash = store.getDialogHash(peer.userHash)!;
		senderKey = DialogCrypto.deriveSenderMsgKey(peer.sign.secretKey, peer.kem.secretKey, bytesToHex(peer.contactSk), me.userHash);

		const wrapped = await DialogCrypto.wrapSenderMsgKey(senderKey, me.kem.publicKey);
		await setDialogCacheRow('dialog_keys', `${dialogHash}|${peer.userHash}`, {
			dialog_hash: dialogHash, sender_hash: peer.userHash, peer_hash: me.userHash,
			peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64, peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
			deleted_flag: false, owner_timestamp: 999,
		});
	});

	afterEach(() => {
		stopLeaderElection();
	});

	const mountChat = () => mount(PageChat, {
		global: {
			provide: { $swal: { fire: async () => ({}) } },
			stubs: { Avatar: true, TransferPanel: true, FileStateModal: true, EditHistoryModal: true, CheckpointDiffModal: true },
		},
	});

	const signedMessage = async (messageId: string, text: string, tweak: Record<string, SignableValue> = {}) => {
		const fields = {
			message_id: messageId, dialog_hash: dialogHash, sender_hash: peer.userHash,
			content_b64: await DialogCrypto.encryptContent(senderKey, encodeContent([{ kind: 'text', text }])),
			deleted_flag: false, refs_map_b64: await DialogCrypto.encryptContent(senderKey, JSON.stringify({})),
			parent_sign_hash: null, owner_timestamp: 1_700_000_500, ...tweak,
		};
		const sign_b64 = signFields(fields, peer.sign.secretKey);
		return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
	};

	it('restores a previously mirrored, verified message of THIS dialog — decrypted through the cached key too — while a different dialog\'s cached row never leaks in', async () => {
		const valid = await signedMessage('dmsg_' + 'a'.repeat(8) + '-0000-7000-8000-000000000000', 'restored from disk');
		await setDialogCacheRow('dialog_messages', valid.message_id, valid);

		const foreignDialogHash = 'di_' + '9'.repeat(128);
		const foreign = await signedMessage('dmsg_' + 'b'.repeat(8) + '-0000-7000-8000-000000000000', 'must not leak', { dialog_hash: foreignDialogHash });
		const foreignSignB64 = signFields({ ...foreign, dialog_hash: foreignDialogHash }, peer.sign.secretKey);
		await setDialogCacheRow('dialog_messages', foreign.message_id, {
			...foreign, dialog_hash: foreignDialogHash, sign_b64: foreignSignB64, sign_hash: deriveSignHash('dms_', foreignSignB64),
		});

		const wrapper = mountChat();
		try {
			await waitUntil(() => wrapper.text().includes('restored from disk'));
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);
			expect(wrapper.text()).not.toContain('must not leak');

			const store = useDialogsStore();
			await waitUntil(() => store.isMessageAdmitted(dialogHash, valid.message_id, valid.sign_hash));
		} finally {
			wrapper.unmount();
		}
	});

	it('an invalid-signature cached message never renders as its (attacker-supplied) content — including a forged tombstone', async () => {
		const forged0 = await signedMessage('dmsg_' + 'c'.repeat(8) + '-0000-7000-8000-000000000000', 'authentic');
		const forged = { ...forged0, content_b64: await DialogCrypto.encryptContent(senderKey, encodeContent([{ kind: 'text', text: 'forged content' }])) };
		await setDialogCacheRow('dialog_messages', forged.message_id, forged);

		const genuineTombstone = await signedMessage('dmsg_' + 'd'.repeat(8) + '-0000-7000-8000-000000000000', 'irrelevant');
		const forgedTombstone = { ...genuineTombstone, deleted_flag: true };
		await setDialogCacheRow('dialog_messages', forgedTombstone.message_id, forgedTombstone);

		const anchor = await signedMessage(
			'dmsg_' + '9'.repeat(8) + '-0000-7000-8000-000000000000', 'anchor', { owner_timestamp: 1_700_000_900 }
		);
		await setDialogCacheRow('dialog_messages', anchor.message_id, anchor);

		const wrapper = mountChat();
		try {
			const store = useDialogsStore();
			await waitUntil(() => store.isMessageAdmitted(dialogHash, anchor.message_id, anchor.sign_hash));

			expect(store.isMessageAdmitted(dialogHash, forged.message_id, forged.sign_hash)).toBe(false);
			expect(wrapper.text()).not.toContain('forged content');

			const forgedBubble = wrapper.find(`[data-msg-id="${forged.message_id}"]`);
			expect(forgedBubble.exists()).toBe(true);
			expect(forgedBubble.find('.message-text').text()).toBe('Message failed verification');

			expect(store.isMessageAdmitted(dialogHash, forgedTombstone.message_id, forgedTombstone.sign_hash)).toBe(false);
			const forgedTombstoneBubble = wrapper.find(`[data-msg-id="${forgedTombstone.message_id}"]`);
			expect(forgedTombstoneBubble.exists()).toBe(true);
			expect(forgedTombstoneBubble.find('.message-text').text()).toBe('Message failed verification');
			expect(forgedTombstoneBubble.find('.message-text').text()).not.toContain('Message deleted');
		} finally {
			wrapper.unmount();
		}
	});

	it('a validly signed tombstone served only from the cache is admitted and rendered as deleted, not skipped', async () => {
		const tombstone = await signedMessage('dmsg_' + 'e'.repeat(8) + '-0000-7000-8000-000000000000', '', { deleted_flag: true, content_b64: '', refs_map_b64: null });
		await setDialogCacheRow('dialog_messages', tombstone.message_id, tombstone);

		const wrapper = mountChat();
		try {
			const store = useDialogsStore();
			await waitUntil(() => store.isMessageAdmitted(dialogHash, tombstone.message_id, tombstone.sign_hash));
			await waitUntil(() => wrapper.findAll('.message-bubble').length > 0);

			expect(wrapper.find('.message-bubble .message-text').text()).toContain('Message deleted');
		} finally {
			wrapper.unmount();
		}
	});

	it('a cached dialog_messages_versions row only counts toward the edit badge once it is actually admitted — a forged one never does', async () => {
		const validVersion = await signedMessage(
			'dmsg_' + 'f'.repeat(8) + '-0000-7000-8000-000000000000', 'old text', { owner_timestamp: 1_700_000_400 }
		);
		await setDialogCacheRow('dialog_messages_versions', `${validVersion.message_id}|${validVersion.sign_hash}`, validVersion);

		const current = await signedMessage(
			validVersion.message_id, 'current text',
			{ refs_map_b64: await DialogCrypto.encryptContent(senderKey, JSON.stringify({ [validVersion.message_id]: validVersion.sign_hash })),
				parent_sign_hash: validVersion.sign_hash, owner_timestamp: 1_700_000_950 }
		);
		await setDialogCacheRow('dialog_messages', current.message_id, current);

		const forgedVersion0 = await signedMessage(
			validVersion.message_id, 'irrelevant',
			{ refs_map_b64: await DialogCrypto.encryptContent(senderKey, JSON.stringify({ [validVersion.message_id]: validVersion.sign_hash })),
				owner_timestamp: 1_700_000_300 }
		);
		const forgedVersion = { ...forgedVersion0, content_b64: await DialogCrypto.encryptContent(senderKey, encodeContent([{ kind: 'text', text: 'tampered' }])) };
		await setDialogCacheRow('dialog_messages_versions', `${forgedVersion.message_id}|${forgedVersion.sign_hash}`, forgedVersion);

		const wrapper = mountChat();
		try {
			const store = useDialogsStore();
			await waitUntil(() => store.isMessageAdmitted(dialogHash, current.message_id, current.sign_hash));
			await waitUntil(() => wrapper.find('.msg-edited').exists());
			await waitUntil(() => wrapper.find('.msg-edited').text().includes('· 1'));

			expect(wrapper.find('.msg-edited').text()).not.toContain('· 2');
		} finally {
			wrapper.unmount();
		}
	});
});

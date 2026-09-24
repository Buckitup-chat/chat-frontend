// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
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
import { _setProjectionStorageForTests } from '@/lib/data/messageProjections';
import type { MockInstance } from 'vitest';
import type { SignableValue } from '@/lib/pq/signature';
import type { UserCardRow } from '@/lib/data/types';

type ShapeRow = Record<string, SignableValue> & { message_id: string; sign_hash: string };
type CapturedMutation = { modified: ShapeRow };

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

const makeCollection = (rows: Record<string, unknown> = {}) => {
	const subs = new Set<() => void>();
	return {
		rows: new Map(Object.entries(rows)),
		async preload() {},
		get(key: string) { return this.rows.get(key); },
		get toArray() { return [...this.rows.values()]; },
		subscribeChanges(cb: () => void) { subs.add(cb); return { unsubscribe: () => subs.delete(cb) }; },
		notify() { for (const cb of subs) cb(); },
	};
};

type Collection = ReturnType<typeof makeCollection>;
let collections: {
	cards: Collection;
	dialog: { keys: Collection; messages: Collection; versions: Collection; reactions: Collection; receipts: Collection };
};
const HOLDER = vi.hoisted(() => ({ user: null as { currentUserHash: string; contacts: unknown[]; getUserByHash: () => null } | null, vault: {}, peer: '' }));
const CAPTURE = vi.hoisted(() => ({ mutations: [] as CapturedMutation[], gate: null as Promise<unknown> | null }));

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
	withDialogCollections: async (h: string, read: (dialog: typeof collections.dialog) => unknown) => read(collections.dialog),
}));
vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async (mutations: CapturedMutation[]) => {
		CAPTURE.mutations.push(mutations[0]);
		if (CAPTURE.gate) await CAPTURE.gate;
		return {
			outboxId: `ob_${CAPTURE.mutations.length}`,
			phase: 'accepted',
			acceptance: Promise.resolve({ kind: 'accepted' }),
		};
	},
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
	return { sign, kem, contactSk, userHash, card,
		vault: { sign_skey: toBase64(sign.secretKey), crypt_skey: toBase64(kem.secretKey), evm_skey: bytesToHex(contactSk) } };
};

const waitUntil = async (predicate: () => boolean, timeoutMs = 4000) => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('waitUntil: condition never became true');
		await new Promise((r) => setTimeout(r, 50));
	}
};

let seq = 0;
const nextMessageId = () => `dmsg_0199proj${(seq++).toString().padStart(4, '0')}`;

describe('message projection lifecycle: local → SERVER_ACCEPTED → verified canonical (main-tanstack-proposal-v3.md §445-463, §657-711)', () => {
	let store: ReturnType<typeof useDialogsStore>, me: ReturnType<typeof makeIdentity>, peer: ReturnType<typeof makeIdentity>, dialogHash: string, senderKey: ReturnType<typeof DialogCrypto.deriveSenderMsgKey>, admitSpy: MockInstance<ReturnType<typeof useDialogsStore>['admitMessageRow']>;

	beforeEach(async () => {
		setActivePinia(createPinia());
		resetCardRegistry();
		_setStoreForTests(makeMemStringStore());
		_setIntentStorageForTests(makeMemStringStore());
		_setAcceptedSnapshotStorageForTests(makeMemStringStore());
		_setProjectionStorageForTests((() => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, keys: async () => [...m.keys()], clear: async () => { m.clear(); } }; })());
		_setOwnObservedTailsStorageForTests(makeMemStringStore());
		me = makeIdentity(20);
		peer = makeIdentity(21);
		HOLDER.peer = peer.userHash;
		HOLDER.user!.currentUserHash = me.userHash;
		HOLDER.vault = me.vault;
		CAPTURE.mutations = [];
		CAPTURE.gate = null;
		collections = {
			cards: makeCollection({ [me.userHash]: me.card, [peer.userHash]: peer.card }),
			dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
		};
		stopLeaderElection(); // no test starts with a leftover "active session" from a previous one
		startLeaderElection(me.userHash, () => {});
		store = useDialogsStore();
		dialogHash = store.getDialogHash(peer.userHash)!;
		collections.dialog.keys.rows.set(`${dialogHash}|${me.userHash}`, {
			dialog_hash: dialogHash, sender_hash: me.userHash, peer_hash: peer.userHash, deleted_flag: false,
		});
		senderKey = DialogCrypto.deriveSenderMsgKey(me.sign.secretKey, me.kem.secretKey, bytesToHex(me.contactSk), peer.userHash);
		admitSpy = vi.spyOn(store, 'admitMessageRow');
	});

	afterEach(() => {
		stopLeaderElection();
	});

	const waitForVerdictWhere = async (predicate: (row: ShapeRow) => boolean, timeoutMs = 4000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const callIndex = admitSpy.mock.calls.findIndex(([row]) => predicate(row));
			if (callIndex !== -1) return await admitSpy.mock.results[callIndex].value;
			if (Date.now() > deadline) throw new Error('waitForVerdictWhere: admitMessageRow was never called for a matching row');
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	const waitForVerdict = (signHash: string, timeoutMs?: number) => waitForVerdictWhere((row) => row.sign_hash === signHash, timeoutMs);

	const mountChat = () => mount(PageChat, {
		global: {
			provide: { $swal: { fire: async () => ({}) } },
			stubs: { Avatar: true, TransferPanel: true, FileStateModal: true, EditHistoryModal: true, CheckpointDiffModal: true },
		},
	});

	const signedRow = async (messageId: string, text: string, refs: Record<string, string>, tweak: Record<string, SignableValue> = {}) => {
		const fields = {
			message_id: messageId, dialog_hash: dialogHash, sender_hash: me.userHash,
			content_b64: await DialogCrypto.encryptContent(senderKey, encodeContent([{ kind: 'text', text }])),
			deleted_flag: false,
			refs_map_b64: await DialogCrypto.encryptContent(senderKey, JSON.stringify(refs)),
			parent_sign_hash: null, owner_timestamp: 1_700_000_500, ...tweak,
		};
		const sign_b64 = signFields(fields, me.sign.secretKey);
		return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) };
	};

	const deliverShape = (row: ShapeRow) => {
		collections.dialog.messages.rows.set(row.message_id, row);
		collections.dialog.messages.notify();
	};

	it('local projection survives SERVER_ACCEPTED with no visible gap, then a verified shape echo — and only a verified one — replaces it with the canonical row', async () => {
		let releaseAccept!: (value?: unknown) => void;
		CAPTURE.gate = new Promise((r) => { releaseAccept = r; });

		const wrapper = mountChat();
		try {
			await wrapper.find('input[type="text"]').setValue('boundary one two three');
			await wrapper.find('form').trigger('submit');

			await waitUntil(() => wrapper.text().includes('boundary one two three'));
			expect(wrapper.find('.sync-status.synced').exists()).toBe(false);
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);

			releaseAccept();
			await waitUntil(() => wrapper.find('.sync-status.synced').exists());
			expect(wrapper.text()).toContain('boundary one two three');
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);
			expect(collections.dialog.messages.rows.size).toBe(0);

			const dispatched = CAPTURE.mutations.at(-1)!.modified;
			const unresolvedParent = { ['dmsg_never_' + 'a'.repeat(8)]: 'dms_' + 'f'.repeat(128) };
			const waitingRefsB64 = await DialogCrypto.encryptContent(senderKey, JSON.stringify(unresolvedParent));
			const waitingFields = { ...dispatched, refs_map_b64: waitingRefsB64 };
			const waitingRow = { ...waitingFields, sign_b64: signFields(waitingFields, me.sign.secretKey) };
			waitingRow.sign_hash = deriveSignHash('dms_', waitingRow.sign_b64);
			deliverShape(waitingRow);
			await new Promise((r) => setTimeout(r, 400));
			expect(wrapper.text()).toContain('boundary one two three');
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);
			expect(wrapper.find('.msg-unplaced-note').exists()).toBe(false);
			expect(store.isMessageAdmitted(dialogHash, dispatched.message_id, waitingRow.sign_hash)).toBe(false);

			deliverShape(dispatched);
			await waitUntil(() => store.isMessageAdmitted(dialogHash, dispatched.message_id, dispatched.sign_hash));
			await waitUntil(() => !wrapper.find('.message-pending').exists());
			expect(wrapper.text()).toContain('boundary one two three');
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);
		} finally {
			wrapper.unmount();
		}
	});

	it('rolls back to the pre-fix bug on a local revert: an unverified/waiting echo alone would have cleared the projection', async () => {
		const messageId = nextMessageId();
		const optId = store.addOptimisticMessageWithId(dialogHash, messageId, 'still just typed', 1_700_000_100 as never);
		store.updateOptimisticStatus(optId, 'synced');

		const wrapper = mountChat();
		try {
			await waitUntil(() => wrapper.text().includes('still just typed'));

			const missingParent = { ['dmsg_missing_' + 'b'.repeat(8)]: 'dms_' + '1'.repeat(128) };
			const row = await signedRow(messageId, 'wrong text from a waiting echo', missingParent);
			deliverShape(row);
			await new Promise((r) => setTimeout(r, 400));

			expect(store.isMessageAdmitted(dialogHash, messageId, row.sign_hash)).toBe(false);
			expect(wrapper.text()).toContain('still just typed');
			expect(wrapper.text()).not.toContain('wrong text from a waiting echo');
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);
		} finally {
			wrapper.unmount();
		}
	});

	it('a shape row with a bad signature cannot retire the projection', async () => {
		const messageId = nextMessageId();
		const optId = store.addOptimisticMessageWithId(dialogHash, messageId, 'authentic draft', 1_700_000_100 as never);
		store.updateOptimisticStatus(optId, 'synced');

		const wrapper = mountChat();
		try {
			await waitUntil(() => wrapper.text().includes('authentic draft'));

			const honest = await signedRow(messageId, 'authentic draft', {});
			const forged = { ...honest, content_b64: await DialogCrypto.encryptContent(senderKey, encodeContent([{ kind: 'text', text: 'forged by tampering' }])) };
			deliverShape(forged);
			await new Promise((r) => setTimeout(r, 400));

			expect(store.isMessageAdmitted(dialogHash, messageId, forged.sign_hash)).toBe(false);
			expect(wrapper.text()).toContain('authentic draft');
			expect(wrapper.text()).not.toContain('forged by tampering');
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);
		} finally {
			wrapper.unmount();
		}
	});

	it('a shape row whose sign_hash does not derive from its own signature (wrong revision identity) cannot retire the projection', async () => {
		const messageId = nextMessageId();
		const optId = store.addOptimisticMessageWithId(dialogHash, messageId, 'still local', 1_700_000_100 as never);
		store.updateOptimisticStatus(optId, 'synced');

		const wrapper = mountChat();
		try {
			await waitUntil(() => wrapper.text().includes('still local'));

			const honest = await signedRow(messageId, 'still local', {});
			const lyingRevision = { ...honest, sign_hash: 'dms_' + '7'.repeat(128) };
			deliverShape(lyingRevision);
			await new Promise((r) => setTimeout(r, 400));

			expect(store.isMessageAdmitted(dialogHash, messageId, honest.sign_hash)).toBe(false);
			expect(store.isMessageAdmitted(dialogHash, messageId, lyingRevision.sign_hash)).toBe(false);
			expect(wrapper.text()).toContain('still local');
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);
		} finally {
			wrapper.unmount();
		}
	});

	it('an older, unrelated verified message does not retire a different, newer local projection', async () => {
		const olderId = nextMessageId();
		const olderRow = await signedRow(olderId, 'older already-verified message', {}, { owner_timestamp: 1_700_000_000 });
		deliverShape(olderRow);

		const wrapper = mountChat();
		try {
			await waitUntil(() => store.isMessageAdmitted(dialogHash, olderId, olderRow.sign_hash));
			await waitUntil(() => wrapper.text().includes('older already-verified message'));

			let releaseAccept!: (value?: unknown) => void;
			CAPTURE.gate = new Promise((r) => { releaseAccept = r; });
			await wrapper.find('input[type="text"]').setValue('newer still-pending message');
			await wrapper.find('form').trigger('submit');
			releaseAccept();
			await waitUntil(() => wrapper.text().includes('newer still-pending message'));

			expect(wrapper.text()).toContain('older already-verified message');
			expect(wrapper.text()).toContain('newer still-pending message');
			expect(wrapper.findAll('.message-bubble')).toHaveLength(2);
		} finally {
			wrapper.unmount();
		}
	});

	it('a waiting (causally unresolved) tombstone is not a canonical deletion — it only becomes one once its missing dependency admits it as verified', async () => {
		const messageId = nextMessageId();
		const optId = store.addOptimisticMessageWithId(dialogHash, messageId, 'still typed, not deleted yet', 1_700_000_100 as never);
		store.updateOptimisticStatus(optId, 'synced');

		const wrapper = mountChat();
		try {
			await waitUntil(() => wrapper.text().includes('still typed, not deleted yet'));

			const missingParentId = 'dmsg_missing_' + 'c'.repeat(8);
			const parentRow = await signedRow(missingParentId, 'the original message', {}, { owner_timestamp: 1_700_000_050 });

			const unresolvedRef = { [parentRow.message_id]: parentRow.sign_hash };
			const tombstone = await signedRow(messageId, '', unresolvedRef, { deleted_flag: true, content_b64: '' });
			deliverShape(tombstone);

			const verdict = await waitForVerdict(tombstone.sign_hash);
			expect(verdict.status).toBe('waiting');
			expect(store.isMessageAdmitted(dialogHash, messageId, tombstone.sign_hash)).toBe(false);
			await nextTick();

			expect(wrapper.text()).not.toContain('Message deleted');
			expect(wrapper.text()).toContain('still typed, not deleted yet');
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);

			deliverShape(parentRow);

			await waitUntil(() => store.isMessageAdmitted(dialogHash, messageId, tombstone.sign_hash));
			await waitUntil(() => wrapper.text().includes('Message deleted'));
			expect(wrapper.text()).not.toContain('still typed, not deleted yet');
			expect(wrapper.findAll('.message-bubble')).toHaveLength(2);
		} finally {
			wrapper.unmount();
		}
	});

	it('a same-message_id, same-(empty)-content revision with a different signed identity is re-admitted from scratch — it never inherits the prior revision\'s verified-deletion state', async () => {
		const messageId = nextMessageId();

		const revisionA = await signedRow(messageId, '', {}, { deleted_flag: true, content_b64: '' });
		deliverShape(revisionA);

		const wrapper = mountChat();
		try {
			await waitUntil(() => store.isMessageAdmitted(dialogHash, messageId, revisionA.sign_hash));
			await waitUntil(() => wrapper.text().includes('Message deleted'));
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);

			const missingParentId = 'dmsg_missing_' + 'd'.repeat(8);
			const parentRow = await signedRow(
				missingParentId, 'the real original', { [messageId]: revisionA.sign_hash }, { owner_timestamp: 1_700_000_040 }
			);
			const unresolvedRef = { [parentRow.message_id]: parentRow.sign_hash };
			const revisionB = await signedRow(
				messageId, '', unresolvedRef, { deleted_flag: true, content_b64: '', owner_timestamp: 1_700_000_600 }
			);
			expect(revisionB.sign_hash).not.toBe(revisionA.sign_hash);
			expect(revisionB.content_b64).toBe(revisionA.content_b64);

			deliverShape(revisionB);

			const verdictB = await waitForVerdict(revisionB.sign_hash);
			expect(verdictB.status).toBe('waiting');
			await nextTick();

			expect(store.isMessageAdmitted(dialogHash, messageId, revisionA.sign_hash)).toBe(true);
			expect(store.isMessageAdmitted(dialogHash, messageId, revisionB.sign_hash)).toBe(false);

			expect(wrapper.text()).not.toContain('Message deleted');
			expect(wrapper.find('.msg-unplaced-note').exists()).toBe(true);
			expect(wrapper.findAll('.message-bubble')).toHaveLength(1);

			deliverShape(parentRow);
			await waitUntil(() => store.isMessageAdmitted(dialogHash, messageId, revisionB.sign_hash));
			await waitUntil(() => wrapper.text().includes('Message deleted'));
			expect(wrapper.find('.msg-unplaced-note').exists()).toBe(false);
			expect(wrapper.findAll('.message-bubble')).toHaveLength(2);
		} finally {
			wrapper.unmount();
		}
	});

	it('a row reusing a prior revision\'s exact claimed sign_hash but with a different signed field is re-verified and rejected, never served the prior revision\'s trusted state', async () => {
		const messageId = nextMessageId();

		const revisionA = await signedRow(messageId, 'the real message', {});
		deliverShape(revisionA);

		const wrapper = mountChat();
		try {
			await waitUntil(() => store.isMessageAdmitted(dialogHash, messageId, revisionA.sign_hash));
			await waitUntil(() => wrapper.text().includes('the real message'));
			const callsBeforeC = admitSpy.mock.calls.length;

			const revisionC = { ...revisionA, deleted_flag: true };
			expect(revisionC.sign_hash).toBe(revisionA.sign_hash);
			expect(revisionC.content_b64).toBe(revisionA.content_b64);

			deliverShape(revisionC);

			await waitForVerdictWhere((row) => row.message_id === messageId && row.deleted_flag === true);
			expect(admitSpy.mock.calls.length).toBeGreaterThan(callsBeforeC);
			await nextTick();

			expect(store.isMessageAdmitted(dialogHash, messageId, revisionC.sign_hash)).toBe(true);
			expect(store.isRowAdmitted(dialogHash, revisionC)).toBe(false);
			expect(store.isRowAdmitted(dialogHash, revisionA)).toBe(true);
			await waitUntil(() => wrapper.text().includes('Message failed verification'));
			expect(wrapper.text()).not.toContain('Message deleted');
		} finally {
			wrapper.unmount();
		}
	});
});

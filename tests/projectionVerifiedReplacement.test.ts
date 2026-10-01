// @vitest-environment jsdom
// A local message projection is replaced only by verified canonical state —
// never by HTTP acceptance, a shape timeout, raw shape presence, or a row that
// is invalid or not verifiable yet. Production path end to end: Page_Chat, the
// dialogs store, intents, the outbox and its sender, reconciliation and the
// accepted snapshot are real; only the HTTP transport and the shape barrier's
// answer are faked. Real ML-DSA signatures throughout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { encodeContent } from '@/lib/pq/content';
import { makeFakeLockManager } from './helpers/fakeWebLocks';
import type { SignableValue } from '@/lib/pq/signature';

type Row = Record<string, SignableValue> & { message_id: string; sign_hash: string; owner_timestamp: number };

const HOLDER = vi.hoisted(() => ({ user: null as { currentUserHash: string; contacts: unknown[]; getUserByHash: () => null } | null, vault: {}, peer: '', locked: false }));
const SWAL = vi.hoisted(() => ({ fired: [] as unknown[] }));
const HTTP = vi.hoisted(() => ({ bodies: [] as Row[][] }));
const BARRIER = vi.hoisted(() => ({ visible: true }));

vi.mock('vue-router', () => ({
	useRoute: () => ({ params: { get address() { return HOLDER.peer; } }, query: {} }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	HOLDER.user = reactive({ currentUserHash: '', contacts: [], getUserByHash: () => null });
	return { userPQStore: () => HOLDER.user };
});
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
let collections: { cards: Collection; dialog: { keys: Collection; messages: Collection; versions: Collection; reactions: Collection; receipts: Collection } };
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
	withDialogCollections: async (_h: string, read: (dialog: typeof collections.dialog) => unknown) => read(collections.dialog),
}));
vi.mock('@/api/client', async (importOriginal) => ({
	api: {
		...(await importOriginal<typeof import('@/api/client')>()).api,
		ingestWithAuthEach: async (mutations: Array<{ modified?: Row; changes?: Row }>) => {
			HTTP.bodies.push(mutations.map((m) => JSON.parse(JSON.stringify(m.modified ?? m.changes))));
			return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 500 + HTTP.bodies.length })) }) } as unknown as Response;
		},
	},
}));
vi.mock('@/lib/data/barrier', () => ({
	awaitShapeVisibility: async () => BARRIER.visible,
	collectionForRelation: () => null,
	scopeForRelation: (relation: string) => relation,
}));
vi.mock('@/lib/data/writeContracts', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/data/writeContracts')>()),
	contractFor: () => ({ dependencyClass: 'independent', confirmation: 'visible' }),
}));
vi.mock('@/libs/EncryptionManagerPQ', async () => {
	const { VaultLockedError } = await import('@/lib/data/keyCustody');
	return {
		EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => {
			if (HOLDER.locked) throw new VaultLockedError('the vault is locked');
			return HOLDER.vault;
		} }) },
	};
});

const { resetCardRegistry } = await import('@/lib/data/cardRegistry');
const { _setStoreForTests } = await import('@/lib/data/localStore');
const outbox = await import('@/lib/data/outbox');
const ingest = await import('@/lib/data/ingest');
const { _setIntentStorageForTests } = await import('@/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { _setOwnObservedTailsStorageForTests } = await import('@/lib/data/ownObservedTails');
const { _setProjectionStorageForTests } = await import('@/lib/data/messageProjections');
const { readAcceptedOperation } = await import('@/lib/data/operationLifecycle');
const { getVerifiedSignPkey } = await import('@/lib/data/cardRegistry');
const PageChat = (await import('@/views/chats/Page_Chat.vue')).default;
const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');

const memStore = () => {
	const map = new Map<string, string>();
	return {
		map,
		deleted: [] as string[],
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { this.deleted.push(k); map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const makeIdentity = (seed: number) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactSk = new Uint8Array(32).fill(seed);
	const contactPk = secp.getPublicKey(contactSk, true);
	const card: Record<string, SignableValue> = {
		user_hash: 'u_' + bytesToHex(sha3_512(sign.publicKey)), sign_pkey: toBase64(sign.publicKey), crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk), contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name: `sender-${seed}`, deleted_flag: false, owner_timestamp: 1_700_000_000,
	};
	card.sign_b64 = signFields(card as never, sign.secretKey);
	return { sign, kem, contactSk, userHash: card.user_hash as string, card,
		vault: { sign_skey: toBase64(sign.secretKey), crypt_skey: toBase64(kem.secretKey), evm_skey: bytesToHex(contactSk) } };
};
const me = makeIdentity(30);
const peer = makeIdentity(31);

const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 4000) => {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error('waitUntil: condition never became true');
		await new Promise((r) => setTimeout(r, 25));
	}
};
const settle = () => new Promise((r) => setTimeout(r, 300));

let store: ReturnType<typeof useDialogsStore>;
let dialogHash: string;
let senderKey: ReturnType<typeof DialogCrypto.deriveSenderMsgKey>;
let projections: ReturnType<typeof memStore>;
let wrapper: VueWrapper | null = null;

const mountChat = () => {
	wrapper = mount(PageChat, {
		global: {
			provide: { $swal: { fire: async (opts: unknown) => { SWAL.fired.push(opts); return {}; } } },
			stubs: { Avatar: true, TransferPanel: true, FileStateModal: true, EditHistoryModal: true, CheckpointDiffModal: true },
		},
	});
	return wrapper;
};
const deliverShape = (row: Row) => {
	collections.dialog.messages.rows.set(row.message_id, row);
	collections.dialog.messages.notify();
};
const projectionKey = (id: string) => `projection:${id}`;
const hasProjection = (id: string) => store.optimisticItems.has(id) && projections.map.has(projectionKey(id));
const retirements = (id: string) => projections.deleted.filter((k) => k === projectionKey(id)).length;
const bubbles = () => wrapper!.findAll('.message-bubble').length;

const sendAccepted = async (text: string) => {
	const before = HTTP.bodies.length;
	await wrapper!.find('input[type="text"]').setValue(text);
	await wrapper!.find('form').trigger('submit');
	await waitUntil(() => HTTP.bodies.length > before);
	const row = HTTP.bodies.at(-1)![0];
	const id = row.message_id;
	await waitUntil(() => store.optimisticItems.get(id)?.status === 'synced');
	return { id, row };
};
const revisionOf = async (row: Row, text: string, ownerTimestamp: number): Promise<Row> => {
	const fields = {
		message_id: row.message_id, dialog_hash: row.dialog_hash, sender_hash: me.userHash,
		content_b64: await DialogCrypto.encryptContent(senderKey, encodeContent([{ kind: 'text', text }])),
		deleted_flag: false, refs_map_b64: row.refs_map_b64, parent_sign_hash: null, owner_timestamp: ownerTimestamp,
	};
	const sign_b64 = signFields(fields as never, me.sign.secretKey);
	return { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) } as Row;
};
const replay = async () => {
	ingest.drainPendingWrites(me.userHash, me.sign.secretKey);
	await outbox._drainLoopSettledForTests();
	await settle();
};

beforeEach(async () => {
	setActivePinia(createPinia());
	resetCardRegistry();
	Object.defineProperty(globalThis.navigator, 'locks', { value: makeFakeLockManager(), configurable: true });
	HTTP.bodies = [];
	BARRIER.visible = true;
	HOLDER.locked = false;
	SWAL.fired = [];
	_setStoreForTests(memStore());
	_setIntentStorageForTests(memStore());
	outbox._setStorageForTests(memStore());
	_setAcceptedSnapshotStorageForTests(memStore());
	projections = memStore();
	_setProjectionStorageForTests(projections);
	_setOwnObservedTailsStorageForTests(memStore());
	HOLDER.peer = peer.userHash;
	HOLDER.user!.currentUserHash = me.userHash;
	HOLDER.vault = me.vault;
	collections = {
		cards: makeCollection({ [me.userHash]: me.card, [peer.userHash]: peer.card }),
		dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
	};
	outbox.stopLeaderElection();
	outbox.startLeaderElection(me.userHash, () => {});
	await waitUntil(() => outbox.isLeader());
	store = useDialogsStore();
	dialogHash = store.getDialogHash(peer.userHash)!;
	senderKey = DialogCrypto.deriveSenderMsgKey(me.sign.secretKey, me.kem.secretKey, bytesToHex(me.contactSk), peer.userHash);
	const wrapped = await DialogCrypto.wrapSenderMsgKey(senderKey, peer.kem.publicKey);
	const keyFields = {
		dialog_hash: dialogHash, sender_hash: me.userHash, peer_hash: peer.userHash,
		peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64, peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
		deleted_flag: false, owner_timestamp: 1_700_000_000,
	};
	collections.dialog.keys.rows.set(`${dialogHash}|${me.userHash}`, { ...keyFields, sign_b64: signFields(keyFields as never, me.sign.secretKey) });
	mountChat();
});

afterEach(async () => {
	wrapper?.unmount();
	wrapper = null;
	outbox.stopDrainLoop();
	outbox.stopLeaderElection();
	await outbox._drainLoopSettledForTests();
});

describe('acceptance and the shape barrier do not replace the projection', () => {
	it('accepted, no shape row yet: the projection stays', async () => {
		const { id } = await sendAccepted('accepted, not echoed');
		await settle();
		expect(hasProjection(id)).toBe(true);
		expect(wrapper!.text()).toContain('accepted, not echoed');
		expect(retirements(id)).toBe(0);
	});

	it('a shape timeout keeps the projection and sends nothing again', async () => {
		BARRIER.visible = false;
		const { id } = await sendAccepted('the shape never came');
		await replay();
		await replay();
		expect(HTTP.bodies).toHaveLength(1);
		expect(hasProjection(id)).toBe(true);
		expect(wrapper!.text()).toContain('the shape never came');
	});

	it('an independent write is sent while another waits for its verified replacement', async () => {
		BARRIER.visible = false;
		const first = await sendAccepted('waiting for its echo');
		const second = await sendAccepted('sent meanwhile');
		expect(HTTP.bodies.map((b) => b[0].message_id)).toEqual([first.id, second.id]);
		expect(hasProjection(first.id)).toBe(true);
	});
});

describe('the exact row replaces it only once it verifies', () => {
	it('verified exact row: the projection is retired exactly once and the canonical row stays', async () => {
		const { id, row } = await sendAccepted('the canonical one');
		deliverShape(row);
		await waitUntil(() => !store.optimisticItems.has(id));
		await replay();
		deliverShape({ ...row });
		await settle();
		expect(retirements(id)).toBe(1);
		expect(projections.map.has(projectionKey(id))).toBe(false);
		expect(wrapper!.text()).toContain('the canonical one');
		expect(bubbles()).toBe(1);
	});

	it('exact row whose author card is not here yet: kept; once the card arrives it verifies and replaces', async () => {
		const { id, row } = await sendAccepted('card comes later');
		collections.cards.rows.delete(me.userHash);
		resetCardRegistry();
		deliverShape(row);
		await settle();
		expect(await readAcceptedOperation('dialog_messages', id, me.userHash, { shapeRow: row, resolveSignPkey: getVerifiedSignPkey }))
			.toMatchObject({ phase: 'SHAPE_VISIBLE', verification: { status: 'unavailable', reason: 'author_card_unavailable' } });
		expect(hasProjection(id)).toBe(true);
		expect(wrapper!.text()).toContain('card comes later');

		collections.cards.rows.set(me.userHash, me.card);
		collections.cards.notify();
		await waitUntil(() => !store.optimisticItems.has(id));
		expect(retirements(id)).toBe(1);
		expect(wrapper!.text()).toContain('card comes later');
		expect(bubbles()).toBe(1);
	});

	it('exact row with a bad signature: kept and never canonical; the honest row later replaces it', async () => {
		const { id, row } = await sendAccepted('the honest text');
		const forged = { ...row, content_b64: await DialogCrypto.encryptContent(senderKey, encodeContent([{ kind: 'text', text: 'forged text' }])) };
		deliverShape(forged);
		await settle();
		expect(hasProjection(id)).toBe(true);
		expect(retirements(id)).toBe(0);
		expect(wrapper!.text()).toContain('the honest text');
		expect(wrapper!.text()).not.toContain('forged text');
		expect(bubbles()).toBe(1);

		deliverShape(row);
		await waitUntil(() => !store.optimisticItems.has(id));
		expect(retirements(id)).toBe(1);
		expect(wrapper!.text()).toContain('the honest text');
		expect(bubbles()).toBe(1);
	});

	it('another revision of the same message is not this operation\'s completion', async () => {
		const { id, row } = await sendAccepted('my accepted revision');
		const ts = Number(row.owner_timestamp);
		for (const [other, shape] of [
			[await revisionOf(row, 'an older revision', ts - 5), 'older'],
			[await revisionOf(row, 'same time, other signature', ts), 'other_revision'],
		] as const) {
			deliverShape(other);
			await waitUntil(() => store.isMessageAdmitted(dialogHash, id, other.sign_hash));
			await settle();
			expect(await readAcceptedOperation('dialog_messages', id, me.userHash, { shapeRow: other, resolveSignPkey: getVerifiedSignPkey }))
				.toMatchObject({ phase: 'SERVER_ACCEPTED', shape });
			expect(hasProjection(id)).toBe(true);
		}
		const newer = await revisionOf(row, 'edited elsewhere later', ts + 5);
		deliverShape(newer);
		await waitUntil(() => !store.optimisticItems.has(id));
		expect(await readAcceptedOperation('dialog_messages', id, me.userHash, { shapeRow: newer, resolveSignPkey: getVerifiedSignPkey }))
			.toMatchObject({ phase: 'SERVER_ACCEPTED', shape: 'newer' });
		expect(wrapper!.text()).toContain('edited elsewhere later');
		expect(HTTP.bodies).toHaveLength(1);
	});
});

describe('an edit made while the vault is locked', () => {
	it('is shown as waiting for unlock, not as "not saved"; the unlock sends it with no new action', async () => {
		const { id, row } = await sendAccepted('before the edit');
		deliverShape(row);
		await waitUntil(() => !store.optimisticItems.has(id));

		HOLDER.locked = true;
		wrapper!.findComponent({ name: 'ChatWindow' }).vm.$emit('editMessage', id, 'edited while locked');
		await waitUntil(() => wrapper!.find('[title="Waiting for unlock"]').exists());
		expect(wrapper!.text()).toContain('edited while locked');
		expect(SWAL.fired).toEqual([]);
		expect(wrapper!.find('.sync-status.error').exists()).toBe(false);
		const { intentsOf } = await import('@/lib/data/intents');
		expect((await intentsOf(me.userHash)).entries.map((e) => (e.intent as { kind?: string }).kind)).toEqual(['edit']);

		HOLDER.locked = false;
		const { recoverIntents } = await import('@/lib/data/intentRecovery');
		const { materializeMessageIntent } = await import('@/lib/data/messageIntent');
		await recoverIntents(me.userHash, async () => me.sign.secretKey, { materializeMessage: materializeMessageIntent });
		await waitUntil(() => HTTP.bodies.length === 2);
		const edit = HTTP.bodies[1][0];
		expect(edit.parent_sign_hash).toBe(row.sign_hash);
		deliverShape(edit);
		await waitUntil(() => !wrapper!.find('[title="Waiting for unlock"]').exists());
		expect(wrapper!.text()).toContain('edited while locked');
		expect(SWAL.fired).toEqual([]);
	});
});

describe('reload between acceptance and shape arrival', () => {
	it('the projection and its acceptance come back from disk without a resend; the verified row then replaces it', async () => {
		const { id, row } = await sendAccepted('across a reload');
		wrapper!.unmount();
		setActivePinia(createPinia());
		store = useDialogsStore();
		mountChat();
		await waitUntil(() => store.optimisticItems.get(id)?.status === 'synced');
		expect(wrapper!.text()).toContain('across a reload');
		await replay();
		expect(HTTP.bodies).toHaveLength(1);

		deliverShape(row);
		await waitUntil(() => !store.optimisticItems.has(id));
		expect(retirements(id)).toBe(1);
		expect(wrapper!.text()).toContain('across a reload');
		expect(HTTP.bodies).toHaveLength(1);
	});
});

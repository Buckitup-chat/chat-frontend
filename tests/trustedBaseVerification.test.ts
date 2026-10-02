import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toBase64 } from '@/lib/pq/signature';
import { deriveFrontierRoot, buildViewTree, CHECKPOINT_VERSION, REDUCER_VERSION, TREE_VERSION } from '@/lib/pq/checkpoint';
import { makeFakeLockManager } from './helpers/fakeWebLocks';
import { makeTestIdentity, resignedCard, signRow, signedDialogKeyRow, signedStorageRow, type TestIdentity } from './helpers/signedFixtures';

type Row = Record<string, unknown>;

const HOLDER = vi.hoisted(() => ({ user: null as { currentUserHash: string } | null, vault: {} as Record<string, string> }));
const HTTP = vi.hoisted(() => ({ bodies: [] as unknown[] }));

const makeCollection = (rows: Record<string, unknown> = {}) => ({
	rows: new Map<string, unknown>(Object.entries(rows)),
	async preload() {},
	get(key: string) { return this.rows.get(key); },
	get toArray() { return [...this.rows.values()]; },
	subscribeChanges() { return { unsubscribe() {} }; },
});
type Collection = ReturnType<typeof makeCollection>;
let collections: { cards: Collection; storage: Collection; dialog: { keys: Collection; messages: Collection; versions: Collection; reactions: Collection; receipts: Collection } };

vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	HOLDER.user = reactive({ currentUserHash: '' });
	return { userPQStore: () => HOLDER.user };
});
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getUserStorageCollection: () => collections.storage,
	getDialogCollections: () => collections.dialog,
	withDialogCollections: async (_h: string, read: (d: typeof collections.dialog) => unknown) => read(collections.dialog),
}));
vi.mock('@/api/client', async (importOriginal) => ({
	api: {
		...(await importOriginal<typeof import('@/api/client')>()).api,
		ingestWithAuthEach: async (mutations: unknown[]) => {
			HTTP.bodies.push(mutations);
			return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 1 })) }) } as unknown as Response;
		},
	},
}));
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => HOLDER.vault }) },
}));

const { resetCardRegistry, getVerifiedSignPkey } = await import('@/lib/data/cardRegistry');
const { verifyReplicatedRow } = await import('@/lib/data/rowVerification');
const { _setStoreForTests } = await import('@/lib/data/localStore');
const outbox = await import('@/lib/data/outbox');
const { _setIntentStorageForTests, intentsOf } = await import('@/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests, recordAccepted } = await import('@/lib/data/acceptedSnapshot');
const { _setOwnObservedTailsStorageForTests } = await import('@/lib/data/ownObservedTails');
const { pinActiveSession } = await import('@/lib/data/sessionGuard');
const { resolveStorageBase, materializeStorageIntent, BaseUnavailableError } = await import('@/lib/data/storageIntent');
const { ensureOwnDialogKeyPublished } = await import('@/lib/data/messageIntent');
const { decideCardConstruction } = await import('@/lib/data/userCardIntent');
const { verifiedCards } = await import('@/lib/data/userCardsLink');
const { useDialogsStore } = await import('@/store/dialogs.store');
const { DialogCrypto } = await import('@/libs/DialogCrypto');
const { encodeContent } = await import('@/lib/pq/content');

const memStore = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const me = makeTestIdentity(41, 'me');
const peer = makeTestIdentity(42, 'peer');
const UUID = '0199bbbb-0000-7000-8000-000000000001';
const slotKey = `${me.userHash}|${UUID}`;
let outboxStore: ReturnType<typeof memStore>;
let intentStore: ReturnType<typeof memStore>;

beforeEach(async () => {
	resetCardRegistry();
	HTTP.bodies = [];
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	_setStoreForTests(memStore());
	intentStore = memStore();
	_setIntentStorageForTests(intentStore);
	outboxStore = memStore();
	outbox._setStorageForTests(outboxStore);
	_setAcceptedSnapshotStorageForTests(memStore());
	_setOwnObservedTailsStorageForTests(memStore());
	HOLDER.user!.currentUserHash = me.userHash;
	HOLDER.vault = me.vault;
	collections = {
		cards: makeCollection({ [me.userHash]: me.card, [peer.userHash]: peer.card }),
		storage: makeCollection(),
		dialog: { keys: makeCollection(), messages: makeCollection(), versions: makeCollection(), reactions: makeCollection(), receipts: makeCollection() },
	};
	outbox.stopLeaderElection();
	outbox.startLeaderElection(me.userHash, () => {});
	await vi.waitFor(() => expect(outbox.isLeader()).toBe(true));
});

afterEach(async () => {
	outbox.stopDrainLoop();
	outbox.stopLeaderElection();
	await outbox._drainLoopSettledForTests();
	vi.unstubAllGlobals();
});

const token = () => pinActiveSession(me.userHash, 'test');
const removeCard = (who: TestIdentity) => { collections.cards.rows.delete(who.userHash); resetCardRegistry(); };

describe('user_storage: only a verified replicated row is a base', () => {
	const live = (row: Row) => collections.storage.rows.set(slotKey, row);

	it('a verified live row is the update base', async () => {
		const row = signedStorageRow(me, { uuid: UUID, owner_timestamp: 1_700_000_100 });
		live(row);
		expect(await resolveStorageBase(me.userHash, UUID, token())).toEqual({ kind: 'update', base: row });
	});

	it('a bad signature or a wrong sign_hash is no base — and no insert', async () => {
		const row = signedStorageRow(me, { uuid: UUID, owner_timestamp: 1_700_000_100 });
		live({ ...row, value_b64: toBase64(new Uint8Array([9, 9])) });
		expect(await resolveStorageBase(me.userHash, UUID, token())).toEqual({ kind: 'blocked', reason: 'replicated_unverified' });
		live({ ...row, sign_hash: 'uss_' + '0'.repeat(128) });
		expect(await resolveStorageBase(me.userHash, UUID, token())).toEqual({ kind: 'blocked', reason: 'replicated_unverified' });
	});

	it('without the author\'s verified card the row cannot be a base: construction blocks', async () => {
		live(signedStorageRow(me, { uuid: UUID, owner_timestamp: 1_700_000_100 }));
		removeCard(me);
		expect(await resolveStorageBase(me.userHash, UUID, token())).toEqual({ kind: 'blocked', reason: 'replicated_unverifiable' });
	});

	it('the own accepted snapshot is a base without any shape echo, and outranks an older unverified row', async () => {
		const accepted = signedStorageRow(me, { uuid: UUID, owner_timestamp: 1_700_000_200 });
		await recordAccepted('user_storage', slotKey, accepted, me.userHash);
		expect(await resolveStorageBase(me.userHash, UUID, token())).toEqual({ kind: 'update', base: accepted });
		live({ ...signedStorageRow(me, { uuid: UUID, owner_timestamp: 1_700_000_100 }), value_b64: toBase64(new Uint8Array([7])) });
		expect(await resolveStorageBase(me.userHash, UUID, token())).toEqual({ kind: 'update', base: accepted });
		live({ ...signedStorageRow(me, { uuid: UUID, owner_timestamp: 1_700_000_300 }), value_b64: toBase64(new Uint8Array([7])) });
		expect(await resolveStorageBase(me.userHash, UUID, token())).toEqual({ kind: 'blocked', reason: 'replicated_unverified' });
	});

	it('the same intent goes on once the card is here: no second intent, no snapshot, nothing sent before', async () => {
		const row = signedStorageRow(me, { uuid: UUID, owner_timestamp: 1_700_000_100 });
		live(row);
		removeCard(me);
		const payload = { kind: 'storage' as const, relation: 'user_storage' as const, userHash: me.userHash, uuid: UUID, deletedFlag: false, valueB64: toBase64(new Uint8Array([5])), revision: 1 };
		await expect(materializeStorageIntent(payload, token())).rejects.toBeInstanceOf(BaseUnavailableError);
		expect(outboxStore.map.size).toBe(0);
		expect((await intentsOf(me.userHash)).entries).toHaveLength(0);
		expect(HTTP.bodies).toHaveLength(0);

		collections.cards.rows.set(me.userHash, me.card);
		const ready = await materializeStorageIntent(payload, token());
		expect(ready).toMatchObject({ mutationType: 'update', row: { parent_sign_hash: row.sign_hash } });
		expect(outboxStore.map.size).toBe(0);
		expect(HTTP.bodies).toHaveLength(0);
	});
});

describe('dialog_keys: only a verified key row gives a key', () => {
	let store: ReturnType<typeof useDialogsStore>;
	let dialogHash: string;
	let peerSenderKey: Uint8Array;
	let peerKeyRow: Row;

	beforeEach(async () => {
		setActivePinia(createPinia());
		store = useDialogsStore();
		dialogHash = store.getDialogHash(peer.userHash)!;
		peerSenderKey = DialogCrypto.deriveSenderMsgKey(peer.signSkey, peer.kemSkey, peer.vault.evm_skey, me.userHash);
		const myCryptPkey = Uint8Array.from(atob(me.card.crypt_pkey as string), (c) => c.charCodeAt(0));
		const wrapped = await DialogCrypto.wrapSenderMsgKey(peerSenderKey, myCryptPkey) as { peerKemWrapKeyB64: string; peerWrappedMsgKeyB64: string };
		peerKeyRow = signedDialogKeyRow(peer, {
			dialog_hash: dialogHash, peer_hash: me.userHash,
			peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64, peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
		});
	});
	const keyRowAt = (row: Row) => collections.dialog.keys.rows.set(`${dialogHash}|${row.sender_hash}`, row);
	const sameBytes = (a: unknown, b: Uint8Array) => a instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);

	it('a verified peer key row unwraps to the peer\'s sender key', async () => {
		keyRowAt(peerKeyRow);
		expect(sameBytes(await store.getSenderMsgKey(dialogHash, peer.userHash), peerSenderKey)).toBe(true);
	});

	it('a forged key row does not unwrap and is not cached; the honest row then does', async () => {
		const otherWrap = await DialogCrypto.wrapSenderMsgKey(new Uint8Array(32).fill(7), Uint8Array.from(atob(me.card.crypt_pkey as string), (c) => c.charCodeAt(0))) as { peerKemWrapKeyB64: string; peerWrappedMsgKeyB64: string };
		keyRowAt({ ...peerKeyRow, peer_kem_wrap_key_b64: otherWrap.peerKemWrapKeyB64, peer_wrapped_msg_key_b64: otherWrap.peerWrappedMsgKeyB64 });
		expect(await store.getSenderMsgKey(dialogHash, peer.userHash)).toBeNull();
		keyRowAt(peerKeyRow);
		expect(sameBytes(await store.getSenderMsgKey(dialogHash, peer.userHash), peerSenderKey)).toBe(true);
	});

	it('a missing or invalid author card leaves the key unavailable; with the verified card the same row works', async () => {
		keyRowAt(peerKeyRow);
		removeCard(peer);
		expect(await store.getSenderMsgKey(dialogHash, peer.userHash)).toBeNull();
		expect(await verifyReplicatedRow('dialog_keys', peerKeyRow, getVerifiedSignPkey)).toEqual({ status: 'unavailable', reason: 'author_card_unavailable' });
		collections.cards.rows.set(peer.userHash, { ...peer.card, name: 'renamed, not re-signed' });
		expect(await store.getSenderMsgKey(dialogHash, peer.userHash)).toBeNull();
		expect((await verifyReplicatedRow('dialog_keys', peerKeyRow, getVerifiedSignPkey)).status).not.toBe('verified');

		collections.cards.rows.set(peer.userHash, peer.card);
		expect(sameBytes(await store.getSenderMsgKey(dialogHash, peer.userHash), peerSenderKey)).toBe(true);
	});

	it('an own key row is used only once it verifies', async () => {
		const own = signedDialogKeyRow(me, { dialog_hash: dialogHash, peer_hash: peer.userHash });
		keyRowAt({ ...own, peer_hash: me.userHash });
		expect(await store.getSenderMsgKey(dialogHash, me.userHash)).toBeNull();
		keyRowAt(own);
		const expected = DialogCrypto.deriveSenderMsgKey(me.signSkey, me.kemSkey, me.vault.evm_skey, peer.userHash);
		expect(sameBytes(await store.getSenderMsgKey(dialogHash, me.userHash), expected)).toBe(true);
	});
});

describe('ensureOwnDialogKeyPublished: published only on verified or accepted evidence', () => {
	const dialogHash = DialogCrypto.computeDialogHash(me.userHash, peer.userHash) as string;
	const keyId = `${dialogHash}|${me.userHash}`;
	const own = () => signedDialogKeyRow(me, { dialog_hash: dialogHash, peer_hash: peer.userHash });
	const keyIntents = async () => (await intentsOf(me.userHash)).entries.filter((e) => e.relation === 'dialog_keys');

	it('a verified own row is published: nothing written', async () => {
		collections.dialog.keys.rows.set(keyId, own());
		await ensureOwnDialogKeyPublished(peer.userHash, dialogHash, me.userHash, token());
		expect(await keyIntents()).toHaveLength(0);
		expect(HTTP.bodies).toHaveLength(0);
	});

	it('an invalid own row is not absence: no second, differently wrapped key is written', async () => {
		collections.dialog.keys.rows.set(keyId, { ...own(), peer_wrapped_msg_key_b64: toBase64(new Uint8Array([3, 3])) });
		await expect(ensureOwnDialogKeyPublished(peer.userHash, dialogHash, me.userHash, token())).rejects.toThrow(/cannot be verified/);
		expect(await keyIntents()).toHaveLength(0);
		expect(HTTP.bodies).toHaveLength(0);
	});

	it('the own accepted key write proves it without a shape echo — even beside an unverifiable row', async () => {
		await recordAccepted('dialog_keys', keyId, own(), me.userHash);
		await ensureOwnDialogKeyPublished(peer.userHash, dialogHash, me.userHash, token());
		collections.dialog.keys.rows.set(keyId, own());
		removeCard(me);
		await ensureOwnDialogKeyPublished(peer.userHash, dialogHash, me.userHash, token());
		expect(await keyIntents()).toHaveLength(0);
		expect(HTTP.bodies).toHaveLength(0);
	});

	it('a peer card that does not verify does not supply the wrapping key', async () => {
		collections.cards.rows.set(peer.userHash, { ...peer.card, crypt_pkey: me.card.crypt_pkey });
		await expect(ensureOwnDialogKeyPublished(peer.userHash, dialogHash, me.userHash, token())).rejects.toThrow(/Peer crypt_pkey not found/);
		expect(await keyIntents()).toHaveLength(0);
		expect(HTTP.bodies).toHaveLength(0);
	});
});

describe('checkpoints: read only from admitted revisions', () => {
	let store: ReturnType<typeof useDialogsStore>;
	let dialogHash: string;
	let myKey: Uint8Array;
	let seq = 0;

	beforeEach(() => {
		setActivePinia(createPinia());
		store = useDialogsStore();
		dialogHash = store.getDialogHash(peer.userHash)!;
		collections.dialog.keys.rows.set(`${dialogHash}|${me.userHash}`, signedDialogKeyRow(me, { dialog_hash: dialogHash, peer_hash: peer.userHash }));
		myKey = DialogCrypto.deriveSenderMsgKey(me.signSkey, me.kemSkey, me.vault.evm_skey, peer.userHash);
	});
	const message = async (parts: unknown[], refs: Record<string, string> = {}, ts = 1_700_000_500) => signRow(me, {
		message_id: `dmsg_0199cccc-0000-7000-8000-${String(++seq).padStart(12, '0')}`,
		dialog_hash: dialogHash, sender_hash: me.userHash,
		content_b64: await DialogCrypto.encryptContent(myKey, encodeContent(parts as never)),
		deleted_flag: false,
		refs_map_b64: await DialogCrypto.encryptContent(myKey, JSON.stringify(refs)),
		parent_sign_hash: null, owner_timestamp: ts,
	}, 'dms_');
	const checkpointPart = () => ({
		kind: 'checkpoint', version: CHECKPOINT_VERSION, reducerVersion: REDUCER_VERSION, treeVersion: TREE_VERSION,
		frontierRoot: deriveFrontierRoot({}), viewRoot: buildViewTree({}).root, frontier: {}, createdAt: 1_700_000_400,
	});
	const deliver = (row: Row) => collections.dialog.messages.rows.set(row.message_id as string, row);

	it('an admitted checkpoint message sets the pointer', async () => {
		const carrier = await message([checkpointPart()]);
		deliver(carrier);
		expect(await store.refreshCheckpointAlert(peer.userHash)).toMatchObject({ messageId: carrier.message_id, changed: false });
	});

	it('a checkpoint message with a bad signature does not', async () => {
		const carrier = await message([checkpointPart()]);
		deliver({ ...carrier, owner_timestamp: 1_700_000_501 });
		expect(await store.refreshCheckpointAlert(peer.userHash)).toBeNull();
	});

	it('a causally waiting one does not — until its parent admits it, then the same message does, once', async () => {
		const parent = await message([{ kind: 'text', text: 'earlier' }], {}, 1_700_000_100);
		const carrier = await message([checkpointPart()], { [parent.message_id as string]: parent.sign_hash as string });
		deliver(carrier);
		expect(await store.refreshCheckpointAlert(peer.userHash)).toBeNull();
		deliver(parent);
		expect(await store.refreshCheckpointAlert(peer.userHash)).toMatchObject({ messageId: carrier.message_id });
		expect(await store.refreshCheckpointAlert(peer.userHash)).toMatchObject({ messageId: carrier.message_id });
	});

	it('a blocked row is not admitted and does not move the alert', async () => {
		const carrier = await message([checkpointPart()]);
		deliver(carrier);
		await store.refreshCheckpointAlert(peer.userHash);
		const blocked = await message([{ kind: 'text', text: 'cites a revision that cannot exist' }], { [carrier.message_id as string]: 'dms_' + '9'.repeat(128) });
		deliver(blocked);
		expect(await store.refreshCheckpointAlert(peer.userHash)).toMatchObject({ messageId: carrier.message_id, changed: false });
	});
});

describe('user_cards: only verified cards are identities', () => {
	it('an invalid self-signature, user_hash or cert is not a trusted card; a verified one is', () => {
		const badSig = { ...me.card, name: 'mallory' };
		const badHash = resignedCard(me, { user_hash: 'u_' + 'a'.repeat(128) });
		const badCert = resignedCard(me, { crypt_cert: peer.card.crypt_cert });
		expect(verifiedCards([me.card, badSig, badHash, badCert, peer.card] as never)).toEqual([me.card, peer.card]);
	});

	it('the account\'s own unverified shape card is neither a card nor its absence', async () => {
		collections.cards.rows.set(me.userHash, { ...me.card, name: 'not re-signed' });
		expect(await decideCardConstruction(me.userHash, 'sign-in')).toMatchObject({ kind: 'blocked', reason: 'card_unverified' });
		expect(await decideCardConstruction(me.userHash, 'import')).toMatchObject({ kind: 'blocked', reason: 'card_unverified' });
		collections.cards.rows.set(me.userHash, me.card);
		expect(await decideCardConstruction(me.userHash, 'sign-in')).toEqual({ kind: 'proven' });
	});

	it('identity consumers read only verified cards', () => {
		const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
		expect(source('src/store/userPQ.store.js')).toMatch(/const readCards = \(rows\) => verifiedCards\(rows\)/);
		expect(source('src/components/engines/QRScannerEngine.vue')).toMatch(/if \(!exists && verifiedCards\(\[card\]\)\.length\)/);
	});
});

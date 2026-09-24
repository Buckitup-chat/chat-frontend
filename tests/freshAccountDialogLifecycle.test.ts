// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
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
import { DialogCrypto } from '@/libs/DialogCrypto';
import type { VueWrapper } from '@vue/test-utils';
import type { UserCardRow, DialogKeyRow, DialogMessageRow, DialogMessageVersionRow, DialogMessageReceiptRow } from '@/lib/data/types';
import type { App, ApplyResult, Relation, Row, RowOf, Server, ServerPost, VaultDisk, ViewChange } from './helpers/twoClients';

type FetchArgs = Parameters<typeof fetch>;
type LocalServer = Pick<Server, 'tables' | 'posts' | 'listeners' | 'table' | 'apply' | 'fetch'> & {
	hiddenFromShapes: Set<Relation>;
	visibleRows(relation: Relation): Row[];
	shapeSeen: Set<string>;
	offline?: boolean;
};
type LocalView = ReturnType<typeof view>;
type LocalDialogViews = Record<'keys' | 'messages' | 'versions' | 'reactions' | 'receipts', LocalView>;
type LocalApp = App & { attempts: Promise<unknown>[] };
type MutationBody = { syncMetadata: { relation: Relation }; type: string; modified?: Row; changes: Row };

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
		name: 'Peer', deleted_flag: false, owner_timestamp: 1_700_000_000,
	} as UserCardRow;
	card.sign_b64 = signFields(card as never, sign.secretKey);
	return { sign, kem, contactSk, userHash, card };
};
const PEER = makeIdentity(60);

let vaultDisk: VaultDisk;
vi.mock('@lo-fi/local-vault', () => ({
	connect: async ({ vaultID, addNewVault }: { vaultID: string; addNewVault?: boolean }) => {
		if (addNewVault) {
			const id = `vault-${vaultDisk.vaults.size + 1}`;
			const data = new Map<string, unknown>();
			vaultDisk.vaults.set(id, { id, async get(k: string) { return data.get(k); }, async set(k: string, v: unknown) { data.set(k, v); }, async clear() { data.clear(); } });
			return vaultDisk.vaults.get(id);
		}
		return vaultDisk.vaults.get(vaultID);
	},
	rawStorage: () => ({
		async get(k: string) { return vaultDisk.raw.get(k); },
		async set(k: string, v: unknown) { vaultDisk.raw.set(k, v); },
		async remove(k: string) { vaultDisk.raw.delete(k); },
	}),
}));
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));

const PK: { [R in Relation]: (r: RowOf[R]) => string } = {
	user_cards: (r) => r.user_hash,
	user_storage: (r) => `${r.user_hash}|${r.uuid}`,
	dialog_keys: (r) => `${r.dialog_hash}|${r.sender_hash}`,
	dialog_messages: (r) => r.message_id,
	dialog_messages_versions: (r) => `${r.message_id}|${r.sign_hash}`,
	dialog_message_reactions: (r) => r.reaction_hash,
	dialog_message_receipts: (r) => r.receipt_hash,
};
const server: LocalServer = {
	tables: new Map(),
	posts: [],
	hiddenFromShapes: new Set(),
	listeners: new Set(),
	table(relation) {
		if (!this.tables.has(relation)) this.tables.set(relation, new Map());
		return this.tables.get(relation) as never;
	},
	apply(relation, type, row) {
		const table = this.table(relation);
		const key = PK[relation](row as never);
		const stored = table.get(key);
		let result: ApplyResult;
		if (type === 'insert' && stored) {
			result = { status: 'exists', conflicted: stored.sign_b64 !== row.sign_b64 };
		} else if (type === 'update' && stored && Number(row.owner_timestamp) <= Number(stored.owner_timestamp)) {
			result = { status: 'error', error: 'validation_failed', details: { owner_timestamp: ['timestamp not newer'] } };
		} else {
			if (relation === 'dialog_messages' && stored) this.table('dialog_messages_versions').set(PK.dialog_messages_versions(stored as DialogMessageVersionRow), stored as DialogMessageVersionRow);
			table.set(key, row);
			result = { status: 'ok', txid: this.posts.length + 1 };
		}
		this.posts.push({ relation, row, result });
		if (result.status === 'ok' && !this.hiddenFromShapes.has(relation)) for (const l of this.listeners) l(relation, row);
		return result;
	},
	fetch: vi.fn(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
		const url = String(input);
		if (server.offline) throw new TypeError('Failed to fetch');
		if (url.endsWith('/challenge')) return Response.json({ challenge: 'c', challenge_id: 'id' });
		if (!url.endsWith('/ingest_each')) throw new TypeError(`unexpected request ${url}`);
		const { mutations } = JSON.parse(init!.body as string);
		const results = mutations.map((m: MutationBody, index: number) => ({ index, ...server.apply(m.syncMetadata.relation, m.type, m.modified ?? m.changes) }));
		return Response.json({ results }, { status: 200 });
	}),
	visibleRows(relation) {
		return [...this.table(relation).values()].filter((r) => !this.hiddenFromShapes.has(relation) || this.shapeSeen.has(`${relation}:${PK[relation](r as never)}`));
	},
	shapeSeen: new Set(),
};

const view = (relation: Relation, scope: (r: Row) => boolean = () => true) => {
	const listeners = new Set<(changes: ViewChange[]) => void>();
	server.listeners.add((rel, row) => { if (rel === relation && scope(row)) for (const cb of listeners) cb([{ type: 'insert', key: PK[relation](row as never), value: row }]); });
	return {
		async preload() {},
		get(key: string) {
			const row = server.table(relation).get(key);
			return row && scope(row) && !server.hiddenFromShapes.has(relation) ? row : undefined;
		},
		get toArray() { return server.hiddenFromShapes.has(relation) ? [] : [...server.table(relation).values()].filter(scope); },
		subscribeChanges(cb: (changes: ViewChange[]) => void) { listeners.add(cb); return { unsubscribe: () => listeners.delete(cb) }; },
		get status() { return 'ready'; },
	};
};
let views: { cards: LocalView; storage: Map<string, LocalView>; dialog: (dialogHash: string) => LocalDialogViews };
const freshViews = () => {
	server.listeners = new Set();
	const dialogViews = new Map<string, LocalDialogViews>();
	views = {
		cards: view('user_cards'),
		storage: new Map(),
		dialog: (dialogHash: string) => {
			if (!dialogViews.has(dialogHash)) {
				const inDialog = (r: Row) => r.dialog_hash === dialogHash;
				dialogViews.set(dialogHash, {
					keys: view('dialog_keys', inDialog), messages: view('dialog_messages', inDialog),
					versions: view('dialog_messages_versions', inDialog), reactions: view('dialog_message_reactions', inDialog),
					receipts: view('dialog_message_receipts', inDialog),
				});
			}
			return dialogViews.get(dialogHash)!;
		},
	};
};
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => views.cards,
	getUserStorageCollection: (userHash: string) => {
		if (!views.storage.has(userHash)) views.storage.set(userHash, view('user_storage', (r: Row) => r.user_hash === userHash));
		return views.storage.get(userHash);
	},
	resetUserStorageCollection: () => {},
	getDialogCollections: (dialogHash: string) => views.dialog(dialogHash),
	withDialogCollections: async (dialogHash: string, read: (dialogViews: LocalDialogViews) => unknown) => read(views.dialog(dialogHash)),
	isDialogWarm: () => true,
	releaseDialogCollections: () => {},
}));

const ROUTE = vi.hoisted(() => ({ peer: '' }));
vi.mock('vue-router', () => ({
	useRoute: () => ({ params: { get address() { return ROUTE.peer; } }, query: {} }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

let app: LocalApp | null = null;
const startApp = async () => {
	vi.resetModules();
	freshViews();
	const outbox = await import('@/lib/data/outbox');
	outbox._setLeaderForTests(true);
	const { userPQStore } = await import('@/store/userPQ.store');
	setActivePinia(createPinia());
	const store = userPQStore();
	await store.initialize();
	const { useDialogsStore } = await import('@/store/dialogs.store');
	const $dialogs = useDialogsStore();
	const attempts: Promise<unknown>[] = [];
	const original = $dialogs.sendDeliveredReceipt;
	$dialogs.sendDeliveredReceipt = (...args) => { const p = original(...args); attempts.push(p); return p; };
	app = { store, $dialogs, outbox, attempts, wrapper: null };
	return app;
};
const openChat = async (): Promise<VueWrapper> => {
	ROUTE.peer = PEER.userHash;
	const PageChat = (await import('@/views/chats/Page_Chat.vue')).default;
	app!.wrapper = mount(PageChat, {
		global: {
			provide: { $swal: { fire: async () => ({}) } },
			stubs: { Avatar: true, TransferPanel: true, FileStateModal: true, EditHistoryModal: true, CheckpointDiffModal: true },
		},
	});
	return app!.wrapper!;
};
const closeChat = () => { app?.wrapper?.unmount(); if (app) app.wrapper = null; };
const receiptsSettled = async (count: number) => {
	await vi.waitFor(() => expect(app!.attempts.length).toBeGreaterThanOrEqual(count), { timeout: 15_000 });
	await Promise.all(app!.attempts);
};

const peerSends = async (dialogHash: string, texts: string[], firstTail: DialogMessageRow) => {
	const key = DialogCrypto.deriveSenderMsgKey(PEER.sign.secretKey, PEER.kem.secretKey, bytesToHex(PEER.contactSk), app!.store.currentUserHash as unknown as string);
	const myCard = server.table('user_cards').get(app!.store.currentUserHash as unknown as string)!;
	const myKemPk = Uint8Array.from(atob(myCard.crypt_pkey!.padEnd(Math.ceil(myCard.crypt_pkey!.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
	const wrapped = await DialogCrypto.wrapSenderMsgKey(key, myKemPk);
	const keyRow = {
		dialog_hash: dialogHash, sender_hash: PEER.userHash, peer_hash: app!.store.currentUserHash,
		peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64, peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
		deleted_flag: false, owner_timestamp: 1_700_000_100,
	} as DialogKeyRow;
	keyRow.sign_b64 = signFields(keyRow as never, PEER.sign.secretKey);
	server.apply('dialog_keys', 'insert', keyRow);
	let tail = firstTail;
	const sent: DialogMessageRow[] = [];
	for (const [i, text] of texts.entries()) {
		const fields = {
			message_id: `dmsg_${String(i + 1).repeat(8)}-0000-7000-8000-00000000000${i}`, dialog_hash: dialogHash, sender_hash: PEER.userHash,
			content_b64: await DialogCrypto.encryptContent(key, encodeContent([{ kind: 'text', text }])),
			deleted_flag: false, refs_map_b64: await DialogCrypto.encryptContent(key, JSON.stringify({ [tail.message_id]: tail.sign_hash })),
			parent_sign_hash: null, owner_timestamp: Math.floor(Date.now() / 1000) + 10 + i,
		};
		const sign_b64 = signFields(fields, PEER.sign.secretKey);
		const row = { ...fields, sign_b64, sign_hash: deriveSignHash('dms_', sign_b64) } as unknown as DialogMessageRow;
		server.apply('dialog_messages', 'insert', row);
		sent.push(row);
		tail = row;
	}
	return sent;
};

const receiptPosts = () => server.posts.filter((p) => p.relation === 'dialog_message_receipts') as (ServerPost & { row: DialogMessageReceiptRow })[];
const conflictedPosts = () => server.posts.filter((p) => p.result.status === 'exists' && p.result.conflicted);
const expectOneSnapshotPerReceipt = () => {
	const byHash = new Map<string, Set<string>>();
	for (const p of receiptPosts()) {
		if (!byHash.has(p.row.receipt_hash)) byHash.set(p.row.receipt_hash, new Set());
		byHash.get(p.row.receipt_hash)!.add(`${p.row.owner_timestamp}|${p.row.sign_b64}`);
	}
	for (const [hash, snapshots] of byHash) expect(snapshots.size, `receipt ${hash.slice(0, 16)}… posted with ${snapshots.size} different signed snapshots`).toBe(1);
};
const expectVerifiedFeed = (wrapper: VueWrapper, texts: string[]) => {
	for (const t of texts) expect(wrapper.text()).toContain(t);
	expect(wrapper.text()).not.toContain('Message failed verification');
	expect(wrapper.text()).not.toContain('waiting for earlier messages');
};
const quarantined = async () => (await app!.outbox.quarantinedEntries(app!.store.currentUserHash as unknown as string));

beforeEach(() => {
	vaultDisk = { vaults: new Map(), raw: new Map() };
	server.tables = new Map();
	server.posts = [];
	server.hiddenFromShapes = new Set();
	server.shapeSeen = new Set();
	server.offline = false;
	server.table('user_cards').set(PEER.userHash, PEER.card);
	vi.stubGlobal('fetch', server.fetch);
});
afterEach(async () => {
	closeChat();
	app?.outbox.stopLeaderElection();
	app = null;
	vi.unstubAllGlobals();
	globalThis.indexedDB = new IDBFactory();
});

const TEXTS = ['peer one', 'peer two', 'peer three'];

const freshAccountOpensDialog = async () => {
	const { store, $dialogs } = await startApp();
	await store.registerNewUser({ name: 'Fresh' } as never);
	expect(store.isAuthenticated).toBe(true);
	const me = store.currentUserHash as unknown as string;

	const statuses: string[] = [];
	const myMessageId = await $dialogs.sendMessage(PEER.userHash, 'hello from the new account', (s: string) => statuses.push(s)) as unknown as string;
	await vi.waitFor(() => expect(statuses).toContain('synced'), { timeout: 15_000 });
	const dialogHash = $dialogs.getDialogHash(PEER.userHash) as string;
	const myMessage = server.table('dialog_messages').get(myMessageId)!;

	const peerRows = await peerSends(dialogHash, TEXTS, myMessage);
	const wrapper = await openChat();
	await vi.waitFor(() => expectVerifiedFeed(wrapper, ['hello from the new account', ...TEXTS]), { timeout: 15_000 });
	await receiptsSettled(TEXTS.length);
	return { me, dialogHash, peerRows };
};

describe('fresh account: the card published before login', () => {
	it('records the accepted own card once the account is unlocked, without a failed pre-login reconciliation', async () => {
		const warn = vi.spyOn(console, 'warn');
		const { store } = await startApp();
		await store.registerNewUser({ name: 'Fresh' } as never);
		const me = store.currentUserHash as unknown as string;

		const { getAccepted } = await import('@/lib/data/acceptedSnapshot');
		const accepted = await getAccepted('user_cards', me, me);
		expect(accepted?.sign_b64).toBe(server.table('user_cards').get(me)!.sign_b64);
		const messages = warn.mock.calls.map((c) => String(c[0]));
		expect(messages.filter((m) => m.includes('local reconciliation pending'))).toEqual([]);
		expect(messages.filter((m) => m.includes('could not record accepted card snapshot'))).toEqual([]);
		warn.mockRestore();
	}, 60_000);
});

describe('fresh account: dialog open, delivered receipts, remount and reload', () => {
	it('every message verifies and every delivered receipt is posted once, with one signed snapshot', async () => {
		const { peerRows } = await freshAccountOpensDialog();

		expect(new Set(receiptPosts().map((p) => p.row.receipt_hash)).size).toBe(peerRows.length);
		expect(conflictedPosts()).toEqual([]);
		expectOneSnapshotPerReceipt();
		expect(await quarantined()).toEqual([]);
		expect(await app!.outbox.pendingEntries(app!.store.currentUserHash as unknown as string)).toEqual([]);
	}, 90_000);

	it('remount and reload + sign-in open the dialog again without a new signed receipt row', async () => {
		const { me } = await freshAccountOpensDialog();
		const postsBefore = receiptPosts().length;

		closeChat();
		app!.attempts.length = 0;
		let wrapper = await openChat();
		await vi.waitFor(() => expectVerifiedFeed(wrapper, TEXTS), { timeout: 15_000 });
		await receiptsSettled(TEXTS.length);

		closeChat();
		await startApp();
		await app!.store.logout();
		await app!.store.login(me);
		wrapper = await openChat();
		await vi.waitFor(() => expectVerifiedFeed(wrapper, TEXTS), { timeout: 15_000 });
		await receiptsSettled(TEXTS.length);

		expect(receiptPosts().length).toBe(postsBefore);
		expect(conflictedPosts()).toEqual([]);
		expectOneSnapshotPerReceipt();
		expect(await quarantined()).toEqual([]);
	}, 120_000);

	it('with the receipt shape invisible, remount and reload still add no signed receipt row', async () => {
		server.hiddenFromShapes.add('dialog_message_receipts');
		const { me } = await freshAccountOpensDialog();
		const postsBefore = receiptPosts().length;

		closeChat();
		app!.attempts.length = 0;
		await openChat();
		await receiptsSettled(TEXTS.length);
		closeChat();
		await startApp();
		await app!.store.logout();
		await app!.store.login(me);
		await openChat();
		await receiptsSettled(TEXTS.length);

		expect(receiptPosts().length).toBe(postsBefore);
		expect(conflictedPosts()).toEqual([]);
		expectOneSnapshotPerReceipt();
		expect(await quarantined()).toEqual([]);
	}, 120_000);
});

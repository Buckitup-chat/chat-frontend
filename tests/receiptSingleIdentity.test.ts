// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { bytesToHex } from '@noble/hashes/utils';
import { fromBase64 } from '@/lib/pq/signature';
import { makeTestIdentity, signRow, signedDialogKeyRow } from './helpers/signedFixtures';
import { encodeContent } from '@/lib/pq/content';
import { DialogCrypto } from '@/libs/DialogCrypto';
import type { DialogMessageReceiptRow } from '@/lib/data/types';
import type { StringStore } from '@/lib/data/secureStore';
import type { App, ApplyResult } from './helpers/twoClients';

type TestApp = Omit<App, 'store'> & { attempts: Promise<unknown>[] };
type HeldUser = { currentUserHash: string; contacts: unknown[]; getUserByHash: () => null };
type ChangesListener = (changes: unknown[]) => void;
type Mutation = { modified?: DialogMessageReceiptRow; changes: DialogMessageReceiptRow; syncMetadata?: { relation?: string } };

const ME = makeTestIdentity(50);
const PEER = makeTestIdentity(51);
const DIALOG = DialogCrypto.computeDialogHash(ME.userHash, PEER.userHash);
const PEER_KEY = DialogCrypto.deriveSenderMsgKey(PEER.signSkey, PEER.kemSkey, bytesToHex(PEER.contactSk), ME.userHash);

const signedMessage = async (id: string, text: string, tweak: Record<string, unknown> = {}) => {
	const fields = {
		message_id: id, dialog_hash: DIALOG, sender_hash: PEER.userHash,
		content_b64: await DialogCrypto.encryptContent(PEER_KEY, encodeContent([{ kind: 'text', text }])),
		deleted_flag: false, refs_map_b64: await DialogCrypto.encryptContent(PEER_KEY, JSON.stringify({})),
		parent_sign_hash: null, owner_timestamp: 1_700_000_500, ...tweak,
	};
	return signRow(PEER, fields, 'dms_') as typeof fields & { sign_b64: string; sign_hash: string };
};
const MSG_ID = 'dmsg_' + 'a'.repeat(8) + '-0000-7000-8000-000000000000';

const liveCollection = (rows: Record<string, unknown> = {}) => ({
	rows: new Map(Object.entries(rows)),
	listeners: new Set<ChangesListener>(),
	async preload() {},
	get(k: string) { return this.rows.get(k); },
	get toArray() { return [...this.rows.values()]; },
	subscribeChanges(cb: ChangesListener) { this.listeners.add(cb); return { unsubscribe: () => this.listeners.delete(cb) }; },
	emit() { for (const cb of this.listeners) cb([]); },
});
let collections: { cards: ReturnType<typeof liveCollection>; dialog: Record<string, ReturnType<typeof liveCollection>> };
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => collections.cards,
	getDialogCollections: () => collections.dialog,
	withDialogCollections: async (_h: string, read: (dialog: typeof collections.dialog) => unknown) => read(collections.dialog),
}));

const HOLDER = vi.hoisted(() => ({ user: null as HeldUser | null }));
vi.mock('@/store/userPQ.store', async () => {
	const { reactive } = await import('vue');
	HOLDER.user = reactive({ currentUserHash: '', contacts: [], getUserByHash: () => null });
	return { userPQStore: () => HOLDER.user };
});
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => ({ exportVaultKeys: async () => ME.vault, get currentUserHash() { return ME.userHash; } }) },
}));
vi.mock('vue-router', () => ({
	useRoute: () => ({ params: { address: PEER.userHash }, query: {} }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const server = {
	rows: new Map<string, DialogMessageReceiptRow>(),
	posts: [] as DialogMessageReceiptRow[],
	loseNextResponse: false,
	offline: false,
	reject: null as ((row: DialogMessageReceiptRow) => ApplyResult | null) | null,
	fetch: vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = String(input);
		if (server.offline) throw new TypeError('Failed to fetch');
		if (url.endsWith('/challenge')) return Response.json({ challenge: 'c', challenge_id: 'id' });
		if (!url.endsWith('/ingest_each')) throw new TypeError(`unexpected request ${url}`);
		const { mutations }: { mutations: Mutation[] } = JSON.parse(init!.body as string);
		const results = mutations.map((m, index): ApplyResult & { index: number } => {
			const row = m.modified ?? m.changes;
			if (m.syncMetadata?.relation !== 'dialog_message_receipts') return { index, status: 'ok', txid: 1 };
			server.posts.push(row);
			const rejection = server.reject?.(row);
			if (rejection) return { index, ...rejection };
			const stored = server.rows.get(row.receipt_hash);
			if (!stored) {
				server.rows.set(row.receipt_hash, row);
				return { index, status: 'ok', txid: server.posts.length };
			}
			return { index, status: 'exists', conflicted: stored.sign_b64 !== row.sign_b64 };
		});
		if (server.loseNextResponse) {
			server.loseNextResponse = false;
			throw new TypeError('connection reset');
		}
		const status = results.some((r) => r.status === 'error' && r.permanent422) ? 422 : 200;
		return Response.json({ results }, { status });
	}),
};

const memoryStore = (): StringStore & { map: Map<string, string> } => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k) { return map.get(k) ?? null; },
		async set(k, v) { map.set(k, v); },
		async delete(k) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};
let disk: Record<string, StringStore>;

let app: TestApp = null as never;
const startApp = async () => {
	app?.outbox?.stopDrainLoop();
	app?.outbox?.stopLeaderElection();
	vi.resetModules();
	(await import('@/lib/data/localStore'))._setStoreForTests(disk.localStore);
	(await import('@/lib/data/intents'))._setIntentStorageForTests(disk.intents);
	(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(disk.accepted);
	(await import('@/lib/data/ownObservedTails'))._setOwnObservedTailsStorageForTests(disk.tails);
	const outbox = await import('@/lib/data/outbox');
	outbox._setStorageForTests(disk.outbox);
	outbox.stopLeaderElection();
	outbox.startLeaderElection(ME.userHash, () => {});
	outbox._setLeaderForTests(true);
	(await import('@/lib/data/cardRegistry')).resetCardRegistry();
	await import('@/store/userPQ.store');
	HOLDER.user!.currentUserHash = ME.userHash;
	setActivePinia(createPinia());
	const { useDialogsStore } = await import('@/store/dialogs.store');
	const $dialogs = useDialogsStore();
	const attempts: Promise<unknown>[] = [];
	const original = $dialogs.sendDeliveredReceipt;
	$dialogs.sendDeliveredReceipt = (...args) => {
		const p = original(...args);
		attempts.push(p);
		return p;
	};
	app = { $dialogs, attempts, outbox, wrapper: null };
	return app;
};
const openChat = async () => {
	const PageChat = (await import('@/views/chats/Page_Chat.vue')).default;
	app.wrapper = mount(PageChat, {
		global: {
			provide: { $swal: { fire: async () => ({}) } },
			stubs: { Avatar: true, TransferPanel: true, FileStateModal: true, EditHistoryModal: true, CheckpointDiffModal: true },
		},
	});
	return app.wrapper;
};
const settleAttempts = async (count: number) => {
	await vi.waitFor(() => expect(app.attempts.length).toBeGreaterThanOrEqual(count), { timeout: 8000 });
	await Promise.all(app.attempts);
};
const closeChat = () => {
	app?.wrapper?.unmount();
	if (app) app.wrapper = null;
};
const rebuildProjection = async () => {
	closeChat();
	const before = app.attempts.length;
	await openChat();
	await settleAttempts(before + 1);
};

const receiptEntries = async (outbox: TestApp['outbox']) => {
	const all = [...(await outbox.pendingEntries(ME.userHash)), ...(await outbox.quarantinedEntries(ME.userHash))];
	return all.filter((e) => e.relation === 'dialog_message_receipts');
};
const unresolvedReceiptIntents = async () => {
	const { intentsOf } = await import('@/lib/data/intents');
	return (await intentsOf(ME.userHash)).entries.filter((e) => e.relation === 'dialog_message_receipts');
};
const expectOneSignedSnapshot = (receiptHash: string) => {
	const posted = server.posts.filter((r) => r.receipt_hash === receiptHash);
	expect(posted.length).toBeGreaterThan(0);
	expect(new Set(posted.map((r) => r.sign_b64)).size).toBe(1);
	expect(new Set(posted.map((r) => r.owner_timestamp)).size).toBe(1);
};

let message: Awaited<ReturnType<typeof signedMessage>>;
beforeEach(async () => {
	disk = {
		localStore: memoryStore(), intents: memoryStore(), accepted: memoryStore(),
		tails: memoryStore(), outbox: memoryStore(),
	};
	server.rows = new Map();
	server.posts = [];
	server.loseNextResponse = false;
	server.offline = false;
	server.reject = null;
	vi.stubGlobal('fetch', server.fetch);

	message = await signedMessage(MSG_ID, 'hello');
	const wrapped = await DialogCrypto.wrapSenderMsgKey(PEER_KEY, fromBase64(ME.card.crypt_pkey as string));
	collections = {
		cards: liveCollection({ [ME.userHash]: ME.card, [PEER.userHash]: PEER.card }),
		dialog: {
			keys: liveCollection({
				[`${DIALOG}|${PEER.userHash}`]: signedDialogKeyRow(PEER, {
					dialog_hash: DIALOG, peer_hash: ME.userHash,
					peer_kem_wrap_key_b64: wrapped.peerKemWrapKeyB64, peer_wrapped_msg_key_b64: wrapped.peerWrappedMsgKeyB64,
					owner_timestamp: 999,
				}),
				[`${DIALOG}|${ME.userHash}`]: signedDialogKeyRow(ME, { dialog_hash: DIALOG, peer_hash: PEER.userHash, owner_timestamp: 998 }),
			}),
			messages: liveCollection({ [MSG_ID]: message }),
			versions: liveCollection(),
			reactions: liveCollection(),
			receipts: liveCollection(),
		},
	};
});
afterEach(async () => {
	closeChat();
	app?.outbox.stopDrainLoop();
	app?.outbox.stopLeaderElection();
	app = null as never;
	vi.unstubAllGlobals();
});

const deliveredHash = (msg = message) => DialogCrypto.computeReceiptHash(msg.message_id, msg.sign_hash, ME.userHash, 'delivered');
const readHash = (msg = message) => DialogCrypto.computeReceiptHash(msg.message_id, msg.sign_hash, ME.userHash, 'read');

describe('automatic delivered receipt: one logical identity, one signed snapshot', () => {
	it('rebuilds, remounts and a reload while the receipt shape stays invisible never mint a second row', async () => {
		await startApp();
		const wrapper = await openChat();
		await vi.waitFor(() => expect(wrapper.text()).toContain('hello'), { timeout: 8000 });
		await settleAttempts(1);
		expect(server.rows.has(deliveredHash())).toBe(true);

		for (let i = 0; i < 3; i++) await rebuildProjection();
		closeChat();
		await startApp();
		await openChat();
		await settleAttempts(1);

		expectOneSignedSnapshot(deliveredHash());
		expect(server.posts.filter((r) => r.receipt_hash === deliveredHash())).toHaveLength(1);
		expect(await app.outbox.quarantinedEntries(ME.userHash)).toEqual([]);
		expect((await receiptEntries(app.outbox)).length).toBeLessThanOrEqual(1);
		expect((await unresolvedReceiptIntents()).length).toBeLessThanOrEqual(1);
	}, 120_000);

	it('an accepted receipt is recorded in the accepted snapshot, exactly as signed', async () => {
		await startApp();
		await openChat();
		await settleAttempts(1);

		const { getAccepted } = await import('@/lib/data/acceptedSnapshot');
		const accepted = await getAccepted('dialog_message_receipts', deliveredHash(), ME.userHash);
		expect(accepted).not.toBeNull();
		expect(accepted!.sign_b64).toBe(server.rows.get(deliveredHash())!.sign_b64);
		expect(accepted!.owner_timestamp).toBe(server.rows.get(deliveredHash())!.owner_timestamp);
	}, 30_000);

	it('two concurrent sends before the shape shows anything coalesce into one operation', async () => {
		const { $dialogs } = await startApp();
		const ref = { messageId: MSG_ID, messageSignHash: message.sign_hash };

		await Promise.all([$dialogs.sendDeliveredReceipt(PEER.userHash, ref), $dialogs.sendDeliveredReceipt(PEER.userHash, ref)]);

		expectOneSignedSnapshot(deliveredHash());
		expect(server.rows.size).toBe(1);
		expect(await app.outbox.quarantinedEntries(ME.userHash)).toEqual([]);
	}, 30_000);

	it('a lost HTTP response is replayed with the exact same signed bytes, and a rebuild meanwhile adds nothing', async () => {
		server.loseNextResponse = true;
		await startApp();
		await openChat();
		await settleAttempts(1);

		await rebuildProjection();
		const { drainPendingWrites } = await import('@/lib/data/ingest');
		await drainPendingWrites(ME.userHash, ME.signSkey);

		expectOneSignedSnapshot(deliveredHash());
		expect(server.rows.size).toBe(1);
		expect(await app.outbox.quarantinedEntries(ME.userHash)).toEqual([]);
	}, 120_000);

	it('offline open → reload → reconnect: the durable receipt goes out once, as the exact snapshot', async () => {
		server.offline = true;
		await startApp();
		await openChat();
		await settleAttempts(1);
		closeChat();

		await startApp();
		await openChat();
		await settleAttempts(1);

		server.offline = false;
		const { resumePendingWrites } = await import('@/lib/data/ingest');
		resumePendingWrites(ME.userHash, ME.signSkey);
		await rebuildProjection();

		expectOneSignedSnapshot(deliveredHash());
		expect(server.rows.size).toBe(1);
		expect(await app.outbox.quarantinedEntries(ME.userHash)).toEqual([]);
		expect((await unresolvedReceiptIntents()).length).toBeLessThanOrEqual(1);
	}, 120_000);
});

describe('receipt identities stay distinct where they should', () => {
	it('read and delivered for the same revision are two identities; an edit gets a receipt for its new revision', async () => {
		const { $dialogs } = await startApp();
		const ref = { messageId: MSG_ID, messageSignHash: message.sign_hash };
		await $dialogs.sendDeliveredReceipt(PEER.userHash, ref);
		await $dialogs.sendReadReceipt(PEER.userHash, ref);

		const edited = await signedMessage(MSG_ID, 'hello, edited', {
			parent_sign_hash: message.sign_hash, owner_timestamp: 1_700_000_900,
			refs_map_b64: await DialogCrypto.encryptContent(PEER_KEY, JSON.stringify({ [MSG_ID]: message.sign_hash })),
		});
		await $dialogs.sendDeliveredReceipt(PEER.userHash, { messageId: MSG_ID, messageSignHash: edited.sign_hash });

		expect([...server.rows.keys()].sort()).toEqual([deliveredHash(), readHash(), deliveredHash(edited)].sort());
		expect(server.rows.get(deliveredHash())!.type).toBe('delivered');
		expect(server.rows.get(readHash())!.type).toBe('read');
		expect(server.rows.get(deliveredHash(edited))!.message_sign_hash).toBe(edited.sign_hash);
		expect(await app.outbox.quarantinedEntries(ME.userHash)).toEqual([]);
	}, 30_000);

	it('merely opening the dialog never produces a read receipt', async () => {
		await startApp();
		await openChat();
		await settleAttempts(1);

		expect(server.posts.some((r) => r.type === 'read')).toBe(false);
	}, 30_000);

	it('a genuine permanent rejection stays visible (quarantined) and is not re-minted by later rebuilds', async () => {
		server.reject = () => ({ status: 'error', error: 'validation_failed', details: { type: ['is invalid'] }, permanent422: true });
		await startApp();
		await openChat();
		await settleAttempts(1);

		await rebuildProjection();

		const quarantined = (await app.outbox.quarantinedEntries(ME.userHash)).filter((e) => e.relation === 'dialog_message_receipts');
		expect(quarantined).toHaveLength(1);
		expectOneSignedSnapshot(deliveredHash());
	}, 30_000);
});

// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as harness from './helpers/twoClients';
import type { Client, NetMode, Relation, Row, RowOf } from './helpers/twoClients';

type DialogRelation = Exclude<Relation, 'user_cards' | 'user_storage'>;

const { server, net, goOnline, register, startApp, signIn, openChat, closeChat, stopAll, feedOf, expectVerifiedFeed, newClient } = harness;

vi.mock('@lo-fi/local-vault', async () => (await import('./helpers/twoClients')).vaultModule);
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));
vi.mock('vue-router', async () => {
	const { route } = await import('./helpers/twoClients');
	return {
		useRoute: () => ({ params: { get address() { return route.peer; } }, query: {} }),
		useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	};
});

let A: Client;
let B: Client;
beforeEach(() => {
	server.reset();
	net.mode = 'online';
	A = newClient('Alice');
	B = newClient('Bob');
});
afterEach(() => stopAll());

const TEXTS = ['M1 first', 'M2 second', 'M3 after both', 'M4 reply (edited)'];
const sent = (statuses: string[]) => vi.waitFor(() => expect(statuses).toContain('synced'), { timeout: 15_000 });

const buildHistory = async () => {
	await register(B);
	await register(A);
	const d = A.app.$dialogs;
	const m1 = await d.captureMessageIntent(B.hash, TEXTS[0]);
	const m2 = await d.captureMessageIntent(B.hash, TEXTS[1]);
	const s1: string[] = []; const s2: string[] = []; const s3: string[] = [];
	await Promise.all([
		d.dispatchMessageIntent(m1.intentId, m1.payload, m1.token, (s: string) => s1.push(s)),
		d.dispatchMessageIntent(m2.intentId, m2.payload, m2.token, (s: string) => s2.push(s)),
	]);
	await d.sendMessage(B.hash, TEXTS[2], (s: string) => s3.push(s));
	await Promise.all([sent(s1), sent(s2), sent(s3)]);

	await startApp(B);
	await signIn(B);
	const wB = await openChat(B, A);
	await vi.waitFor(() => expectVerifiedFeed(wB, TEXTS.slice(0, 3)), { timeout: 15_000 });
	const s4: string[] = [];
	const m4 = await B.app.$dialogs.sendMessage(A.hash, 'M4 reply', (s: string) => s4.push(s));
	await sent(s4);
	await vi.waitFor(() => expectVerifiedFeed(wB, [...TEXTS.slice(0, 3), 'M4 reply']), { timeout: 15_000 });
	await B.app.$dialogs.editMessage(A.hash, m4, TEXTS[3]);
	await vi.waitFor(() => expectVerifiedFeed(wB, TEXTS), { timeout: 15_000 });
	const onlineFeed = feedOf(wB).map((e) => e.id);
	return { wB, onlineFeed };
};

const diskOfActiveProfile = async (dialogHash: string) => {
	const { readDialogRows } = await import('@/lib/data/dialogCache');
	const { readCachedCards } = await import('@/lib/data/userCardsCache');
	return {
		messages: (await readDialogRows('dialog_messages', dialogHash)).map((r) => r.message_id),
		keys: (await readDialogRows('dialog_keys', dialogHash)).map((r) => r.sender_hash),
		versions: (await readDialogRows('dialog_messages_versions', dialogHash)).length,
		cards: (await readCachedCards()).map((c) => c.user_hash),
	};
};

describe.each<NetMode>(['offline', 'offline-warm', 'error-ready'])('offline reload of a seen dialog (%s)', (mode) => {
	it('shows the verified history from disk, then the live set takes over unchanged', async () => {
		const { onlineFeed } = await buildHistory();
		const messageIds = [...server.table('dialog_messages').keys()];

		const dialogHash = B.app.$dialogs.getDialogHash(A.hash) as string;
		await vi.waitFor(async () => {
			const disk = await diskOfActiveProfile(dialogHash);
			expect(disk.messages.sort()).toEqual([...messageIds].sort());
			expect(disk.keys.sort()).toEqual([A.hash, B.hash].sort());
			expect(disk.versions).toBeGreaterThanOrEqual(1);
			expect(disk.cards).toEqual(expect.arrayContaining([A.hash, B.hash]));
		}, { timeout: 15_000 });
		closeChat(B);

		net.mode = mode;
		await startApp(B);
		await signIn(B);
		const w = await openChat(B, A);
		await vi.waitFor(() => expectVerifiedFeed(w, TEXTS), { timeout: 15_000 });
		expect(feedOf(w).map((e) => e.id)).toEqual(onlineFeed);

		goOnline();
		await vi.waitFor(() => expect(w.findAll('.message-bubble')).toHaveLength(TEXTS.length), { timeout: 15_000 });
		expectVerifiedFeed(w, TEXTS);
		expect(feedOf(w).map((e) => e.id)).toEqual(onlineFeed);
	}, 180_000);
});

describe('reconnect delivery: offline send in a running session, then reconnect', () => {
	it('the message is durably held with a truthful status offline, and reaches the server exactly once after reconnect', async () => {
		await buildHistory();
		closeChat(B);
		net.mode = 'offline';
		await startApp(B);
		await signIn(B);
		const w = await openChat(B, A);
		await vi.waitFor(() => expectVerifiedFeed(w, TEXTS), { timeout: 15_000 });

		const statuses: string[] = [];
		const id = await B.app.$dialogs.sendMessage(A.hash, 'M5 written offline', (s: string) => statuses.push(s)) as unknown as string;
		await vi.waitFor(() => expect(statuses.some((s: string) => s === 'queued' || s === 'awaiting_recovery')).toBe(true), { timeout: 45_000 });
		expect(statuses).not.toContain('error');
		expect(server.table('dialog_messages').has(id)).toBe(false);

		goOnline();
		window.dispatchEvent(new Event('online'));
		await vi.waitFor(() => expect(server.table('dialog_messages').has(id)).toBe(true), { timeout: 30_000 });
		expect(server.posts.filter((p) => p.relation === 'dialog_messages' && p.row.message_id === id && p.result.status === 'ok')).toHaveLength(1);
	}, 180_000);
});

const MAIN_DIALOG_TABLES: DialogRelation[] = ['dialog_keys', 'dialog_messages', 'dialog_messages_versions', 'dialog_message_reactions', 'dialog_message_receipts'];
const mainKey: { [R in DialogRelation]: (r: RowOf[R]) => string } = {
	dialog_keys: (r) => `${r.dialog_hash}:${r.sender_hash}`,
	dialog_messages: (r) => r.message_id,
	dialog_messages_versions: (r) => `${r.message_id}:${r.sign_hash}`,
	dialog_message_reactions: (r) => r.reaction_hash,
	dialog_message_receipts: (r) => r.receipt_hash,
};
const clearReadCacheDb = async () => {
	const { IndexedDBAdapter } = await import('@tanstack/offline-transactions');
	const adapter: { clear(): Promise<void>; db: IDBDatabase | null } = new IndexedDBAdapter('buckitup-read-cache') as never;
	await adapter.clear();
	adapter.db?.close();
};
const writeDialogCacheAsMain = (rowsByTable: Record<string, Row[]>) => new Promise<void>((resolve, reject) => {
	const req = indexedDB.open('dialog-synced-cache', 2);
	req.onupgradeneeded = () => {
		for (const t of MAIN_DIALOG_TABLES) if (!req.result.objectStoreNames.contains(t)) req.result.createObjectStore(t, { keyPath: '__key' });
	};
	req.onerror = () => reject(req.error);
	req.onsuccess = () => {
		const db = req.result;
		const tx = db.transaction(MAIN_DIALOG_TABLES, 'readwrite');
		for (const t of MAIN_DIALOG_TABLES) tx.objectStore(t).clear();
		for (const [table, rows] of Object.entries(rowsByTable)) {
			for (const row of rows) {
				tx.objectStore(table).put({ ...row, __awaitingEcho: false, __ignoreEchoSignHash: undefined, __key: mainKey[table as DialogRelation](row as never) });
			}
		}
		tx.oncomplete = () => { db.close(); resolve(); };
		tx.onerror = () => reject(tx.error);
	};
});

describe('legacy compatibility: dialog history cached by main', () => {
	it('main\'s dialog-synced-cache v2 is read as-is offline: messages, keys, versions, reactions, receipts — all through admission', async () => {
		const { wB } = await buildHistory();
		const dialogHash = B.app.$dialogs.getDialogHash(A.hash) as string;
		const m3 = [...server.table('dialog_messages').values()].find((r) => r.message_id === feedOf(wB)[2].id)!;
		await B.app.$dialogs.toggleReaction(A.hash, { messageId: m3.message_id, messageSignHash: m3.sign_hash, emoji: '👍' });
		await B.app.$dialogs.sendReadReceipt(A.hash, { messageId: m3.message_id, messageSignHash: m3.sign_hash });
		await vi.waitFor(() => {
			const bubble = wB.find(`[data-msg-id="${m3.message_id}"]`);
			expect(bubble.text()).toContain('👍');
			expect(bubble.find('.sync-status.acknowledged').exists()).toBe(true);
		}, { timeout: 15_000 });
		closeChat(B);

		const inDialog = (t: DialogRelation) => [...server.table(t).values()].filter((r) => r.dialog_hash === dialogHash);
		const legacy = Object.fromEntries(MAIN_DIALOG_TABLES.map((t) => [t, inDialog(t)])) as { [R in DialogRelation]: RowOf[R][] };
		expect(legacy.dialog_messages_versions.length).toBeGreaterThanOrEqual(1);
		expect(legacy.dialog_message_reactions.length).toBe(1);
		expect(legacy.dialog_message_receipts.some((r) => r.type === 'read')).toBe(true);
		const forged = { ...legacy.dialog_messages[1], message_id: 'dmsg_ffffffff-0000-7000-8000-000000000000' };
		legacy.dialog_messages = [...legacy.dialog_messages, forged];
		await clearReadCacheDb();
		await writeDialogCacheAsMain(legacy);

		net.mode = 'offline';
		await startApp(B);
		await signIn(B);
		const w = await openChat(B, A);
		await vi.waitFor(() => {
			const feed = feedOf(w);
			expect(feed.filter((e) => e.id !== forged.message_id).map((e) => e.text)).toEqual(TEXTS);
			expect(feed.find((e) => e.id === forged.message_id)?.text).toBe('Message failed verification');
			expect(feed.filter((e) => e.waiting || e.blocked)).toEqual([]);
		}, { timeout: 15_000 });
		const bubble = w.find(`[data-msg-id="${m3.message_id}"]`);
		await vi.waitFor(() => {
			expect(bubble.text()).toContain('👍');
			expect(bubble.find('.sync-status.acknowledged').exists()).toBe(true);
			expect(w.find(`[data-msg-id="${feedOf(w)[3].id}"] .msg-edited`).text()).toContain('· 1');
		}, { timeout: 15_000 });
	}, 180_000);
});

describe('early stream failure: before the chat exists', () => {
	it('the stream fails during the mirror subscription, before mount — the cached history still shows, with no second error and no reconnect', async () => {
		await buildHistory();
		closeChat(B);
		net.mode = 'offline';
		await startApp(B);
		await signIn(B);

		const dialogHash = B.app.$dialogs.getDialogHash(A.hash) as string;
		const { getDialogCollections } = await import('@/lib/data/collections');
		const { shapeLinkOf } = await import('@/lib/data/shapeLink');
		const colls = getDialogCollections(dialogHash);
		const links = Object.values(colls).map((c) => shapeLinkOf(c));
		expect(links.every((l) => l?.hasFailed())).toBe(true);
		let laterErrors = 0;
		for (const l of links) l!.onStreamError(() => { laterErrors++; });

		const w = await openChat(B, A);
		await vi.waitFor(() => expectVerifiedFeed(w, TEXTS), { timeout: 15_000 });
		expect(net.mode).toBe('offline');
		expect(laterErrors).toBe(links.length);
	}, 180_000);
});

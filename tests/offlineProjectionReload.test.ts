// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DOMWrapper, VueWrapper } from '@vue/test-utils';
import * as harness from './helpers/twoClients';
import type { Client } from './helpers/twoClients';

const { server, net, goOnline, register, startApp, signIn, openChat, closeChat, stopAll, feedOf, newClient } = harness;

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

const HISTORY = ['H1 from A', 'H2 from B'];
const sent = (statuses: string[]) => vi.waitFor(() => expect(statuses).toContain('synced'), { timeout: 15_000 });

const onlineHistory = async () => {
	await register(B);
	await register(A);
	const s1: string[] = [];
	await A.app.$dialogs.sendMessage(B.hash, HISTORY[0], (s: string) => s1.push(s));
	await sent(s1);
	await startApp(B);
	await signIn(B);
	const w = await openChat(B, A);
	await vi.waitFor(() => expect(feedOf(w).map((e) => e.text)).toEqual([HISTORY[0]]), { timeout: 15_000 });
	const s2: string[] = [];
	await B.app.$dialogs.sendMessage(A.hash, HISTORY[1], (s: string) => s2.push(s));
	await sent(s2);
	await vi.waitFor(() => expect(feedOf(w).map((e) => e.text)).toEqual(HISTORY), { timeout: 15_000 });
	await vi.waitFor(async () => expect(await diskProjectionKeys()).toEqual([]), { timeout: 5_000 });
	return w;
};

const sendFromUi = (wrapper: VueWrapper, text: string) => wrapper.findComponent({ name: 'ChatWindow' }).vm.$emit('sendMessage', text);
const projectionOf = (text: string) => [...B.app.$dialogs.optimisticItems.values()].find((i) => i.type === 'message' && i.text === text);
const bubbleOf = (w: VueWrapper, text: string) => w.findAll('.message-bubble').find((b) => b.find('.message-text').text() === text);
const markerOf = (bubble: DOMWrapper<Element> | undefined) => bubble?.find('.message-time .sync-status');
const diskProjectionKeys = () => new Promise<string[]>((resolve, reject) => {
	const req = indexedDB.open('buckitup-message-projections');
	req.onerror = () => reject(req.error);
	req.onsuccess = () => {
		const db = req.result;
		if (!db.objectStoreNames.contains('transactions')) { db.close(); resolve([]); return; }
		const r = db.transaction('transactions').objectStore('transactions').getAllKeys();
		r.onsuccess = () => { db.close(); resolve(r.result.map(String).sort()); };
		r.onerror = () => { db.close(); reject(r.error); };
	};
});

const hardReload = async () => {
	closeChat(B);
	await startApp(B);
	await signIn(B);
	return openChat(B, A);
};

describe('MSG-04: offline Send → hard reload → reconnect', () => {
	it('M5/M6 survive the reload as local projections, go out once on reconnect, and are replaced once by their verified echo', async () => {
		let w = await onlineHistory();
		net.mode = 'offline';
		sendFromUi(w, 'M5 offline');
		sendFromUi(w, 'M6 offline');
		await vi.waitFor(() => {
			expect(projectionOf('M5 offline')?.status).toBe('queued');
			expect(projectionOf('M6 offline')?.status).toBe('queued');
		}, { timeout: 45_000 });
		const ids = [projectionOf('M5 offline').id, projectionOf('M6 offline').id];
		expect(ids.some((id) => server.table('dialog_messages').has(id))).toBe(false);
		const onDisk = ids.map((id) => `projection:${id}`).sort();
		expect(await diskProjectionKeys()).toEqual(onDisk);

		w = await hardReload();
		expect(await diskProjectionKeys()).toEqual(onDisk);
		const { projectionsOf } = await import('@/lib/data/messageProjections');
		expect((await projectionsOf(B.hash)).projections.map((p) => p.text)).toEqual(['M5 offline', 'M6 offline']);
		await vi.waitFor(() => {
			expect(feedOf(w).map((e) => e.text)).toEqual([...HISTORY, 'M5 offline', 'M6 offline']);
		}, { timeout: 15_000 });
		for (const t of ['M5 offline', 'M6 offline']) {
			expect(markerOf(bubbleOf(w, t))!.text()).not.toBe('✓');
			expect(feedOf(w).find((e) => e.text === t)!.id).toBe(ids[t === 'M5 offline' ? 0 : 1]);
		}

		server.hold('dialog_messages');
		goOnline();
		window.dispatchEvent(new Event('online'));
		await vi.waitFor(() => { for (const id of ids) expect(server.table('dialog_messages').has(id)).toBe(true); }, { timeout: 30_000 });
		await vi.waitFor(() => {
			for (const t of ['M5 offline', 'M6 offline']) expect(markerOf(bubbleOf(w, t))?.text()).toBe('✓');
		}, { timeout: 15_000 });
		expect(feedOf(w).map((e) => e.text)).toEqual([...HISTORY, 'M5 offline', 'M6 offline']);
		expect(await diskProjectionKeys()).toEqual(onDisk);

		server.release('dialog_messages');
		await vi.waitFor(() => {
			const feed = feedOf(w);
			expect(feed.map((e) => e.text)).toEqual([...HISTORY, 'M5 offline', 'M6 offline']);
			expect(new Set(feed.map((e) => e.id)).size).toBe(feed.length);
			expect(B.app.$dialogs.optimisticItems.size).toBe(0);
		}, { timeout: 15_000 });
		await vi.waitFor(async () => expect(await diskProjectionKeys()).toEqual([]), { timeout: 5_000 });
		for (const id of ids) {
			expect(server.posts.filter((p) => p.row?.message_id === id && p.result.status === 'ok')).toHaveLength(1);
		}
		const bFeed = feedOf(w).map((e) => e.id);

		closeChat(B);
		await startApp(A);
		await signIn(A);
		const wA = await openChat(A, B);
		await vi.waitFor(() => expect(feedOf(wA).map((e) => e.id)).toEqual(bFeed), { timeout: 15_000 });
	}, 240_000);
});

describe('reload at every durable boundary', () => {
	it('durable unsigned intent (before signing): the projection is back after reload and recovery sends it once', async () => {
		let w = await onlineHistory();
		net.mode = 'offline';
		const { payload } = await B.app.$dialogs.captureMessageIntent(A.hash, 'M7 unsigned');
		w = await hardReload();
		await vi.waitFor(() => expect(feedOf(w).map((e) => e.text)).toEqual([...HISTORY, 'M7 unsigned']), { timeout: 15_000 });
		expect(feedOf(w).at(-1)!.id).toBe(payload.messageId);
		goOnline();
		window.dispatchEvent(new Event('online'));
		await vi.waitFor(() => expect(server.posts.filter((p) => p.row?.message_id === payload.messageId && p.result.status === 'ok')).toHaveLength(1), { timeout: 30_000 });
		await vi.waitFor(() => expect(B.app.$dialogs.optimisticItems.size).toBe(0), { timeout: 15_000 });
		expect(feedOf(w).map((e) => e.text)).toEqual([...HISTORY, 'M7 unsigned']);
	}, 240_000);

	it('accepted, echo not yet verified: after reload the bubble is there with ✓, not duplicated, then replaced once', async () => {
		let w = await onlineHistory();
		server.hold('dialog_messages');
		sendFromUi(w, 'M8 accepted');
		await vi.waitFor(() => expect(projectionOf('M8 accepted')?.status).toBe('synced'), { timeout: 15_000 });
		const id = projectionOf('M8 accepted').id;
		w = await hardReload();
		await vi.waitFor(() => {
			expect(feedOf(w).map((e) => e.text)).toEqual([...HISTORY, 'M8 accepted']);
			expect(markerOf(bubbleOf(w, 'M8 accepted'))?.text()).toBe('✓');
		}, { timeout: 15_000 });
		server.release('dialog_messages');
		await vi.waitFor(() => {
			expect(feedOf(w).map((e) => e.id).filter((x) => x === id)).toHaveLength(1);
			expect(B.app.$dialogs.optimisticItems.size).toBe(0);
		}, { timeout: 15_000 });
		expect(server.posts.filter((p) => p.row?.message_id === id && p.result.status === 'ok')).toHaveLength(1);
	}, 240_000);

	it('quarantined: after reload the bubble shows the failure; Discard removes it and its lifecycle record', async () => {
		let w = await onlineHistory();
		server.reject = (relation) => (relation === 'dialog_messages'
			? { status: 'error', error: 'validation_failed', details: { content_b64: ['is invalid'] }, permanent422: true }
			: null);
		sendFromUi(w, 'M9 rejected');
		await vi.waitFor(() => expect(projectionOf('M9 rejected')?.status).toBe('error'), { timeout: 15_000 });
		const id = projectionOf('M9 rejected').id;
		w = await hardReload();
		await vi.waitFor(() => {
			expect(feedOf(w).map((e) => e.text)).toEqual([...HISTORY, 'M9 rejected']);
			expect(markerOf(bubbleOf(w, 'M9 rejected'))?.text()).toBe('!');
		}, { timeout: 15_000 });

		w.findComponent({ name: 'ChatWindow' }).vm.$emit('discard-message', id);
		await vi.waitFor(async () => {
			expect(feedOf(w).map((e) => e.text)).toEqual(HISTORY);
			expect((await B.app.outbox.quarantinedEntries(B.hash)).filter((e) => e.relation === 'dialog_messages')).toEqual([]);
		}, { timeout: 15_000 });
		w = await hardReload();
		await vi.waitFor(() => expect(feedOf(w).map((e) => e.text)).toEqual(HISTORY), { timeout: 15_000 });
		await new Promise((r) => setTimeout(r, 500));
		expect(feedOf(w).map((e) => e.text)).toEqual(HISTORY);
	}, 240_000);

	it('another account on the same device never hydrates these projections; the owner gets them back', async () => {
		let w = await onlineHistory();
		net.mode = 'offline';
		sendFromUi(w, 'M10 private');
		await vi.waitFor(() => expect(projectionOf('M10 private')?.status).toBe('queued'), { timeout: 45_000 });
		const id = projectionOf('M10 private').id;
		closeChat(B);

		net.mode = 'online';
		await startApp(B);
		await B.app.store.registerNewUser({ name: 'Carol' } as never);
		const carol = B.app.store.currentUserHash;
		expect(carol).not.toBe(B.hash);
		await new Promise((r) => setTimeout(r, 300));
		expect([...B.app.$dialogs.optimisticItems.values()].filter((i) => i.id === id)).toEqual([]);

		net.mode = 'offline';
		await signIn(B);
		await vi.waitFor(() => expect(B.app.$dialogs.optimisticItems.get(id)?.text).toBe('M10 private'), { timeout: 15_000 });
	}, 240_000);
});

const failIdb = (dbName: string, method: 'put' | 'getAllKeys', times = Infinity) => {
	const original = IDBObjectStore.prototype[method] as (...args: unknown[]) => IDBRequest;
	let left = times;
	IDBObjectStore.prototype[method] = function (this: IDBObjectStore, ...args: unknown[]) {
		if (this.transaction.db.name === dbName && left > 0) {
			left--;
			throw new DOMException('injected storage failure', 'UnknownError');
		}
		return original.apply(this, args);
	} as never;
	return () => { IDBObjectStore.prototype[method] = original as never; };
};

const hideIdbKeys = (dbName: string) => {
	const original = IDBObjectStore.prototype.getAllKeys;
	IDBObjectStore.prototype.getAllKeys = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['getAllKeys']>) {
		if (this.transaction.db.name === dbName) return original.call(this, IDBKeyRange.only('\uffff-nothing'));
		return original.apply(this, args);
	};
	return () => { IDBObjectStore.prototype.getAllKeys = original; };
};

describe('projection storage failures', () => {
	it('a failed projection write stops the Send: no intent, no HTTP, no bubble, an explicit local error', async () => {
		const w = await onlineHistory();
		harness.swal.calls.length = 0;
		const postsBefore = server.posts.length;
		const undo = failIdb('buckitup-message-projections', 'put');
		try {
			sendFromUi(w, 'M11 not durable');
			await vi.waitFor(() => expect(harness.swal.calls.some((c) => c.icon === 'error')).toBe(true), { timeout: 15_000 });
		} finally {
			undo();
		}
		await new Promise((r) => setTimeout(r, 500));
		expect(projectionOf('M11 not durable')).toBeUndefined();
		expect(feedOf(w).map((e) => e.text)).toEqual(HISTORY);
		expect(server.posts.slice(postsBefore).filter((p) => p.relation === 'dialog_messages')).toEqual([]);
		const { intentsOf } = await import('@/lib/data/intents');
		expect((await intentsOf(B.hash)).entries.filter((e) => e.relation === 'dialog_messages')).toEqual([]);
	}, 120_000);

	it('an intent that cannot be stored removes the projection already written: nothing sent, nothing shown after reload', async () => {
		let w = await onlineHistory();
		harness.swal.calls.length = 0;
		const postsBefore = server.posts.length;
		const undo = failIdb('buckitup-intents', 'put');
		try {
			sendFromUi(w, 'M12 no intent');
			await vi.waitFor(() => expect(harness.swal.calls.some((c) => c.icon === 'error')).toBe(true), { timeout: 15_000 });
		} finally {
			undo();
		}
		await vi.waitFor(async () => expect(await diskProjectionKeys()).toEqual([]), { timeout: 5_000 });
		expect(projectionOf('M12 no intent')).toBeUndefined();
		expect(server.posts.slice(postsBefore).filter((p) => p.relation === 'dialog_messages')).toEqual([]);
		w = await hardReload();
		await new Promise((r) => setTimeout(r, 1000));
		expect(feedOf(w).map((e) => e.text)).toEqual(HISTORY);
	}, 120_000);

	it('a transient read failure during hydration is retried: the bubble still comes back', async () => {
		let w = await onlineHistory();
		net.mode = 'offline';
		sendFromUi(w, 'M12 retried');
		await vi.waitFor(() => expect(projectionOf('M12 retried')?.status).toBe('queued'), { timeout: 45_000 });
		const undo = failIdb('buckitup-message-projections', 'getAllKeys', 1);
		try {
			w = await hardReload();
			await vi.waitFor(() => expect(feedOf(w).map((e) => e.text)).toEqual([...HISTORY, 'M12 retried']), { timeout: 15_000 });
		} finally {
			undo();
		}
	}, 180_000);

	it('an unreadable lifecycle at hydration never deletes the projection as stale', async () => {
		let w = await onlineHistory();
		net.mode = 'offline';
		sendFromUi(w, 'M13 kept');
		await vi.waitFor(() => expect(projectionOf('M13 kept')?.status).toBe('queued'), { timeout: 45_000 });
		const id = projectionOf('M13 kept').id;
		const undoOutbox = failIdb('buckitup-outbox', 'getAllKeys');
		const undoIntents = failIdb('buckitup-intents', 'getAllKeys');
		try {
			w = await hardReload();
			await new Promise((r) => setTimeout(r, 1000));
		} finally {
			undoIntents();
			undoOutbox();
		}
		await vi.waitFor(() => expect(feedOf(w).map((e) => e.text)).toEqual([...HISTORY, 'M13 kept']), { timeout: 15_000 });
		expect(feedOf(w).at(-1)!.id).toBe(id);
	}, 180_000);

	it('a lifecycle that is momentarily invisible (reads empty, no error) never deletes the projection as stale', async () => {
		let w = await onlineHistory();
		net.mode = 'offline';
		sendFromUi(w, 'M14 kept');
		await vi.waitFor(() => expect(projectionOf('M14 kept')?.status).toBe('queued'), { timeout: 45_000 });
		const id = projectionOf('M14 kept').id;
		const unhideOutbox = hideIdbKeys('buckitup-outbox');
		const unhideIntents = hideIdbKeys('buckitup-intents');
		try {
			w = await hardReload();
			await new Promise((r) => setTimeout(r, 1000));
			expect(feedOf(w).map((e) => e.text)).toEqual(HISTORY);
		} finally {
			unhideIntents();
			unhideOutbox();
		}
		await vi.waitFor(() => expect(feedOf(w).map((e) => e.text)).toEqual([...HISTORY, 'M14 kept']), { timeout: 15_000 });
		expect(feedOf(w).at(-1)!.id).toBe(id);
	}, 180_000);
});


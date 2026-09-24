// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as harness from './helpers/twoClients';
import type { Client } from './helpers/twoClients';

const { server, net, register, startApp, signIn, openChat, closeChat, stopAll, feedOf, expectVerifiedFeed, newClient } = harness;

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

const TEXTS = ['M1 first', 'M2 second', 'M3 after both'];

const aSendsRootForkThenMerge = async () => {
	const { $dialogs } = A.app;
	const m1 = await $dialogs.captureMessageIntent(B.hash, TEXTS[0]);
	const m2 = await $dialogs.captureMessageIntent(B.hash, TEXTS[1]);
	expect(m1.payload.observedTails).toEqual({});
	expect(m2.payload.observedTails).toEqual({});
	const statuses: { m1: string[]; m2: string[] } = { m1: [], m2: [] };
	await Promise.all([
		$dialogs.dispatchMessageIntent(m1.intentId, m1.payload, m1.token, (s: string) => statuses.m1.push(s)),
		$dialogs.dispatchMessageIntent(m2.intentId, m2.payload, m2.token, (s: string) => statuses.m2.push(s)),
	]);
	expect(statuses.m1).toContain('synced');
	expect(statuses.m2).toContain('synced');

	const m3Statuses: string[] = [];
	const m3Id = await $dialogs.sendMessage(B.hash, TEXTS[2], (s: string) => m3Statuses.push(s));
	await vi.waitFor(() => expect(m3Statuses).toContain('synced'), { timeout: 15_000 });
	return { m1: m1.payload.messageId as unknown as string, m2: m2.payload.messageId as unknown as string, m3: m3Id as unknown as string };
};

describe('DLG-03: two first messages with the same empty scope form a valid root fork', () => {
	it('both roots verify on the receiver, the merging M3 is not stuck, and both clients agree after reload', async () => {
		await register(B);
		await register(A);
		const ids = await aSendsRootForkThenMerge();

		const rows = server.table('dialog_messages');
		expect(rows.has(ids.m1) && rows.has(ids.m2) && rows.has(ids.m3)).toBe(true);

		await startApp(B);
		await signIn(B);
		const wB = await openChat(B, A);
		await vi.waitFor(() => expectVerifiedFeed(wB, TEXTS), { timeout: 15_000 });
		const bFeed = feedOf(wB).map((e) => e.id);
		closeChat(B);

		await startApp(A);
		await signIn(A);
		const wA = await openChat(A, B);
		await vi.waitFor(() => expectVerifiedFeed(wA, TEXTS), { timeout: 15_000 });
		const aFeed = feedOf(wA).map((e) => e.id);
		closeChat(A);

		await startApp(B);
		await signIn(B);
		const wB2 = await openChat(B, A);
		await vi.waitFor(() => expectVerifiedFeed(wB2, TEXTS), { timeout: 15_000 });

		expect(aFeed).toEqual([ids.m1, ids.m2, ids.m3]);
		expect(bFeed).toEqual(aFeed);
		expect(feedOf(wB2).map((e) => e.id)).toEqual(aFeed);
	}, 120_000);
});

// @vitest-environment jsdom
// A first message written offline to a new dialog waits for recovery: its
// dialog key cannot be published until the dialog's keys are readable. When
// the server is back, it goes out on its own — no reload, no tab switch, no
// 'online' event (which can fire while the server is still unreachable, and
// then never again).
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as harness from './helpers/twoClients';
import type { Client } from './helpers/twoClients';

const { server, net, goOnline, register, stopAll, newClient } = harness;

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

const messagesFrom = (who: Client) => [...server.table('dialog_messages').values()].filter((r) => r.sender_hash === who.hash);

describe('a message written offline to a new dialog', () => {
	it('goes out once the server is back, with no reload, tab switch or online event', async () => {
		await register(B);
		await register(A);
		const online = vi.fn();
		window.addEventListener('online', online);

		net.mode = 'offline';
		const statuses: string[] = [];
		await A.app.$dialogs.sendMessage(B.hash, 'first, offline', (s: string) => statuses.push(s)).catch(() => {});
		await new Promise((r) => setTimeout(r, 500));
		expect(messagesFrom(A)).toHaveLength(0);

		goOnline(); // the server answers again; the browser says nothing
		await vi.waitFor(() => expect(messagesFrom(A)).toHaveLength(1), { timeout: 20_000, interval: 200 });
		expect(online).not.toHaveBeenCalled();
		window.removeEventListener('online', online);
	}, 40_000);
});

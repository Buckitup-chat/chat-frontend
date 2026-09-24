// @vitest-environment jsdom
// Profiles that opened the teststand before it was deleted still hold its
// guardian EOA and spending private keys in localStorage as plaintext, next to
// a payload carrying the owner key and the master secret. Nothing else in the
// app clears localStorage, so the store reaps them on boot — most profiles
// never sign out, they close the tab.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

class FakeEM extends EventTarget {
	get currentUserHash() { return null; }
	get isAuth() { return false; }
	async initialize() {}
	async getLocalUserCards() { return []; }
}

let fake;

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => fake },
}));
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => ({ toArray: [], async preload() {}, subscribeChanges: () => ({ unsubscribe() {} }) }),
}));
vi.mock('@/lib/data/attach', () => ({
	preloadWithRetry: async () => false,
}));

const { userPQStore } = await import('@/store/userPQ.store');

describe('the teststand key reaper', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		fake = new FakeEM();
		localStorage.clear();
	});

	it('removes both keys on boot, without being signed out first', async () => {
		localStorage.setItem('testbed.guardians', JSON.stringify([{ eoaPrivateKey: '0xdead' }]));
		localStorage.setItem('testbed.backups', JSON.stringify([{ ownerPrivateKey: '0xbeef' }]));

		await userPQStore().initialize();

		expect(localStorage.getItem('testbed.guardians')).toBe(null);
		expect(localStorage.getItem('testbed.backups')).toBe(null);
	});

	it('leaves everything else alone', async () => {
		localStorage.setItem('something.else', 'keep me');

		await userPQStore().initialize();

		expect(localStorage.getItem('something.else')).toBe('keep me');
	});

	it('still removes the payload when removing the keys throws', async () => {
		localStorage.setItem('testbed.backups', 'payload');
		const real = localStorage.removeItem.bind(localStorage);
		const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
			// The half left behind must not be the half holding the owner key
			// and the master secret, which is what one shared try block risked.
			if (key === 'testbed.guardians') throw new DOMException('SecurityError');
			real(key);
		});
		try {
			await userPQStore().initialize();
			expect(localStorage.getItem('testbed.backups')).toBe(null);
		} finally {
			spy.mockRestore();
		}
	});
});

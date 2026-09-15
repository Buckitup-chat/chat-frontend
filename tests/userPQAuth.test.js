// Auth state reactivity of the userPQ store. EncryptionManagerPQ extends
// EventTarget and keeps its state in private fields — a computed over the
// instance never invalidates (Vue cannot proxy either), so the store must
// carry auth state in plain refs fed by the manager's authChange event.
// Everything watching currentUserHash — the dialogs store's account-switch
// cache flush above all — depends on this file's assertions.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { watch, nextTick } from 'vue';

// A faithful stand-in: EventTarget subclass, state invisible to Vue exactly
// like the real class's private fields.
class FakeEM extends EventTarget {
	#userHash = null;
	get currentUserHash() { return this.#userHash; }
	get isAuth() { return !!this.#userHash; }
	async initialize() {}
	async getLocalUserCards() { return []; }
	fakeLogin(hash) {
		this.#userHash = hash;
		this.dispatchEvent(new CustomEvent('authChange', { detail: { isAuthenticated: true, userHash: hash } }));
	}
	fakeLogout() {
		this.#userHash = null;
		this.dispatchEvent(new CustomEvent('authChange', { detail: { isAuthenticated: false, userHash: null } }));
	}
}

let fake;

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => fake },
}));
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => ({ toArray: [], async preload() {}, subscribeChanges: () => ({ unsubscribe() {} }) }),
}));
vi.mock('@/lib/data/attach', () => ({
	preloadWithRetry: async () => false, // network phase opts out in this harness
}));

const { userPQStore } = await import('@/store/userPQ.store');

describe('userPQ auth reactivity', () => {
	let store;

	beforeEach(async () => {
		setActivePinia(createPinia());
		fake = new FakeEM();
		store = userPQStore();
		await store.initialize();
	});

	it('currentUserHash follows login and logout through the authChange event', async () => {
		// the read BEFORE the transition is the trap: a computed over the raw
		// instance caches this null and never recomputes
		expect(store.currentUserHash).toBe(null);
		expect(store.isAuthenticated).toBe(false);

		fake.fakeLogin('u_' + '1'.repeat(128));
		expect(store.currentUserHash).toBe('u_' + '1'.repeat(128));
		expect(store.isAuthenticated).toBe(true);

		fake.fakeLogout();
		expect(store.currentUserHash).toBe(null);
		expect(store.isAuthenticated).toBe(false);
	});

	it('a watcher on currentUserHash fires across an account switch', async () => {
		const seen = [];
		watch(() => store.currentUserHash, (v) => seen.push(v));

		fake.fakeLogin('u_' + '1'.repeat(128));
		await nextTick();
		fake.fakeLogin('u_' + '2'.repeat(128));
		await nextTick();
		fake.fakeLogout();
		await nextTick();

		expect(seen).toEqual(['u_' + '1'.repeat(128), 'u_' + '2'.repeat(128), null]);
	});
});

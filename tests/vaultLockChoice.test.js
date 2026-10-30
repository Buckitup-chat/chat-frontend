import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { PrfUnsupportedError } from '@/lib/pq/vaultLock';

class FakeEM extends EventTarget {
	locks = [];
	failure = null;
	get currentUserHash() { return null; }
	get isAuth() { return false; }
	async initialize() {}
	async getLocalUserCards() { return []; }
	async loadUserProfile() { return null; }
	async loadContacts() { return []; }
	async #attempt(lock) {
		this.locks.push(lock);
		if (lock === 'prf' && this.failure) throw this.failure;
	}
	async createUserVault({ name, lock }) {
		await this.#attempt(lock);
		return { user_hash: 'u_new', name };
	}
	async importVaultKeys(keys, identity, { lock }) {
		await this.#attempt(lock);
		return { status: 'card-deferred', userHash: identity.user_hash };
	}
}

let fake;

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: { getInstance: () => fake },
}));
vi.mock('@/lib/data/collections', () => ({
	getUserCardsCollection: () => ({ toArray: [], async preload() {}, subscribeChanges: () => ({ unsubscribe() {} }) }),
}));
vi.mock('@/lib/data/attach', () => ({ preloadWithRetry: async () => false }));

const { userPQStore } = await import('@/store/userPQ.store');

const BACKUP = { identity: { user_hash: 'u_old', name: 'Old' }, keys: {} };

describe.each([
	['registration', (store) => store.registerNewUser({ name: 'New' })],
	['import', (store) => store.importBackup(structuredClone(BACKUP))],
])('a new vault\'s lock (%s)', (_, run) => {
	let store;
	let consent;

	beforeEach(async () => {
		setActivePinia(createPinia());
		fake = new FakeEM();
		store = userPQStore();
		await store.initialize();
		consent = vi.fn(async () => true);
		store.setLegacyLockConsent(consent);
	});

	it('is PRF, with nothing asked, when the passkey gives a PRF value', async () => {
		await run(store);
		expect(fake.locks).toEqual(['prf']);
		expect(consent).not.toHaveBeenCalled();
	});

	it('falls back to legacy only for a passkey without PRF, and only with consent', async () => {
		fake.failure = new PrfUnsupportedError('AAAA', 'authenticator');
		await run(store);
		expect(consent).toHaveBeenCalledTimes(1);
		expect(fake.locks).toEqual(['prf', 'legacy']);
	});

	it('stops when the person declines the legacy lock', async () => {
		fake.failure = new PrfUnsupportedError('AAAA', 'browser');
		consent.mockResolvedValue(false);
		await expect(run(store)).rejects.toBeInstanceOf(PrfUnsupportedError);
		expect(fake.locks).toEqual(['prf']);
	});

	it.each([
		['a dismissed prompt', new DOMException('cancelled', 'NotAllowedError')],
		['a timeout', new DOMException('timed out', 'TimeoutError')],
		['any other failure', new Error('network down')],
	])('%s is the error: no consent asked, no legacy vault', async (_, failure) => {
		fake.failure = failure;
		await expect(run(store)).rejects.toBe(failure);
		expect(consent).not.toHaveBeenCalled();
		expect(fake.locks).toEqual(['prf']);
	});

	it('without a consent handler, nothing falls back', async () => {
		store.setLegacyLockConsent(null);
		fake.failure = new PrfUnsupportedError('AAAA', 'authenticator');
		await expect(run(store)).rejects.toBeInstanceOf(PrfUnsupportedError);
		expect(fake.locks).toEqual(['prf']);
	});
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { PrfUnsupportedError } from '@buckitup/pq-client/vaultLock';
import { toBase64 } from '@buckitup/pq-client/signature';

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

const BACKUP = (() => {
	const { publicKey, secretKey } = ml_dsa87.keygen(new Uint8Array(32).fill(7));
	return {
		identity: { user_hash: 'u_' + bytesToHex(sha3_512(publicKey)), name: 'Old', sign_pkey: toBase64(publicKey) },
		keys: { sign_skey: toBase64(secretKey), crypt_skey: 'Y3J5cHQ=', evm_skey: 'ab', contact_skey: 'cd' },
	};
})();

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

describe('a backup that is not its account\'s', () => {
	it('is refused before the import starts', async () => {
		setActivePinia(createPinia());
		fake = new FakeEM();
		const store = userPQStore();
		await store.initialize();
		const spoiled = structuredClone(BACKUP);
		spoiled.identity.user_hash = 'u_' + 'ab'.repeat(64);
		await expect(store.importBackup(spoiled)).rejects.toMatchObject({ name: 'BackupMismatchError' });
		expect(fake.locks).toEqual([]);
	});
});

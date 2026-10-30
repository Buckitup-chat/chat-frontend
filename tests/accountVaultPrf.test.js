import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { prfAuthenticator } from './helpers/prfAuthenticator';

const derivedKeys = vi.hoisted(() => []);
vi.mock('@lo-fi/local-data-lock', async () => {
	const actual = await vi.importActual('@lo-fi/local-data-lock');
	return {
		...actual,
		deriveLockKey: (seed) => {
			const key = actual.deriveLockKey(seed);
			derivedKeys.push(key);
			return key;
		},
	};
});

const lofiCalls = [];
let accountVault;
let listLocalIdentities;

beforeAll(async () => {
	await sodium.ready;
	globalThis.sodium = sodium;
	globalThis.PublicKeyCredential = {
		isConditionalMediationAvailable: async () => false,
		isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
	};
	const refuse = (ceremony) => async () => {
		lofiCalls.push(ceremony);
		throw new DOMException('lo-fi asked for a passkey', 'NotAllowedError');
	};
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { credentials: { create: refuse('create'), get: refuse('get') } },
	});
	accountVault = await import('@/libs/accountVault');
	({ listLocalIdentities } = await import('@lo-fi/local-data-lock'));
});

beforeEach(() => {
	lofiCalls.length = 0;
	derivedKeys.length = 0;
	vi.restoreAllMocks();
});

const SIGN_SKEY = Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + 1) & 0xff);

const newVault = async () => {
	const auth = prfAuthenticator('at-create');
	const { vault, lock } = await accountVault.createPrfVault({ name: 'Alice', credentials: auth.credentials, rpId: 'localhost' });
	await vault.set('sign_skey', SIGN_SKEY);
	await vault.set('evm_skey', 'evm-secret-hex');
	return { auth, vault, lock };
};

describe('PRF-locked vault on lo-fi', () => {
	it('is created with one passkey prompt, and lo-fi never runs its own passkey flow', async () => {
		const { auth, vault } = await newVault();
		expect(new Uint8Array(Object.values(await vault.get('sign_skey')))).toEqual(SIGN_SKEY);
		expect(await vault.get('evm_skey')).toBe('evm-secret-hex');
		expect(auth.calls).toEqual(['create']);
		expect(lofiCalls).toEqual([]);
	});

	it('leaves only ciphertext and the vault ID on disk, and no lo-fi passkey record', async () => {
		const { vault } = await newVault();
		const row = await accountVault.vaultStorage().get(`local-vault-${vault.id}`);
		expect(row).toMatchObject({ accountID: vault.id, rpID: 'localhost' });
		expect(typeof row.data).toBe('string');
		expect(JSON.stringify(row)).not.toContain('evm-secret-hex');
		expect(await listLocalIdentities()).toEqual([]);
	});

	it('once locked, refuses every call until its own passkey opens it again from disk', async () => {
		const { auth, vault, lock } = await newVault();
		vault.lock();
		await expect(vault.get('evm_skey')).rejects.toMatchObject({ name: 'VaultLockedError' });

		const reopened = await accountVault.openPrfVault(vault.id, lock, { credentials: auth.credentials });
		expect(await reopened.get('evm_skey')).toBe('evm-secret-hex');
		await reopened.set('meta_seed', 'abc');
		expect(await reopened.get('meta_seed')).toBe('abc');
		expect(auth.calls).toEqual(['create', 'get']);
		expect(lofiCalls).toEqual([]);
	});

	it('does not open under another PRF value, and still opens under its own afterwards', async () => {
		const { auth, vault, lock } = await newVault();
		vault.lock();
		const otherSalt = { ...lock, salt: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) };
		await expect(accountVault.openPrfVault(vault.id, otherSalt, { credentials: auth.credentials })).rejects.toThrow();

		const reopened = await accountVault.openPrfVault(vault.id, lock, { credentials: auth.credentials });
		expect(await reopened.get('evm_skey')).toBe('evm-secret-hex');
		expect(lofiCalls).toEqual([]);
	});

	it('clear removes the vault\'s row', async () => {
		const { vault } = await newVault();
		await vault.clear();
		expect(await accountVault.vaultStorage().get(`local-vault-${vault.id}`)).toBeFalsy();
		expect(lofiCalls).toEqual([]);
	});

	it('keeps the lock record beside the vault, and only for a PRF vault', async () => {
		const { vault, lock } = await newVault();
		expect(await accountVault.prfLockOf(vault.id)).toEqual(lock);
		expect(await accountVault.prfLockOf('no-such-vault')).toBeNull();
		expect(accountVault.isPrfVault(vault)).toBe(true);
	});

	it('a vault for an existing passkey makes no passkey, and that passkey opens it later', async () => {
		const { auth, lock: first } = await newVault();
		const { lockRecordFor, readLockSeed } = await import('@/lib/pq/vaultLock');
		const lock = lockRecordFor({ credentialId: first.credentialId, rpId: 'localhost' });
		expect(lock.salt).not.toBe(first.salt);
		const seed = await readLockSeed(auth.credentials, lock);
		const { vault } = await accountVault.createPrfVaultWithSeed({ lock, seed });
		await vault.set('evm_skey', 'second-vault');
		vault.lock();
		expect(seed.every((b) => b === 0)).toBe(true);

		const reopened = await accountVault.openPrfVault(vault.id, lock, { credentials: auth.credentials });
		expect(await reopened.get('evm_skey')).toBe('second-vault');
		expect(auth.calls.filter((c) => c === 'create')).toEqual(['create']);
		expect(lofiCalls).toEqual([]);
	});

	it('opening a vault that is gone refuses before any prompt, and makes no empty row', async () => {
		const { auth, vault, lock } = await newVault();
		await accountVault.dropPrfVault(vault.id, vault);
		const before = auth.calls.length;
		await expect(accountVault.openPrfVault(vault.id, lock, { credentials: auth.credentials })).rejects.toThrow(/No vault/);
		expect(auth.calls.length).toBe(before);
		expect(await accountVault.vaultStorage().get(`local-vault-${vault.id}`)).toBeFalsy();
		expect(await accountVault.prfLockOf(vault.id)).toBeNull();
		expect(lofiCalls).toEqual([]);
	});

	it('a lock record that cannot be written leaves the new vault\'s key wiped', async () => {
		const store = accountVault.vaultStorage();
		const write = store.set.bind(store);
		vi.spyOn(store, 'set').mockImplementation(async (key, value) => {
			if (key.startsWith('pq-vault-lock-')) throw new DOMException('quota', 'QuotaExceededError');
			return write(key, value);
		});
		const auth = prfAuthenticator('at-create');
		await expect(accountVault.createPrfVault({ name: 'Alice', credentials: auth.credentials, rpId: 'localhost' }))
			.rejects.toMatchObject({ name: 'QuotaExceededError' });
		expect(derivedKeys).toHaveLength(1);
		expect(derivedKeys[0].encSK.every((b) => b === 0)).toBe(true);
		expect(derivedKeys[0].iv.every((b) => b === 0)).toBe(true);
	});

	it('a device without PRF gets PrfUnsupportedError and no vault', async () => {
		const auth = prfAuthenticator('none');
		const before = (await accountVault.vaultStorage().keys()).length;
		const error = await accountVault.createPrfVault({ name: 'Bob', credentials: auth.credentials, rpId: 'localhost' }).catch((e) => e);
		expect(error.name).toBe('PrfUnsupportedError');
		expect((await accountVault.vaultStorage().keys()).length).toBe(before);
		expect(lofiCalls).toEqual([]);
	});
});

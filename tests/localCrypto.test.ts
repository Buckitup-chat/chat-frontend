import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentUserHash: string | null = null;
let exportVaultKeys: () => Promise<{ crypt_skey: string }>;

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() { return currentUserHash; },
			exportVaultKeys: () => exportVaultKeys(),
		}),
	},
}));

const { getLocalStorageKey, clearLocalStorageKey } = await import('@/lib/data/localCrypto');

const MY_HASH = 'u_' + 'a'.repeat(128);

beforeEach(() => {
	currentUserHash = null;
	exportVaultKeys = async () => { throw new Error('Vault not loaded'); };
	clearLocalStorageKey();
});

describe('getLocalStorageKey: locked vault fails loudly (§3.7)', () => {
	it('throws when no account is signed in — never returns a falsy "key" a caller could ignore', async () => {
		await expect(getLocalStorageKey()).rejects.toThrow(/no unlocked account/i);
	});

	it('throws even if a caller somehow has a user_hash but the vault itself never loaded', async () => {
		currentUserHash = MY_HASH;
		await expect(getLocalStorageKey()).rejects.toThrow(/vault not loaded/i);
	});

	it('succeeds once genuinely unlocked, and caches the derived key per account', async () => {
		currentUserHash = MY_HASH;
		exportVaultKeys = async () => ({ crypt_skey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) });

		const key1 = await getLocalStorageKey();
		expect(key1).toBeTruthy();

		let exportCalls = 0;
		const originalExport = exportVaultKeys;
		exportVaultKeys = async () => { exportCalls++; return originalExport(); };
		const key2 = await getLocalStorageKey();
		expect(key2).toBe(key1);
		expect(exportCalls).toBe(0);
	});

	it('clearLocalStorageKey forces re-derivation on next use (logout/account switch)', async () => {
		currentUserHash = MY_HASH;
		exportVaultKeys = async () => ({ crypt_skey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) });
		await getLocalStorageKey();

		clearLocalStorageKey();
		currentUserHash = null;

		await expect(getLocalStorageKey()).rejects.toThrow(/no unlocked account/i);
	});
});

describe('this is what protects intents.ts/outbox.ts while locked (§3.7 conclusion)', () => {
	it('a store built on getLocalStorageKey cannot silently write while locked', async () => {
		const { createSecureStore } = await import('@/lib/data/secureStore');
		const inner = new Map<string, string>();
		const store = createSecureStore(
			{
				get: async (k) => inner.get(k) ?? null,
				set: async (k, v) => { inner.set(k, v); },
				delete: async (k) => { inner.delete(k); },
				keys: async () => [...inner.keys()],
				clear: async () => inner.clear(),
			},
			{ getKey: getLocalStorageKey }
		);

		await expect(store.set('k', 'v')).rejects.toThrow(/no unlocked account/i);
		expect(inner.size).toBe(0);
	});

	it('an existing record cannot be silently decrypted while locked either — a missing key never reads as "no such record"', async () => {
		const { createSecureStore } = await import('@/lib/data/secureStore');
		const looksLikeCiphertext = btoa(String.fromCharCode(...new Uint8Array(28).fill(1)));
		const inner = new Map<string, string>([['k', looksLikeCiphertext]]);
		const store = createSecureStore(
			{
				get: async (k) => inner.get(k) ?? null,
				set: async (k, v) => { inner.set(k, v); },
				delete: async (k) => { inner.delete(k); },
				keys: async () => [...inner.keys()],
				clear: async () => inner.clear(),
			},
			{ getKey: getLocalStorageKey }
		);

		await expect(store.get('k')).rejects.toThrow(/no unlocked account/i);
	});
});

// §3.7: the structural claim behind "AWAITING_UNLOCK has no reachable
// target" — every durable store this app encrypts locally (outbox.ts,
// intents.ts, localStore.ts) derives its key through getLocalStorageKey(),
// which must fail loudly while the vault is locked, never silently produce
// a usable key or a falsely-empty result.
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
		// exportVaultKeys still throws "Vault not loaded" — the second guard.
		await expect(getLocalStorageKey()).rejects.toThrow(/vault not loaded/i);
	});

	it('succeeds once genuinely unlocked, and caches the derived key per account', async () => {
		currentUserHash = MY_HASH;
		exportVaultKeys = async () => ({ crypt_skey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) });

		const key1 = await getLocalStorageKey();
		expect(key1).toBeTruthy();

		// Cached: a second call must not re-derive (same object identity).
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
		currentUserHash = null; // simulate the account having locked again

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

		// Locked: the write never goes through — same failure this module's
		// own guard produces, not a different, weaker one.
		await expect(store.set('k', 'v')).rejects.toThrow(/no unlocked account/i);
		expect(inner.size).toBe(0); // nothing was written despite the attempt
	});

	it('an existing record cannot be silently decrypted while locked either — a missing key never reads as "no such record"', async () => {
		const { createSecureStore } = await import('@/lib/data/secureStore');
		// A record left behind from a previous, unlocked session (valid
		// base64 so get() gets past framing and actually needs the key) —
		// get() must still try to decrypt it, not skip straight to "not found".
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

		// secureStore wraps every decrypt-path failure under one message; the
		// point here is that it fails at all — a locked read must never
		// resolve as if the record were simply absent.
		await expect(store.get('k')).rejects.toThrow(/cannot decrypt record/i);
	});
});

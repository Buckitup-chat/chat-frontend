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

let deriveGate: (() => Promise<void>) | null = null;
vi.mock('@/lib/data/secureStore', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/data/secureStore')>();
	return {
		...actual,
		deriveLocalStorageKey: async (bytes: Uint8Array) => {
			const key = await actual.deriveLocalStorageKey(bytes);
			await deriveGate?.();
			return key;
		},
	};
});

const { getLocalStorageKey, getLocalStorageKeyFor, clearLocalStorageKey } = await import('@/lib/data/localCrypto');
const { VaultLockedError, AccountMismatchError } = await import('@/lib/data/keyCustody');
const { createSecureStore, DecryptFailedError } = await import('@/lib/data/secureStore');

const MY_HASH = 'u_' + 'a'.repeat(128);

beforeEach(() => {
	currentUserHash = null;
	exportVaultKeys = async () => { throw new Error('Vault not loaded'); };
	deriveGate = null;
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

const OTHER_HASH = 'u_' + 'b'.repeat(128);
const unlockedKeys = async () => ({ crypt_skey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) });
const memoryInner = (seed: Array<[string, string]> = []) => {
	const inner = new Map<string, string>(seed);
	return {
		inner,
		store: {
			get: async (k: string) => inner.get(k) ?? null,
			set: async (k: string, v: string) => { inner.set(k, v); },
			delete: async (k: string) => { inner.delete(k); },
			keys: async () => [...inner.keys()],
			clear: async () => inner.clear(),
		},
	};
};

describe('custody failures are typed, so a reader can tell them from a damaged record', () => {
	it('no unlocked account is a VaultLockedError, for the current account and for a pinned one', async () => {
		await expect(getLocalStorageKey()).rejects.toBeInstanceOf(VaultLockedError);
		await expect(getLocalStorageKeyFor(MY_HASH)).rejects.toBeInstanceOf(VaultLockedError);
	});

	it('an account whose vault keys cannot be exported is a VaultLockedError that keeps the cause', async () => {
		currentUserHash = MY_HASH;
		const error = await getLocalStorageKey().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VaultLockedError);
		expect((error as Error).cause).toBeInstanceOf(Error);
		await expect(getLocalStorageKeyFor(MY_HASH)).rejects.toBeInstanceOf(VaultLockedError);
	});

	it('a pinned owner that is not the open account is an AccountMismatchError, before any key is exported', async () => {
		currentUserHash = OTHER_HASH;
		let exports = 0;
		exportVaultKeys = async () => { exports++; return unlockedKeys(); };

		await expect(getLocalStorageKeyFor(MY_HASH)).rejects.toBeInstanceOf(AccountMismatchError);
		expect(exports).toBe(0);
	});

	it('an account switch during the async export is an AccountMismatchError, and the key is not cached for the pinned owner', async () => {
		currentUserHash = MY_HASH;
		exportVaultKeys = async () => {
			currentUserHash = OTHER_HASH;
			return unlockedKeys();
		};

		await expect(getLocalStorageKeyFor(MY_HASH)).rejects.toBeInstanceOf(AccountMismatchError);

		currentUserHash = MY_HASH;
		let exports = 0;
		exportVaultKeys = async () => { exports++; return unlockedKeys(); };
		await getLocalStorageKeyFor(MY_HASH);
		expect(exports).toBe(1); // derived afresh: the refused key was never cached
	});
});

describe('getLocalStorageKey never files one account\'s key under another', () => {
	const heldExports = () => {
		const release: Array<() => void> = [];
		let calls = 0;
		exportVaultKeys = () => {
			calls++;
			return new Promise((resolve) => { release.push(() => resolve(unlockedKeys())); });
		};
		return { calls: () => calls, releaseNext: () => release.shift()!() };
	};
	const countingExports = (start: number) => {
		let calls = start;
		exportVaultKeys = async () => { calls++; return unlockedKeys(); };
		return () => calls;
	};

	it('an account switch while the vault exports is refused, and neither account gets a cached key', async () => {
		currentUserHash = MY_HASH;
		const exports = heldExports();

		const pending = getLocalStorageKey();
		expect(exports.calls()).toBe(1);
		currentUserHash = OTHER_HASH;
		exports.releaseNext();

		await expect(pending).rejects.toBeInstanceOf(AccountMismatchError);

		const calls = countingExports(exports.calls());
		await getLocalStorageKey();
		expect(calls()).toBe(2);
		currentUserHash = MY_HASH;
		await getLocalStorageKey();
		expect(calls()).toBe(3);
	});

	it('the account closing while the vault exports is refused the same way, and nothing is cached', async () => {
		currentUserHash = MY_HASH;
		const exports = heldExports();

		const pending = getLocalStorageKey();
		currentUserHash = null;
		exports.releaseNext();

		await expect(pending).rejects.toBeInstanceOf(AccountMismatchError);
		currentUserHash = MY_HASH;
		const calls = countingExports(exports.calls());
		await getLocalStorageKey();
		expect(calls()).toBe(2);
	});

	it('an account switch during derivation is refused, and nothing is cached', async () => {
		currentUserHash = MY_HASH;
		const calls = countingExports(0);
		let reached!: () => void;
		const derivationRunning = new Promise<void>((resolve) => { reached = resolve; });
		let releaseDerivation!: () => void;
		deriveGate = () => {
			reached();
			return new Promise<void>((resolve) => { releaseDerivation = resolve; });
		};

		const pending = getLocalStorageKey();
		await derivationRunning;
		currentUserHash = OTHER_HASH;
		deriveGate = null;
		releaseDerivation();

		await expect(pending).rejects.toBeInstanceOf(AccountMismatchError);
		await getLocalStorageKey();
		expect(calls()).toBe(2); // B derived its own key; A's refused one was never cached
	});
});

describe('a secure store passes custody failures through, never as a corrupt record', () => {
	it('a locked vault reaches the reader as VaultLockedError, not DecryptFailedError', async () => {
		const { store } = memoryInner([['k', btoa(String.fromCharCode(...new Uint8Array(28).fill(1)))]]);
		const secure = createSecureStore(store, { getKey: getLocalStorageKey });

		const error = await secure.get('k').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VaultLockedError);
		expect(error).not.toBeInstanceOf(DecryptFailedError);
		await expect(secure.set('k2', 'v')).rejects.toBeInstanceOf(VaultLockedError);
	});

	it('the wrong open account reaches the reader as AccountMismatchError, not DecryptFailedError', async () => {
		currentUserHash = MY_HASH;
		exportVaultKeys = unlockedKeys;
		const { store } = memoryInner();
		await createSecureStore(store, { getKey: () => getLocalStorageKeyFor(MY_HASH) }).set('k', 'mine');

		currentUserHash = OTHER_HASH;
		const pinned = createSecureStore(store, { getKey: () => getLocalStorageKeyFor(MY_HASH) });
		const error = await pinned.get('k').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AccountMismatchError);
		expect(error).not.toBeInstanceOf(DecryptFailedError);
	});
});

describe('message and dialog callers share the one VaultLockedError', () => {
	it('a locked vault in messageIntent is the same class dialogs.store checks with instanceof', async () => {
		currentUserHash = MY_HASH;
		const { ownSenderMsgKey } = await import('@/lib/data/messageIntent');

		await expect(ownSenderMsgKey(OTHER_HASH)).rejects.toBeInstanceOf(VaultLockedError);
	});
});

// Key custody for local storage encryption.
//
// Kept apart from secureStore.ts so the wrapper stays pure and testable, and
// so the dependency on EncryptionManagerPQ lives in exactly one place.
//
// The key exists only while an account is unlocked. Every wrapped store is
// therefore readable only after login — the point of the wrapper is that one
// account's records stay opaque to another in the same browser profile.
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { deriveLocalStorageKey } from './secureStore';
import { VaultLockedError, AccountMismatchError } from './keyCustody';

let cached: { userHash: string; key: CryptoKey } | null = null;

/**
 * AES-GCM key for the current account. Throws VaultLockedError while locked: a
 * caller must not mistake "cannot read yet" for "nothing stored".
 *
 * Cached per account — derivation is 100k PBKDF2 rounds, and the outbox drains
 * many records in a row.
 */
const liveUserHash = (em: ReturnType<typeof EncryptionManagerPQ.getInstance>): string | null =>
	(em as { localStorageOwnerHash?: string | null }).localStorageOwnerHash ?? em.currentUserHash;
const liveExportVaultKeys = async (em: ReturnType<typeof EncryptionManagerPQ.getInstance>) => {
	try {
		return await em.exportVaultKeys();
	} catch (e) {
		throw new VaultLockedError(`[localCrypto] vault keys are not available: ${String((e as Error)?.message ?? e)}`, { cause: e });
	}
};
const noUnlockedAccount = () => new VaultLockedError('[localCrypto] no unlocked account: local storage is not readable yet');

const assertStillOwner = (em: ReturnType<typeof EncryptionManagerPQ.getInstance>, owner: string) => {
	const liveHash = liveUserHash(em);
	if (liveHash !== owner) {
		throw new AccountMismatchError(
			`[localCrypto] active account (${liveHash}) no longer matches the pinned owner (${owner}) — refusing to encrypt/decrypt under the wrong account's key`
		);
	}
};

// `owner`'s key: rechecked after every await, and cached only once it is still
// the open account's — a switch mid-way never files one account's key under another.
async function keyOwnedBy(em: ReturnType<typeof EncryptionManagerPQ.getInstance>, owner: string): Promise<CryptoKey> {
	if (cached && cached.userHash === owner) return cached.key;
	const vaultKeys = await liveExportVaultKeys(em);
	assertStillOwner(em, owner);
	const cryptSkey = Uint8Array.from(atob(vaultKeys.crypt_skey), (c) => c.charCodeAt(0));

	const key = await deriveLocalStorageKey(cryptSkey);
	assertStillOwner(em, owner);
	cached = { userHash: owner, key };
	return key;
}

export async function getLocalStorageKey(): Promise<CryptoKey> {
	const em = EncryptionManagerPQ.getInstance();
	const userHash = liveUserHash(em);
	if (!userHash) throw noUnlockedAccount();
	return keyOwnedBy(em, userHash);
}

export async function getLocalStorageKeyFor(expectedUserHash: string): Promise<CryptoKey> {
	const em = EncryptionManagerPQ.getInstance();
	if (!liveUserHash(em)) throw noUnlockedAccount();
	assertStillOwner(em, expectedUserHash);
	return keyOwnedBy(em, expectedUserHash);
}

/** Drop the cached key — call on logout / account switch. */
export function clearLocalStorageKey(): void {
	cached = null;
}

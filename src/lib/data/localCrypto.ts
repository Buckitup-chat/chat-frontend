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

let cached: { userHash: string; key: CryptoKey } | null = null;

/**
 * AES-GCM key for the current account. Throws while locked: a caller must not
 * mistake "cannot read yet" for "nothing stored".
 *
 * Cached per account — derivation is 100k PBKDF2 rounds, and the outbox drains
 * many records in a row.
 */
const liveUserHash = (em: ReturnType<typeof EncryptionManagerPQ.getInstance>): string | null => em.currentUserHash;
const liveExportVaultKeys = (em: ReturnType<typeof EncryptionManagerPQ.getInstance>) => em.exportVaultKeys();

export async function getLocalStorageKey(): Promise<CryptoKey> {
	const em = EncryptionManagerPQ.getInstance();
	const userHash = liveUserHash(em);
	if (!userHash) {
		throw new Error('[localCrypto] no unlocked account: local storage is not readable yet');
	}
	if (cached && cached.userHash === userHash) return cached.key;

	// Throws when the vault is not loaded, which is the same "locked" case.
	const vaultKeys = await liveExportVaultKeys(em);
	const cryptSkey = Uint8Array.from(atob(vaultKeys.crypt_skey), (c) => c.charCodeAt(0));

	const key = await deriveLocalStorageKey(cryptSkey);
	cached = { userHash, key };
	return key;
}

export async function getLocalStorageKeyFor(expectedUserHash: string): Promise<CryptoKey> {
	const em = EncryptionManagerPQ.getInstance();
	const userHash = liveUserHash(em);
	if (!userHash) {
		throw new Error('[localCrypto] no unlocked account: local storage is not readable yet');
	}
	const checkStillOwner = (liveHash: string | null) => {
		if (liveHash !== expectedUserHash) {
			throw new Error(
				`[localCrypto] active account (${liveHash}) no longer matches the pinned owner (${expectedUserHash}) — refusing to encrypt/decrypt under the wrong account's key`
			);
		}
	};
	checkStillOwner(userHash);
	if (cached && cached.userHash === userHash) return cached.key;
	const vaultKeys = await liveExportVaultKeys(em);
	checkStillOwner(liveUserHash(em));
	const cryptSkey = Uint8Array.from(atob(vaultKeys.crypt_skey), (c) => c.charCodeAt(0));

	const key = await deriveLocalStorageKey(cryptSkey);
	checkStillOwner(liveUserHash(em));
	cached = { userHash: expectedUserHash, key };
	return key;
}

/** Drop the cached key — call on logout / account switch. */
export function clearLocalStorageKey(): void {
	cached = null;
}

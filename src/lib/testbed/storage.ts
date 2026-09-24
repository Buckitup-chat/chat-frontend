// Everything the teststand persists, and how it is removed.
//
// It keeps guardian private keys and payloads in the clear, which is fine for a
// sandbox and not fine for a browser profile that outlives the session: the
// next person to open the app inherits working key material of the account that
// left. So the keys and the accessors live in one module — "what does the
// teststand store" has a single answer — and wipeTestbedStorage() is what the
// end-of-session paths call.
//
// This module deliberately imports nothing. The rest of the testbed pulls viem
// and eth-crypto through ./crypto, and a sign-out path has no business loading
// either. It also runs in every build, not only where the teststand is
// reachable: the profiles holding those keys are precisely the ones the sandbox
// has been taken away from, and removing an absent key costs nothing.

export const GUARDIANS_KEY = 'testbed.guardians';
export const BACKUPS_KEY = 'testbed.backups';

/** Parsed value at `key`, or `fallback` for absent, unreadable or unparsable. */
export function readStored<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

export function writeStored(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// a storage-less environment (or a full quota) loses sandbox state only
	}
}

export function removeStored(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		// nothing to remove
	}
}

/**
 * Called from the paths that end a session on this device: signing out,
 * deleting the account, and the login screen's "wipe all". Not from
 * EncryptionManagerPQ.logout() — that function is also the preamble of signing
 * in, so wiping there would destroy guardian keys already registered on chain.
 */
export function wipeTestbedStorage(): void {
	removeStored(GUARDIANS_KEY);
	removeStored(BACKUPS_KEY);
}

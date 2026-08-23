// Encryption wrapper for any string key-value storage.
//
// Hiding metadata on the client is not a requirement (access control for it
// starts at the backend — CTO decision, 2026-08-19). This wrapper exists for
// a different property: several accounts can share one browser profile, and
// a store wrapped here is readable only by the account whose key wrote it.
// Another account's pending writes are opaque to the one currently logged in,
// which is what lets the outbox keep them instead of treating them as
// corrupt. New stores are free to skip the wrapper when that isolation is not
// needed.
//
// Shape of the interface matches StorageAdapter from
// @tanstack/offline-transactions on purpose, so it can be dropped straight
// into the outbox.
//
// What is covered: record values, in full. Record key names only when
// `hashKeys` is set — callers that key by an opaque id (the outbox uses
// sortable ids) need not; callers whose keys embed identifiers (localStore
// uses `us|<user_hash>|<uuid>`) pass hashKeys: true. Record count and size
// are visible by nature of IndexedDB.
//
// The key never leaves this module and is only obtainable after the vault is
// unlocked, so every wrapped store is readable only after login.

export interface StringStore {
	get: (key: string) => Promise<string | null>;
	set: (key: string, value: string) => Promise<void>;
	delete: (key: string) => Promise<void>;
	keys: () => Promise<Array<string>>;
	clear: () => Promise<void>;
}

export interface SecureStoreOptions {
	/**
	 * Resolves the AES-GCM key. Called per operation (cheap: implementations
	 * cache), and throws when the vault is locked — a locked store must fail
	 * loudly rather than look empty.
	 */
	getKey: () => Promise<CryptoKey>;
	/**
	 * Derive record key names instead of storing them verbatim. Required when
	 * key names embed identifiers. Deterministic, so lookups still work;
	 * `keys()` then returns derived names, which round-trip through
	 * get/delete only if the caller treats them as opaque handles — that is
	 * why it is off by default.
	 */
	hashKeys?: boolean;
	/** Domain separation for key-name derivation. */
	keyNameSalt?: string;
}

const IV_BYTES = 12;

const toBase64 = (bytes: Uint8Array): string => {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array =>
	Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

const toHex = (bytes: Uint8Array): string =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Wrap a string store so values are AES-GCM encrypted at rest.
 *
 * A fresh random IV per write: the same plaintext written twice produces
 * different ciphertext, so an observer cannot tell that a record was rewritten
 * with unchanged content.
 */
export function createSecureStore(inner: StringStore, opts: SecureStoreOptions): StringStore {
	const { getKey, hashKeys = false, keyNameSalt = 'buckitup-key-name' } = opts;

	const mapKey = async (key: string): Promise<string> => {
		if (!hashKeys) return key;
		// HMAC under the same key material: deterministic (lookups work) and
		// unlinkable without the key (the identifier inside the name is hidden).
		const cryptoKey = await getKey();
		const raw = await crypto.subtle.exportKey('raw', cryptoKey);
		const hmacKey = await crypto.subtle.importKey(
			'raw',
			raw,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const mac = await crypto.subtle.sign(
			'HMAC',
			hmacKey,
			new TextEncoder().encode(`${keyNameSalt}:${key}`)
		);
		return toHex(new Uint8Array(mac));
	};

	return {
		async get(key) {
			const stored = await inner.get(await mapKey(key));
			if (stored === null) return null;

			try {
				const blob = fromBase64(stored);
				const iv = blob.slice(0, IV_BYTES);
				const ciphertext = blob.slice(IV_BYTES);
				const plain = await crypto.subtle.decrypt(
					{ name: 'AES-GCM', iv },
					await getKey(),
					ciphertext
				);
				return new TextDecoder().decode(plain);
			} catch (e) {
				// Wrong key or tampered record. Returning null would look like
				// "no such record" and could silently drop a pending write, so
				// this fails loudly.
				throw new Error(`[secureStore] cannot decrypt record: ${e}`);
			}
		},

		async set(key, value) {
			const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
			const ciphertext = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv },
				await getKey(),
				new TextEncoder().encode(value)
			);
			const blob = new Uint8Array(IV_BYTES + ciphertext.byteLength);
			blob.set(iv);
			blob.set(new Uint8Array(ciphertext), IV_BYTES);
			await inner.set(await mapKey(key), toBase64(blob));
		},

		async delete(key) {
			await inner.delete(await mapKey(key));
		},

		keys() {
			return inner.keys();
		},

		clear() {
			return inner.clear();
		},
	};
}

/**
 * AES-GCM key for local storage encryption, derived from the account's
 * post-quantum crypt secret.
 *
 * Domain-separated from content encryption (which uses the
 * 'avatar-encryption' salt in EncryptionManagerPQ): compromising one derived
 * key must not hand over the other.
 */
export async function deriveLocalStorageKey(cryptSkey: Uint8Array): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey('raw', cryptSkey, 'PBKDF2', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: new TextEncoder().encode('buckitup-local-storage-v1'),
			iterations: 100000,
			hash: 'SHA-256',
		},
		material,
		{ name: 'AES-GCM', length: 256 },
		true, // extractable: mapKey needs the raw bytes for HMAC derivation
		['encrypt', 'decrypt']
	);
}

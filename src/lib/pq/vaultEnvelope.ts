// The recovery payload: what community backup splits, and where the vault it
// opens can be found.
//
// Shamir is applied to a 32-byte wrap key S and never to the vault itself —
// an ML-DSA key alone is 4896 bytes, and splitting that bloats every share
// (restoration.livemd, "Compact Secret"). The vault is sealed under S and
// stored as an ordinary user_storage row.
//
// The address of that row is derived from S rather than from the account,
// because recovery assumes every device and every key is gone. Reads from
// user_storage need no authentication (pq_user_storage §FR-3), but the row's
// key is (user_hash, uuid) and user_hash comes from the signing key that was
// lost — so the locator has to come from the one secret the guardians give
// back. Gather shares, rebuild S, compute the address, decrypt with S.
//
// A side effect worth having: the server cannot tell a vault row from any
// other user_storage row, nor tell which accounts hold a backup at all.
import { randomBytes } from '@noble/hashes/utils';
import { hkdfDerive } from './hkdf';
import { bytesToUuidV8 } from './slotId';
import { encryptChunk, decryptChunk } from './fileCrypto';
import { toBase64, toBytes } from './signature';

export const VAULT_LOCATOR_SALT = 'buckitup/vault-locator/v1';
export const VAULT_SEAL_SALT = 'buckitup/vault-seal/v1';

const SEAL_VERSION = 1;

export class VaultEnvelopeError extends Error {}

/** A fresh wrap key. This — and only this — is what gets split into shares. */
export const newWrapKey = (): Uint8Array => randomBytes(32);

const requireWrapKey = (s: Uint8Array): Uint8Array => {
	if (!(s instanceof Uint8Array) || s.length !== 32) {
		// A short or absent key would derive one shared address for every
		// account that hit this path, and seal the vault under a guessable key.
		throw new VaultEnvelopeError('the wrap key must be 32 bytes');
	}
	return s;
};

/**
 * The user_storage uuid the sealed vault lives at. Derived, not stored: a
 * recovering client has nothing but S.
 */
export const deriveVaultLocator = (s: Uint8Array): string =>
	bytesToUuidV8(hkdfDerive(requireWrapKey(s), VAULT_LOCATOR_SALT, 'locator', 16));

// S is never used as an AES key directly: the locator is public the moment a
// share is handed out, and one derivation must not weaken the other.
const sealKey = (s: Uint8Array): Uint8Array => hkdfDerive(s, VAULT_SEAL_SALT, 'seal', 32);

/** `version(1) || nonce(12) || AES-256-GCM(vault)`, base64 — the value_b64 of the row. */
export const sealVault = async (vaultJson: string, s: Uint8Array): Promise<string> => {
	const blob = await encryptChunk(sealKey(requireWrapKey(s)), new TextEncoder().encode(vaultJson));
	const out = new Uint8Array(1 + blob.length);
	out[0] = SEAL_VERSION;
	out.set(blob, 1);
	return toBase64(out);
};

export const openVault = async (sealedB64: string, s: Uint8Array): Promise<string> => {
	// Anything structural is answered before the key is blamed. A row at this
	// address may well belong to somebody else — a locator is public the moment
	// a share is handed out — and "your reconstructed secret is wrong" is the
	// one diagnosis recovery cannot afford to give falsely.
	let bytes: Uint8Array;
	try {
		bytes = toBytes(sealedB64);
	} catch {
		throw new VaultEnvelopeError('not a sealed vault: unreadable value');
	}
	// version(1) || nonce(12) || ciphertext || tag(16)
	if (bytes.length < 1 + 12 + 16 || bytes[0] !== SEAL_VERSION) {
		throw new VaultEnvelopeError('not a sealed vault');
	}
	// Derived here, not earlier: a caller walks every row at the address, and
	// HKDF on rows that were never a vault is work thrown away. Outside the try
	// all the same, so a wrong-sized key keeps its own error instead of being
	// relabelled as a failed decryption.
	const key = sealKey(requireWrapKey(s));
	try {
		// subarray, not slice: dropping the version byte must not copy a vault.
		return new TextDecoder().decode(await decryptChunk(key, bytes.subarray(1)));
	} catch {
		// GCM failing means the wrong key or a tampered row, and the two are
		// indistinguishable by design. Neither is "an empty vault".
		throw new VaultEnvelopeError('the vault did not open with this key');
	}
};

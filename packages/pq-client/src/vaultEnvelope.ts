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

export class VaultEnvelopeError extends Error {
	/** 'format' when the bytes are not a sealed value at all; 'key' when they are and did not open. */
	constructor(message: string, readonly reason: 'format' | 'key' = 'format') {
		super(message);
	}
}

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
 * S as two halves, S = nodeHalf XOR friendsHalf: the nodes hold one, the
 * guardians the other, and either alone is uniformly random — a guardian set
 * past its threshold still learns nothing without the node plane. The node
 * half is fresh randomness; the friends' half is what that leaves.
 */
export const splitIntoHalves = (s: Uint8Array): { nodeHalf: Uint8Array; friendsHalf: Uint8Array } => {
	requireWrapKey(s);
	const nodeHalf = randomBytes(32);
	return { nodeHalf, friendsHalf: s.map((b, i) => b ^ nodeHalf[i]) };
};

/** S from its two halves. */
export const joinHalves = (nodeHalf: Uint8Array, friendsHalf: Uint8Array): Uint8Array => {
	requireWrapKey(nodeHalf);
	requireWrapKey(friendsHalf);
	return nodeHalf.map((b, i) => b ^ friendsHalf[i]);
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

/**
 * The sealed form itself: `version(1) || nonce(12) || AES-256-GCM(text)`,
 * base64. The vault row uses it under a key derived from S; a device link
 * (lib/pq/deviceLink) uses it under a key two devices negotiated. One format,
 * so the structural check below cannot exist in one place and not the other.
 */
export const sealWithKey = async (key: Uint8Array, text: string): Promise<string> => {
	const blob = await encryptChunk(key, new TextEncoder().encode(text));
	const out = new Uint8Array(1 + blob.length);
	out[0] = SEAL_VERSION;
	out.set(blob, 1);
	return toBase64(out);
};

/**
 * Anything structural is answered before a key is blamed: "the key is wrong"
 * is the one diagnosis neither a recovery nor a device link can afford to give
 * falsely. Returns the bytes so the caller can derive its key only for values
 * that are worth deriving one for.
 */
export const assertSealed = (sealedB64: string, what = 'value'): Uint8Array => {
	let bytes: Uint8Array;
	try {
		bytes = toBytes(sealedB64);
	} catch {
		throw new VaultEnvelopeError(`not a sealed ${what}: unreadable value`);
	}
	// version(1) || nonce(12) || ciphertext || tag(16)
	if (bytes.length < 1 + 12 + 16 || bytes[0] !== SEAL_VERSION) {
		throw new VaultEnvelopeError(`not a sealed ${what}`);
	}
	return bytes;
};

export const openSealed = async (key: Uint8Array, bytes: Uint8Array, what = 'value'): Promise<string> => {
	try {
		// subarray, not slice: dropping the version byte must not copy a vault.
		return new TextDecoder().decode(await decryptChunk(key, bytes.subarray(1)));
	} catch {
		// GCM failing means the wrong key or tampered bytes, and the two are
		// indistinguishable by design. Neither is "an empty vault".
		throw new VaultEnvelopeError(`the ${what} did not open with this key`, 'key');
	}
};

/** The value_b64 of the vault row: the vault sealed under a key derived from S. */
export const sealVault = (vaultJson: string, s: Uint8Array): Promise<string> =>
	sealWithKey(sealKey(requireWrapKey(s)), vaultJson);

export const openVault = async (sealedB64: string, s: Uint8Array): Promise<string> => {
	// A row at this address may well belong to somebody else — a locator is
	// public the moment a share is handed out — so the structure is checked
	// first and the key derived only for a row that is a vault: a caller walks
	// every row at the address, and HKDF on the others is work thrown away.
	const bytes = assertSealed(sealedB64, 'vault');
	return openSealed(sealKey(requireWrapKey(s)), bytes, 'vault');
};

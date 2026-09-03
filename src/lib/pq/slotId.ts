// Addresses of well-known user_storage slots.
//
// user_storage is a generic key-value store keyed by (user_hash, uuid), and
// reads are public — pq_user_storage §2.2: "Any user can read any storage
// (read public), only owner can write". A slot address that is the same
// constant for every account therefore publishes metadata about every
// account: that the record exists, how large it is, and when it last changed.
// The value stays encrypted; its purpose and revision history do not.
//
// So the root address is derived from a secret only the owner holds. It is
// unpredictable without crypt_skey, identical on every device of that owner,
// and needs no registry to find. crypt_skey cannot rotate without changing
// identity in this protocol, so the address cannot drift.
//
// Every other slot gets a random uuid at creation and is reachable only
// through the map inside the root record — the same shape avatars already use
// (EncryptionManagerPQ stores avatarUuid inside the profile).

import { hkdfDerive } from './hkdf';

export const ROOT_SLOT_SALT = 'buckitup/user-storage-root/v1';
export const ROOT_SLOT_INFO = 'slot';

const hex = (b: number) => b.toString(16).padStart(2, '0');

/**
 * Formats 16 bytes as a UUID, forcing version 8 (RFC 9562 custom) and the
 * RFC 4122 variant. The server column is an Ecto.UUID and rejects anything
 * that is not canonical uuid text.
 */
export const bytesToUuidV8 = (bytes: Uint8Array): string => {
	if (bytes.length < 16) throw new RangeError('need at least 16 bytes for a uuid');
	const b = bytes.slice(0, 16);
	b[6] = (b[6] & 0x0f) | 0x80; // version 8
	b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
	const h = Array.from(b, hex).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * The account's root slot address. Holds the profile and the map of every
 * other slot, so it is the only address that has to be derivable rather than
 * looked up.
 */
export const deriveRootSlotUuid = (cryptSkey: Uint8Array): string => {
	if (!(cryptSkey instanceof Uint8Array) || cryptSkey.length === 0) {
		// Deriving from an absent key would silently produce one shared address
		// for every account that hit this path — the exact defect being fixed.
		throw new TypeError('deriveRootSlotUuid requires crypt_skey; is the vault unlocked?');
	}
	return bytesToUuidV8(hkdfDerive(cryptSkey, ROOT_SLOT_SALT, ROOT_SLOT_INFO, 16));
};

/** A fresh, unguessable address for a non-root slot. */
export const randomSlotUuid = (): string => crypto.randomUUID();

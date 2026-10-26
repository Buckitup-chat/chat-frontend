// Identities derived from secret keys instead of drawn at random
// (chat/docs/pq/reqs/pq_subaccounts.proposed.md, U4).
//
// Every device that holds the parent's secret keys arrives at the same
// identity, so it needs no storage and no syncing: notes to self are the first
// use (pq_notes_to_self.proposed.md § Identities). The derivation of each key
// is HKDF-SHA3-256 over the parent's keys with a family salt; `info` is a
// per-identity prefix (empty, or a note id) followed by the key's label.
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { hkdfDerive } from './hkdf.js';
import { signableFields } from './schema.js';
import { signFields, toBase64 } from './signature.js';
import type { UserCardRow } from './types.js';

export interface DerivedIdentity {
	userHash: string;
	signSkey: Uint8Array;
	signPkey: Uint8Array;
	cryptSkey: Uint8Array;
	cryptPkey: Uint8Array;
	contactSkey: Uint8Array;
	/** compressed secp256k1, 33 bytes */
	contactPkey: Uint8Array;
}

/** The parent's keys a derivation starts from. */
export interface ParentKeys {
	signSkey: Uint8Array;
	cryptSkey: Uint8Array;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * The identity of family `salt` and per-identity `prefix` under `parent`:
 * - ML-DSA-87 from a 32-byte seed (info prefix || "sign"),
 * - ML-KEM-1024 from a 64-byte seed (prefix || "crypt"),
 * - secp256k1 from 48 bytes reduced to a scalar in [1, n − 1] (prefix || "contact").
 */
export const deriveIdentity = (parent: ParentKeys, salt: string, prefix: Uint8Array = new Uint8Array(0)): DerivedIdentity => {
	const ikm = concatBytes(parent.signSkey, parent.cryptSkey);
	const seed = (label: string, length: number) => hkdfDerive(ikm, salt, concatBytes(prefix, utf8(label)), length);
	const sign = ml_dsa87.keygen(seed('sign', 32));
	const crypt = ml_kem1024.keygen(seed('crypt', 64));
	const contactSkey = secp.etc.hashToPrivateKey(seed('contact', 48));
	return {
		userHash: 'u_' + bytesToHex(sha3_512(sign.publicKey)),
		signSkey: sign.secretKey,
		signPkey: sign.publicKey,
		cryptSkey: crypt.secretKey,
		cryptPkey: crypt.publicKey,
		contactSkey,
		contactPkey: secp.getPublicKey(contactSkey, true),
	};
};

/**
 * The identity's `user_cards` row, certified and signed by its own key, as an
 * account's card is made at registration. Padded base64 binary columns.
 */
export const signedUserCard = (id: DerivedIdentity, name: string, ownerTimestamp: number): UserCardRow => {
	const row: UserCardRow = {
		user_hash: id.userHash,
		sign_pkey: toBase64(id.signPkey),
		crypt_pkey: toBase64(id.cryptPkey),
		crypt_cert: toBase64(ml_dsa87.sign(id.cryptPkey, id.signSkey)),
		contact_pkey: toBase64(id.contactPkey),
		contact_cert: toBase64(ml_dsa87.sign(id.contactPkey, id.signSkey)),
		name,
		deleted_flag: false,
		owner_timestamp: ownerTimestamp,
		sign_b64: null,
	};
	const fields = signableFields('user_cards', row as unknown as Record<string, unknown>);
	if (!fields) throw new Error('user card: a signable field is missing');
	row.sign_b64 = signFields(fields as never, id.signSkey);
	return row;
};

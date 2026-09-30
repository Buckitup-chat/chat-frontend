// A test identity shaped like an account's (src/libs/EncryptionManagerPQ.js
// createUserVault): an ML-DSA-87 identity key, an ML-KEM-1024 key, a
// secp256k1 contact key, both keys certified by the identity key, and a
// self-signed card in the format the server stores (src/api/client.js
// createUserCard). Kept in this browser's localStorage; nothing leaves the
// device except what the handshake sends.
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { signFields, toBase64, toBytes } from '@/lib/pq/signature';
import type { UserCardRow } from '@/lib/data/types';

export interface Identity {
	name: string;
	userHash: string;
	signPkey: Uint8Array;
	signSkey: Uint8Array;
	contactPkey: Uint8Array;
	contactSkey: Uint8Array;
	/** The signed card, as the server would hold it. */
	card: UserCardRow;
}

export const createIdentity = (name: string): Identity => {
	const sign = ml_dsa87.keygen(randomBytes(32));
	const crypt = ml_kem1024.keygen(randomBytes(64));
	const contactSkey = secp.utils.randomPrivateKey();
	const contactPkey = secp.getPublicKey(contactSkey, true);
	const userHash = 'u_' + bytesToHex(sha3_512(sign.publicKey));
	const contactCert = ml_dsa87.sign(contactPkey, sign.secretKey);
	const cryptCert = ml_dsa87.sign(crypt.publicKey, sign.secretKey);
	const ownerTimestamp = Math.floor(Date.now() / 1000);

	const signB64 = signFields({
		contact_cert: contactCert,
		contact_pkey: contactPkey,
		crypt_cert: cryptCert,
		crypt_pkey: crypt.publicKey,
		deleted_flag: false,
		name,
		owner_timestamp: ownerTimestamp,
		sign_pkey: sign.publicKey,
		user_hash: userHash,
	}, sign.secretKey);

	return {
		name,
		userHash,
		signPkey: sign.publicKey,
		signSkey: sign.secretKey,
		contactPkey,
		contactSkey,
		card: {
			user_hash: userHash,
			sign_pkey: toBase64(sign.publicKey),
			contact_pkey: toBase64(contactPkey),
			contact_cert: toBase64(contactCert),
			crypt_pkey: toBase64(crypt.publicKey),
			crypt_cert: toBase64(cryptCert),
			name,
			deleted_flag: false,
			owner_timestamp: ownerTimestamp,
			sign_b64: signB64,
		},
	};
};

interface StoredIdentity {
	name: string;
	userHash: string;
	signPkey: string;
	signSkey: string;
	contactPkey: string;
	contactSkey: string;
	card: UserCardRow;
}

export const serialize = (id: Identity): string => JSON.stringify({
	name: id.name,
	userHash: id.userHash,
	signPkey: toBase64(id.signPkey),
	signSkey: toBase64(id.signSkey),
	contactPkey: toBase64(id.contactPkey),
	contactSkey: toBase64(id.contactSkey),
	card: id.card,
} satisfies StoredIdentity);

export const deserialize = (raw: string): Identity => {
	const s = JSON.parse(raw) as StoredIdentity;
	return {
		name: s.name,
		userHash: s.userHash,
		signPkey: toBytes(s.signPkey),
		signSkey: toBytes(s.signSkey),
		contactPkey: toBytes(s.contactPkey),
		contactSkey: toBytes(s.contactSkey),
		card: s.card,
	};
};

/** The identity stored under `key`, or a new one saved there. */
export const loadOrCreate = (storage: Storage, key: string, name: () => string): Identity => {
	const raw = storage.getItem(key);
	if (raw) {
		try {
			return deserialize(raw);
		} catch {
			/* unreadable: replace it */
		}
	}
	const id = createIdentity(name());
	storage.setItem(key, serialize(id));
	return id;
};

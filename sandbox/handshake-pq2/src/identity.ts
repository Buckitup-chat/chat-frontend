// A test identity shaped like an account's (src/libs/EncryptionManagerPQ.js
// createUserVault): an ML-DSA-87 identity key, an ML-KEM-1024 key, a
// secp256k1 contact key, both keys certified by the identity key, and the
// self-signed card the app itself makes (api.createUserCard). It lives in the
// page only — its secret keys are never stored — and nothing leaves the
// device except what the handshake sends.
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { api } from '@/api/client';
import type { UserCardRow } from '@/lib/data/types';

export interface Identity {
	userHash: string;
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
	const { mutation } = api.createUserCard(name, {
		user_hash: userHash,
		sign_pkey: sign.publicKey,
		sign_skey: sign.secretKey,
		contact_pkey: contactPkey,
		contact_cert: ml_dsa87.sign(contactPkey, sign.secretKey),
		crypt_pkey: crypt.publicKey,
		crypt_cert: ml_dsa87.sign(crypt.publicKey, sign.secretKey),
	});
	// An insert carries the row in `modified`.
	const card = (mutation as { modified: UserCardRow }).modified;
	return { userHash, signSkey: sign.secretKey, contactPkey, contactSkey, card };
};

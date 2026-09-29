// A QR handshake proves the person in front of you holds some contact key; the
// certified card is what ties that key to the user_hash their QR named. A
// contact is confirmed only when both agree — otherwise anyone could show a
// friend's user_hash with their own key and be counted as met in person.
import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import * as secp from '@noble/secp256k1';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, toBase64 } from '@/lib/pq/signature';
import { cardVouchesForContactKey } from '@/lib/pq/verifyCard';

const identity = (seed: number) => {
	const sign = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	const kem = ml_kem1024.keygen(new Uint8Array(64).fill(seed));
	const contactPk = secp.getPublicKey(new Uint8Array(32).fill(seed), true);
	const card: Record<string, unknown> = {
		user_hash: 'u_' + bytesToHex(sha3_512(sign.publicKey)),
		sign_pkey: toBase64(sign.publicKey),
		crypt_pkey: toBase64(kem.publicKey),
		crypt_cert: toBase64(ml_dsa87.sign(kem.publicKey, sign.secretKey)),
		contact_pkey: toBase64(contactPk),
		contact_cert: toBase64(ml_dsa87.sign(contactPk, sign.secretKey)),
		name: `person-${seed}`,
		deleted_flag: false,
		owner_timestamp: 1_700_000_000,
	};
	card.sign_b64 = signFields(card as never, sign.secretKey);
	return { card, contactPkeyB64: toBase64(contactPk) };
};

describe('confirming a contact from a handshake', () => {
	it('holds when the key the handshake proved is the one the verified card certifies', () => {
		const alice = identity(3);
		expect(cardVouchesForContactKey(alice.card as never, alice.contactPkeyB64)).toBe(true);
	});

	it('fails for someone showing Alice\'s user_hash with their own key', () => {
		const alice = identity(3);
		const mallory = identity(4);
		expect(cardVouchesForContactKey(alice.card as never, mallory.contactPkeyB64)).toBe(false);
	});

	it('fails without a card, and with a card whose contact key is not certified by its owner', () => {
		const alice = identity(3);
		const mallory = identity(4);
		expect(cardVouchesForContactKey(undefined, alice.contactPkeyB64)).toBe(false);
		const swapped = { ...alice.card, contact_pkey: mallory.contactPkeyB64 };
		expect(cardVouchesForContactKey(swapped as never, mallory.contactPkeyB64)).toBe(false);
	});
});

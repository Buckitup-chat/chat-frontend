// Trust bootstrap: verifying a user_cards row.
//
// Every other verification starts here (invariants/02_integrity.md §Trust
// bootstrap). A card binds sign_pkey to user_hash with zero external state:
// the hash IS the key's digest, so it is recomputed, never believed. The card
// then vouches for itself with its own signature, and its certs bind the
// KEM/contact keys to the same identity.
//
// Server-side validation is not enough for this row of all rows: peer
// replication bypasses proof-of-possession, so a card must prove itself to
// every consumer independently of whoever served it.

import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { verifyFields, fromBase64 } from './signature';
import type { UserCardRow } from '@/lib/data/types';

export interface VerifiedCard {
	userHash: string;
	/** padded base64 — feed to verifyFields for dependent rows */
	signPkeyB64: string;
	name: string;
	deletedFlag: boolean;
}

export type CardVerdict =
	| { status: 'verified'; card: VerifiedCard }
	| { status: 'invalid'; reason: 'missing_fields' | 'hash_mismatch' | 'bad_signature' | 'bad_cert' };

const toB64 = (b: Uint8Array) => {
	let s = '';
	b.forEach((x) => (s += String.fromCharCode(x)));
	return btoa(s);
};

export const verifyUserCard = (row: UserCardRow): CardVerdict => {
	if (!row?.sign_pkey || !row.sign_b64 || !row.user_hash) {
		return { status: 'invalid', reason: 'missing_fields' };
	}

	let signPkey: Uint8Array;
	try {
		signPkey = fromBase64(row.sign_pkey);
	} catch {
		return { status: 'invalid', reason: 'missing_fields' };
	}

	// user_hash is derived, never asserted: recompute and compare.
	if (row.user_hash !== 'u_' + bytesToHex(sha3_512(signPkey))) {
		return { status: 'invalid', reason: 'hash_mismatch' };
	}

	// Self-signature over every column but sign_b64 itself.
	if (!verifyFields(row as never, row.sign_b64, signPkey)) {
		return { status: 'invalid', reason: 'bad_signature' };
	}

	// Certs are bare ML-DSA-87 signatures over the raw pubkey bytes — they
	// bind crypt/contact keys to this identity. A card with a broken cert
	// could smuggle in an attacker's KEM key under a victim's name.
	try {
		for (const [keyField, certField] of [
			['crypt_pkey', 'crypt_cert'],
			['contact_pkey', 'contact_cert'],
		] as const) {
			const key = row[keyField];
			const cert = row[certField];
			if (!key || !cert) return { status: 'invalid', reason: 'missing_fields' };
			if (!ml_dsa87.verify(fromBase64(cert), fromBase64(key), signPkey)) {
				return { status: 'invalid', reason: 'bad_cert' };
			}
		}
	} catch {
		return { status: 'invalid', reason: 'bad_cert' };
	}

	return {
		status: 'verified',
		card: {
			userHash: row.user_hash,
			signPkeyB64: toB64(signPkey),
			name: row.name,
			deletedFlag: !!row.deleted_flag,
		},
	};
};

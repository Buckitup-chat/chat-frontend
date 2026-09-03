// Canonical signature payload for PQ rows.
//
// Every signable row carries `sign_b64`: an ML-DSA-87 signature over a
// canonical serialization of its other fields (chat docs:
// invariants/02_integrity.md §Canonical serialization). Both sides must
// produce byte-identical payloads or every write is rejected, so this module
// is a deliberate mirror of the server's `Chat.Data.Integrity.signature_payload/1`
// (chat: lib/chat/data/integrity.ex). Change one, change the other.
//
// The rule: drop `sign_b64` and anything derived from it (`sign_hash`), sort
// the remaining fields lexicographically by column name, encode each by the
// suffix convention below, concatenate with no delimiter.
//
// This is the protocol layer — it knows nothing about transport, collections
// or stores. It signs and it verifies; callers decide which fields go in.

import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

/** A field value as it appears on a row headed for the wire. */
export type SignableValue = string | number | boolean | null | Uint8Array | Array<string | Uint8Array>;
export type SignableFields = Record<string, SignableValue>;

/**
 * Server-side `_hash` columns are backed by PrefixedHash Ecto types, so they
 * always hold "prefix_hexhex..." by the time they are signed. The server
 * raises on anything else rather than signing it; we mirror that (see
 * `encodeField`).
 */
const PREFIXED_HASH = /^[a-z][a-z0-9]*_[0-9a-f]+$/;

export const toBase64 = (bytes: Uint8Array): string => {
	let binary = '';
	bytes.forEach((b) => (binary += String.fromCharCode(b)));
	return btoa(binary);
};

export const fromBase64 = (b64: string): Uint8Array =>
	Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const encodeBase64Value = (value: SignableValue): string => {
	if (value === null || value === undefined) return 'null';
	// Rows carry these already base64-encoded (padded); raw bytes appear only
	// when signing a value that has not been through the wire yet.
	if (typeof value === 'string') return value;
	return toBase64(value as Uint8Array);
};

/**
 * Encodes one field exactly as the server does. Ordering of the checks
 * matters: the suffix conventions win over the value's own type, because a
 * `_b64` column holding a string is already-encoded base64, not a plain
 * string to pass through as text.
 */
export const encodeField = (key: string, value: SignableValue): string => {
	if (key.endsWith('_b64') || key.endsWith('_cert') || key.endsWith('_pkey')) {
		return encodeBase64Value(value);
	}

	if (key.endsWith('_hash')) {
		if (value === null || value === undefined) return 'null';
		if (typeof value === 'string' && PREFIXED_HASH.test(value)) return value;
		// Signing an unprefixed or empty `_hash` produces a payload the server
		// can never reproduce, so the write fails with a generic
		// "invalid_signature" far from its cause. Refusing here names the bug.
		// An empty string is the common case: a reaction or receipt built
		// against a message revision that has not been signed yet.
		throw new TypeError(
			`signable field "${key}" must hold a prefixed hex hash (e.g. "dms_1a2b…"), got ${JSON.stringify(value)}`,
		);
	}

	if (Array.isArray(value)) {
		// Binary arrays (files.chunk_sign_hashes) concatenate their elements'
		// base64 with no separator.
		return value.map((el) => (typeof el === 'string' ? el : toBase64(el))).join('');
	}

	if (value === true) return 'true';
	if (value === false) return 'false';
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number') return value.toString();
	if (typeof value === 'string') return value;
	return String(value);
};

/** Fields the signature never covers: the signature itself and what derives from it. */
const NOT_SIGNED = new Set(['sign_b64', 'sign_hash']);

/**
 * Builds the canonical payload string. Pass the row's signable fields; any
 * `sign_b64`/`sign_hash` present is dropped rather than trusted, so callers
 * can hand over a whole row without pre-filtering it.
 */
export const canonicalPayload = (fields: SignableFields): string =>
	Object.keys(fields)
		.filter((key) => !NOT_SIGNED.has(key))
		.sort()
		.map((key) => encodeField(key, fields[key]))
		.join('');

const payloadBytes = (fields: SignableFields): Uint8Array =>
	new TextEncoder().encode(canonicalPayload(fields));

/** Signs a row's fields, returning padded base64 ready for the `sign_b64` column. */
export const signFields = (fields: SignableFields, signSkey: Uint8Array): string =>
	toBase64(ml_dsa87.sign(payloadBytes(fields), signSkey));

/**
 * Verifies a row against the author's `sign_pkey`.
 *
 * This is the check the server runs on ingest — and the one a peer must run
 * again on receive, because peer replication bypasses proof-of-possession and
 * a row must prove itself independently of whoever served it
 * (invariants/02_integrity.md).
 *
 * Returns false rather than throwing on malformed input: an unverifiable row
 * is a normal event on a replicated stream, not an exceptional one.
 */
export const verifyFields = (
	fields: SignableFields,
	signB64: string | Uint8Array | null,
	signPkey: string | Uint8Array | null,
): boolean => {
	if (!signB64 || !signPkey) return false;
	try {
		const signature = typeof signB64 === 'string' ? fromBase64(signB64) : signB64;
		const pkey = typeof signPkey === 'string' ? fromBase64(signPkey) : signPkey;
		return ml_dsa87.verify(signature, payloadBytes(fields), pkey);
	} catch {
		return false;
	}
};

/**
 * Derives a version identity from a signature: prefix + hex(SHA3-512(sign_b64)).
 * Callers pass the row type's prefix — "dms_" for dialog message revisions,
 * "uss_" for user storage (invariants/03_data_versioning.md).
 */
export const deriveSignHash = (prefix: string, signB64: string | Uint8Array): string => {
	const bytes = typeof signB64 === 'string' ? fromBase64(signB64) : signB64;
	return prefix + bytesToHex(sha3_512(bytes));
};

import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import {
	canonicalPayload,
	encodeField,
	signFields,
	verifyFields,
	deriveSignHash,
	toBase64,
	padBase64,
} from '@/lib/pq/signature';

// The payload is a wire contract with the Elixir server
// (Chat.Data.Integrity.signature_payload/1). These vectors pin the exact
// string, so a well-meant refactor here fails loudly instead of turning every
// write into a server-side "invalid_signature".
describe('canonicalPayload — cross-implementation vectors', () => {
	it('sorts by column name and concatenates without delimiters', () => {
		// sorted: deleted_flag, name, owner_timestamp, user_hash
		expect(
			canonicalPayload({
				user_hash: 'u_ab',
				name: 'Bob',
				deleted_flag: false,
				owner_timestamp: 7,
			}),
		).toBe('falseBob7u_ab');
	});

	it('is insensitive to the order keys were inserted in', () => {
		const a = canonicalPayload({ z_col: 'z', a_col: 'a', m_col: 'm' });
		const b = canonicalPayload({ m_col: 'm', z_col: 'z', a_col: 'a' });
		expect(a).toBe(b);
		expect(a).toBe('amz');
	});

	it('drops sign_b64 and sign_hash — the signature cannot cover itself', () => {
		const withSig = canonicalPayload({
			name: 'Bob',
			sign_b64: 'AAAA',
			sign_hash: 'dms_beef',
		});
		expect(withSig).toBe(canonicalPayload({ name: 'Bob' }));
	});

	it('renders booleans, integers and nulls the way the server does', () => {
		expect(canonicalPayload({ a: true, b: false, c: null, d: 42 })).toBe('truefalsenull42');
	});
});

describe('encodeField — suffix conventions', () => {
	it('passes an already-encoded _b64 string through unchanged', () => {
		expect(encodeField('content_b64', 'q80BAg==')).toBe('q80BAg==');
	});

	it('base64-encodes raw bytes in _pkey / _cert / _b64 columns, padded', () => {
		const bytes = new Uint8Array([171, 205, 1, 2]);
		expect(encodeField('sign_pkey', bytes)).toBe('q80BAg==');
		expect(encodeField('crypt_cert', bytes)).toBe('q80BAg==');
		expect(encodeField('value_b64', bytes)).toBe('q80BAg==');
	});

	it('encodes a null binary column as "null", not as an empty string', () => {
		expect(encodeField('content_b64', null)).toBe('null');
		expect(encodeField('parent_sign_hash', null)).toBe('null');
	});

	it('passes a prefixed hex hash through verbatim', () => {
		const hash = 'dms_' + 'a'.repeat(128);
		expect(encodeField('parent_sign_hash', hash)).toBe(hash);
	});

	it('concatenates array elements as base64 (files.chunk_sign_hashes)', () => {
		expect(encodeField('chunk_sign_hashes', [new Uint8Array([171, 205]), new Uint8Array([1, 2])])).toBe(
			'q80=' + 'AQI=',
		);
	});

	// The server raises rather than signing a malformed _hash. Mirroring that
	// catches a real bug class at the door: a reaction or receipt built
	// against a message revision that has not been signed yet carries
	// message_sign_hash = '', which would otherwise be signed silently and
	// rejected remotely with no hint at the cause.
	it('refuses an empty _hash instead of signing an unreproducible payload', () => {
		expect(() => encodeField('message_sign_hash', '')).toThrow(/prefixed hex hash/);
	});

	it('refuses an unprefixed _hash', () => {
		expect(() => encodeField('message_sign_hash', 'a'.repeat(128))).toThrow(/prefixed hex hash/);
	});
});

describe('sign / verify round trip', () => {
	const keys = ml_dsa87.keygen(new Uint8Array(32).fill(7));
	const row = {
		user_hash: 'u_' + 'a'.repeat(128),
		name: 'Alice',
		deleted_flag: false,
		owner_timestamp: 1_717_000_000,
	};

	it('verifies a signature it produced', () => {
		const signB64 = signFields(row, keys.secretKey);
		expect(verifyFields(row, signB64, toBase64(keys.publicKey))).toBe(true);
	});

	it('accepts raw byte arguments as well as base64', () => {
		const signB64 = signFields(row, keys.secretKey);
		expect(verifyFields(row, signB64, keys.publicKey)).toBe(true);
	});

	// Tampering with any signed field must break the signature — this is the
	// property the whole trust model rests on (invariants/02_integrity.md).
	it('rejects a row whose field was altered after signing', () => {
		const signB64 = signFields(row, keys.secretKey);
		expect(verifyFields({ ...row, name: 'Mallory' }, signB64, keys.publicKey)).toBe(false);
	});

	it('rejects a replayed row whose owner_timestamp was rewritten', () => {
		const signB64 = signFields(row, keys.secretKey);
		expect(verifyFields({ ...row, owner_timestamp: 1_717_000_001 }, signB64, keys.publicKey)).toBe(false);
	});

	it('rejects a signature made by a different key', () => {
		const other = ml_dsa87.keygen(new Uint8Array(32).fill(9));
		const signB64 = signFields(row, other.secretKey);
		expect(verifyFields(row, signB64, keys.publicKey)).toBe(false);
	});

	it('returns false rather than throwing on missing or malformed input', () => {
		expect(verifyFields(row, null, keys.publicKey)).toBe(false);
		expect(verifyFields(row, 'AAAA', keys.publicKey)).toBe(false);
	});
});

describe('deriveSignHash', () => {
	const signB64 = toBase64(new Uint8Array([1, 2, 3]));

	it('is prefix + hex(SHA3-512(raw signature bytes))', () => {
		expect(deriveSignHash('dms_', signB64)).toBe('dms_' + bytesToHex(sha3_512(new Uint8Array([1, 2, 3]))));
	});

	it('produces the shape the server CHECK constraint enforces', () => {
		expect(deriveSignHash('dms_', signB64)).toMatch(/^dms_[a-f0-9]{128}$/);
		expect(deriveSignHash('uss_', signB64)).toMatch(/^uss_[a-f0-9]{128}$/);
	});
});

// The Electric shape endpoint serves binary columns as unpadded base64 while
// the payload the server signed used padded base64. Confirmed against
// buckitup.xyz: 30 of 30 live user_cards fail verification as served and pass
// once repadded. Without normalization every replicated row would look forged.
describe('base64 padding on the read path', () => {
	it('restores stripped padding', () => {
		expect(padBase64('q80BAg')).toBe('q80BAg==');
		expect(padBase64('q80B')).toBe('q80B');
		expect(padBase64('q80=')).toBe('q80=');
	});

	it('encodes a stripped and a padded binary column identically', () => {
		expect(encodeField('crypt_pkey', 'q80BAg')).toBe(encodeField('crypt_pkey', 'q80BAg=='));
	});

	it('verifies a row whose binary columns arrived unpadded', () => {
		const keys = ml_dsa87.keygen(new Uint8Array(32).fill(3));
		// 4 bytes -> base64 with padding; the wire form drops it
		const blob = new Uint8Array([171, 205, 1, 2]);
		const signed = { user_hash: 'u_ab', crypt_pkey: blob, owner_timestamp: 1 };
		const signB64 = signFields(signed, keys.secretKey);

		const asServed = {
			user_hash: 'u_ab',
			crypt_pkey: toBase64(blob).replace(/=+$/, ''),
			owner_timestamp: 1,
		};
		expect(verifyFields(asServed, signB64.replace(/=+$/, ''), toBase64(keys.publicKey).replace(/=+$/, ''))).toBe(true);
	});
});

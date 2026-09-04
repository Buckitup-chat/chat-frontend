// Cross-implementation conformance vectors.
//
// The wire contract between this client and the Elixir backend is a set of
// byte-exact derivations: the canonical signature payload, the prefixed
// hashes, HKDF. It has broken twice already on one-byte differences (base64
// padding, "" vs null), both times caught only against the live server. The
// vectors pin those bytes as data, so BOTH implementations assert the same
// file: this test runs them against src/lib/pq, and the copy in the backend
// repo (docs/pq/conformance/vectors.json + test/chat/pq_conformance_test.exs)
// runs them against Chat.Data.Integrity and EnigmaPq.
//
// Regenerate after a deliberate protocol change:
//   WRITE_VECTORS=1 npx vitest run tests/pqConformance.test.ts
// and carry the new file to the backend repo in the same change. A vector
// difference that was not deliberate is a broken client-server contract.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sha3_512 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex } from '@noble/hashes/utils';
import { canonicalPayload, deriveSignHash, toBase64 } from '@/lib/pq/signature';
import { signableFields, SIGNABLE } from '@/lib/pq/schema';
import { hkdfDerive } from '@/lib/pq/hkdf';
import { DialogCrypto } from '@/libs/DialogCrypto';

const VECTORS_PATH = path.join(__dirname, 'vectors', 'pq-conformance.json');

// Deterministic byte patterns — recognizable, никакой криптографии не нужно:
// the payload contract is about ENCODING bytes, not about their meaning.
const bytes = (len: number, seed: number) =>
	Uint8Array.from({ length: len }, (_, i) => (i * 7 + seed) % 251);
const hex128 = (ch: string) => ch.repeat(128);

type FieldSpec =
	| { t: 'b64'; v: string }
	| { t: 'b64[]'; v: string[] }
	| { t: 'str'; v: string }
	| { t: 'int'; v: number }
	| { t: 'bool'; v: boolean }
	| { t: 'null' };

interface PayloadCase {
	name: string;
	relation: string;
	fields: Record<string, FieldSpec>;
	expected_payload: string;
}

const toValue = (spec: FieldSpec): unknown => {
	switch (spec.t) {
		case 'b64': return spec.v;
		case 'b64[]': return spec.v;
		case 'str': return spec.v;
		case 'int': return spec.v;
		case 'bool': return spec.v;
		case 'null': return null;
	}
};

const rowOf = (fields: Record<string, FieldSpec>): Record<string, unknown> =>
	Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, toValue(s)]));

// ---------- the cases ----------

const b64 = (len: number, seed: number) => toBase64(bytes(len, seed));

const payloadCases: Omit<PayloadCase, 'expected_payload'>[] = [
	{
		name: 'user_cards: unicode name, false flag',
		relation: 'user_cards',
		fields: {
			user_hash: { t: 'str', v: 'u_' + hex128('a') },
			sign_pkey: { t: 'b64', v: b64(2592, 1) },
			contact_pkey: { t: 'b64', v: b64(33, 2) },
			contact_cert: { t: 'b64', v: b64(70, 3) },
			crypt_pkey: { t: 'b64', v: b64(1568, 4) }, // 1568 % 3 != 0: the padding case
			crypt_cert: { t: 'b64', v: b64(70, 5) },
			name: { t: 'str', v: 'Аркадий 🚀' },
			deleted_flag: { t: 'bool', v: false },
			owner_timestamp: { t: 'int', v: 1788467407 },
		},
	},
	{
		name: 'user_cards: tombstoned',
		relation: 'user_cards',
		fields: {
			user_hash: { t: 'str', v: 'u_' + hex128('b') },
			sign_pkey: { t: 'b64', v: b64(2592, 6) },
			contact_pkey: { t: 'b64', v: b64(33, 7) },
			contact_cert: { t: 'b64', v: b64(70, 8) },
			crypt_pkey: { t: 'b64', v: b64(1568, 9) },
			crypt_cert: { t: 'b64', v: b64(70, 10) },
			name: { t: 'str', v: 'x' },
			deleted_flag: { t: 'bool', v: true },
			owner_timestamp: { t: 'int', v: 1788467500 },
		},
	},
	{
		name: 'user_storage: first revision (null parent)',
		relation: 'user_storage',
		fields: {
			user_hash: { t: 'str', v: 'u_' + hex128('c') },
			uuid: { t: 'str', v: '85da8ea0-5bc8-856e-83e7-db7b542a1a58' },
			value_b64: { t: 'b64', v: b64(100, 11) },
			deleted_flag: { t: 'bool', v: false },
			parent_sign_hash: { t: 'null' },
			owner_timestamp: { t: 'int', v: 42 },
		},
	},
	{
		name: 'user_storage: chained revision',
		relation: 'user_storage',
		fields: {
			user_hash: { t: 'str', v: 'u_' + hex128('c') },
			uuid: { t: 'str', v: '85da8ea0-5bc8-856e-83e7-db7b542a1a58' },
			value_b64: { t: 'b64', v: b64(100, 12) },
			deleted_flag: { t: 'bool', v: false },
			parent_sign_hash: { t: 'str', v: 'uss_' + hex128('d') },
			owner_timestamp: { t: 'int', v: 43 },
		},
	},
	{
		name: 'dialog_messages: genesis',
		relation: 'dialog_messages',
		fields: {
			message_id: { t: 'str', v: 'dmsg_01990c8e-1a2b-7c3d-8e4f-501234567890' },
			dialog_hash: { t: 'str', v: 'di_' + hex128('e') },
			sender_hash: { t: 'str', v: 'u_' + hex128('a') },
			content_b64: { t: 'b64', v: b64(64, 13) },
			deleted_flag: { t: 'bool', v: false },
			refs_map_b64: { t: 'b64', v: b64(40, 14) },
			parent_sign_hash: { t: 'null' },
			owner_timestamp: { t: 'int', v: 1788467452 },
		},
	},
	{
		name: 'dialog_messages: tombstone (null content, chained)',
		relation: 'dialog_messages',
		fields: {
			message_id: { t: 'str', v: 'dmsg_01990c8e-1a2b-7c3d-8e4f-501234567890' },
			dialog_hash: { t: 'str', v: 'di_' + hex128('e') },
			sender_hash: { t: 'str', v: 'u_' + hex128('a') },
			content_b64: { t: 'null' },
			deleted_flag: { t: 'bool', v: true },
			refs_map_b64: { t: 'b64', v: b64(40, 15) },
			parent_sign_hash: { t: 'str', v: 'dms_' + hex128('f') },
			owner_timestamp: { t: 'int', v: 1788467999 },
		},
	},
	{
		name: 'dialog_keys',
		relation: 'dialog_keys',
		fields: {
			dialog_hash: { t: 'str', v: 'di_' + hex128('e') },
			sender_hash: { t: 'str', v: 'u_' + hex128('a') },
			peer_hash: { t: 'str', v: 'u_' + hex128('b') },
			peer_kem_wrap_key_b64: { t: 'b64', v: b64(1568, 16) },
			peer_wrapped_msg_key_b64: { t: 'b64', v: b64(60, 17) },
			owner_timestamp: { t: 'int', v: 1788467400 },
			deleted_flag: { t: 'bool', v: false },
		},
	},
	{
		name: 'dialog_message_reactions',
		relation: 'dialog_message_reactions',
		fields: {
			reaction_hash: { t: 'str', v: 'dmr_' + hex128('1') },
			dialog_hash: { t: 'str', v: 'di_' + hex128('e') },
			message_id: { t: 'str', v: 'dmsg_01990c8e-1a2b-7c3d-8e4f-501234567890' },
			message_sign_hash: { t: 'str', v: 'dms_' + hex128('2') },
			reactor_hash: { t: 'str', v: 'u_' + hex128('b') },
			type_b64: { t: 'b64', v: b64(20, 18) },
			deleted_flag: { t: 'bool', v: false },
			owner_timestamp: { t: 'int', v: 7 },
		},
	},
	{
		name: 'dialog_message_receipts (no deleted_flag by design)',
		relation: 'dialog_message_receipts',
		fields: {
			receipt_hash: { t: 'str', v: 'dmrc_' + hex128('3') },
			dialog_hash: { t: 'str', v: 'di_' + hex128('e') },
			message_id: { t: 'str', v: 'dmsg_01990c8e-1a2b-7c3d-8e4f-501234567890' },
			peer_hash: { t: 'str', v: 'u_' + hex128('b') },
			type: { t: 'str', v: 'read' },
			message_sign_hash: { t: 'str', v: 'dms_' + hex128('2') },
			owner_timestamp: { t: 'int', v: 9 },
		},
	},
	{
		name: 'files: chunk_sign_hashes array concatenates as base64',
		relation: 'files',
		fields: {
			file_id: { t: 'str', v: 'f_' + '0123456789abcdef'.repeat(2) },
			uploader_hash: { t: 'str', v: 'u_' + hex128('a') },
			total_size: { t: 'int', v: 4294401 },
			chunk_size: { t: 'int', v: 4194304 },
			chunk_count: { t: 'int', v: 2 },
			chunk_sign_hashes: { t: 'b64[]', v: [b64(64, 19), b64(64, 20)] },
			owner_timestamp: { t: 'int', v: 1788468000 },
			deleted_flag: { t: 'bool', v: false },
		},
	},
];

interface HashCase {
	name: string;
	kind: 'sign_hash' | 'dialog_hash' | 'receipt_hash' | 'reaction_hash' | 'hkdf' | 'hmac_sha3_512';
	input: Record<string, unknown>;
	expected: string;
}

const buildHashCases = (): HashCase[] => {
	const sig = bytes(4627, 21); // ML-DSA-87 signature length
	const key = bytes(32, 22);
	const ikm = bytes(64, 23);
	const uA = 'u_' + hex128('b'); // deliberately unsorted input order
	const uB = 'u_' + hex128('a');
	return [
		{
			name: 'sign_hash: dms_ prefix over raw signature bytes',
			kind: 'sign_hash',
			input: { prefix: 'dms_', sign_b64: toBase64(sig) },
			expected: deriveSignHash('dms_', toBase64(sig)),
		},
		{
			name: 'sign_hash: uss_ prefix',
			kind: 'sign_hash',
			input: { prefix: 'uss_', sign_b64: toBase64(sig) },
			expected: deriveSignHash('uss_', toBase64(sig)),
		},
		{
			name: 'dialog_hash: sorted participants',
			kind: 'dialog_hash',
			input: { user_a: uA, user_b: uB },
			expected: DialogCrypto.computeDialogHash(uA, uB),
		},
		{
			name: 'receipt_hash: plain SHA3-512 over concatenation',
			kind: 'receipt_hash',
			input: {
				message_id: 'dmsg_01990c8e-1a2b-7c3d-8e4f-501234567890',
				message_sign_hash: 'dms_' + hex128('2'),
				peer_hash: 'u_' + hex128('b'),
				type: 'read',
			},
			expected: DialogCrypto.computeReceiptHash(
				'dmsg_01990c8e-1a2b-7c3d-8e4f-501234567890', 'dms_' + hex128('2'), 'u_' + hex128('b'), 'read'),
		},
		{
			name: 'reaction_hash: keyed HMAC-SHA3-512',
			kind: 'reaction_hash',
			input: {
				key_b64: toBase64(key),
				message_id: 'dmsg_01990c8e-1a2b-7c3d-8e4f-501234567890',
				reactor_hash: 'u_' + hex128('b'),
				type_plaintext: '🔥',
			},
			expected: DialogCrypto.computeReactionHash(
				key, 'dmsg_01990c8e-1a2b-7c3d-8e4f-501234567890', 'u_' + hex128('b'), '🔥'),
		},
		{
			name: 'hkdf-sha3-256: one block',
			kind: 'hkdf',
			input: { ikm_b64: toBase64(ikm), salt: 'buckitup/dialog-mk/v1', info: 'dialog-mk', length: 32 },
			expected: toBase64(hkdfDerive(ikm, 'buckitup/dialog-mk/v1', 'dialog-mk', 32)),
		},
		{
			name: 'hkdf-sha3-256: two blocks',
			kind: 'hkdf',
			input: { ikm_b64: toBase64(ikm), salt: 'buckitup/test/v1', info: 'expand', length: 64 },
			expected: toBase64(hkdfDerive(ikm, 'buckitup/test/v1', 'expand', 64)),
		},
		{
			name: 'hmac-sha3-512 building block',
			kind: 'hmac_sha3_512',
			input: { key_b64: toBase64(key), data: 'conformance' },
			expected: bytesToHex(hmac(sha3_512, key, new TextEncoder().encode('conformance'))),
		},
	];
};

// ---------- generate or verify ----------

const buildVectors = () => ({
	version: 1,
	source: 'chat-frontend tests/pqConformance.test.ts — regenerate with WRITE_VECTORS=1',
	payload_cases: payloadCases.map((c) => ({
		...c,
		expected_payload: canonicalPayload(rowOf(c.fields) as never),
	})),
	hash_cases: buildHashCases(),
});

describe('PQ conformance vectors', () => {
	if (process.env.WRITE_VECTORS === '1') {
		it('writes the vector file', () => {
			fs.mkdirSync(path.dirname(VECTORS_PATH), { recursive: true });
			fs.writeFileSync(VECTORS_PATH, JSON.stringify(buildVectors(), null, '\t') + '\n');
			expect(fs.existsSync(VECTORS_PATH)).toBe(true);
		});
		return;
	}

	const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8')) as ReturnType<typeof buildVectors>;

	it('the committed file matches this implementation exactly', () => {
		// Any drift — a payload rule change, a new case — must be a deliberate
		// regeneration carried to the backend repo in the same change.
		expect(buildVectors()).toEqual(vectors);
	});

	for (const c of vectors.payload_cases) {
		it(`payload: ${c.name}`, () => {
			expect(canonicalPayload(rowOf(c.fields as Record<string, FieldSpec>) as never)).toBe(c.expected_payload);
		});
	}

	it('signable field sets match the schema module where one exists', () => {
		for (const c of vectors.payload_cases) {
			const schema = SIGNABLE[c.relation];
			if (!schema) continue;
			const row = rowOf(c.fields as Record<string, FieldSpec>);
			const filtered = signableFields(c.relation, row);
			expect(filtered, c.relation).not.toBe(null);
			expect(Object.keys(filtered!).sort()).toEqual(Object.keys(row).sort());
		}
	});

	for (const h of vectors.hash_cases) {
		it(`hash: ${h.name}`, () => {
			switch (h.kind) {
				case 'sign_hash':
					expect(deriveSignHash(h.input.prefix as string, h.input.sign_b64 as string)).toBe(h.expected);
					break;
				case 'dialog_hash':
					expect(DialogCrypto.computeDialogHash(h.input.user_a as string, h.input.user_b as string)).toBe(h.expected);
					break;
				case 'receipt_hash':
					expect(DialogCrypto.computeReceiptHash(
						h.input.message_id as string, h.input.message_sign_hash as string,
						h.input.peer_hash as string, h.input.type as string)).toBe(h.expected);
					break;
				case 'reaction_hash': {
					const key = Uint8Array.from(atob(h.input.key_b64 as string), (ch) => ch.charCodeAt(0));
					expect(DialogCrypto.computeReactionHash(
						key, h.input.message_id as string, h.input.reactor_hash as string,
						h.input.type_plaintext as string)).toBe(h.expected);
					break;
				}
				case 'hkdf': {
					const ikm = Uint8Array.from(atob(h.input.ikm_b64 as string), (ch) => ch.charCodeAt(0));
					expect(toBase64(hkdfDerive(ikm, h.input.salt as string, h.input.info as string, h.input.length as number))).toBe(h.expected);
					break;
				}
				case 'hmac_sha3_512': {
					const key = Uint8Array.from(atob(h.input.key_b64 as string), (ch) => ch.charCodeAt(0));
					expect(bytesToHex(hmac(sha3_512, key, new TextEncoder().encode(h.input.data as string)))).toBe(h.expected);
					break;
				}
			}
		});
	}
});

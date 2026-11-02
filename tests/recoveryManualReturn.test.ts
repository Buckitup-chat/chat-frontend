// A share returned by hand (pq_recovery_shares § Manual return): sealed to
// the temporary account's ML-KEM key, signed by the guardian, and opened only
// after the six digits both screens derive have been compared. Real ML-KEM,
// ML-DSA and AES-GCM; the digits are recomputed here from HMAC-SHA3-256.
import { describe, it, expect } from 'vitest';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { hmac } from '@noble/hashes/hmac';
import { sha3_256 } from '@noble/hashes/sha3';
import { sixDigitCode, DEVICE_LINK_SALT } from '@buckitup/pq-client/deviceLink';
import {
	RECOVERY_RETURN_SALT,
	ManualReturnError,
	bindingText,
	blockSignedBy,
	parseBindingText,
	parseReturnBlock,
	readReturnBlock,
	sealReturnBlock,
} from '@/lib/recovery/manualReturn';
import type { RecoveryShareReturnPart } from '@buckitup/pq-client/content';

const REF = 'eip155:11155111:0xd9ffd20f2db9c774b9f0237c4837f52dcbd937a7/0x' + '9f'.repeat(32);
const GUARDIAN = 'u_' + 'a'.repeat(128);
const part: RecoveryShareReturnPart = {
	kind: 'recovery_share_return',
	secretRef: REF,
	version: 2,
	splitId: '4f'.repeat(16),
	threshold: 2,
	total: 3,
	shareIndex: 1,
	round: 5,
	candidate: '0x' + '5a'.repeat(20),
	shareB64: 'CAEC',
	createdAt: 1715600000,
	splitProof: [],
	nodeSet: { threshold: 2, nodes: [] },
};

const utf8 = (s: string) => new TextEncoder().encode(s);
/** HKDF-SHA3-256 written out, independent of lib/pq/hkdf: extract, then one expand block. */
const hkdf4 = (ikm: Uint8Array, salt: string, info: string) => hmac(sha3_256, hmac(sha3_256, utf8(salt), ikm), new Uint8Array([...utf8(info), 1])).slice(0, 4);

const temp = ml_kem1024.keygen();
const signer = ml_dsa87.keygen(new Uint8Array(32).fill(7));
const sign = (bytes: Uint8Array) => ml_dsa87.sign(bytes, signer.secretKey);
const decapsulate = (ct: Uint8Array) => ml_kem1024.decapsulate(ct, temp.secretKey);

describe('the six digits', () => {
	it('are four bytes of HKDF-SHA3-256 under the salt, big-endian, mod 10^6 — the device-link derivation', () => {
		const ss = new Uint8Array(32).map((_, i) => i);
		for (const [salt, info] of [[RECOVERY_RETURN_SALT, `sas|${REF}`], [DEVICE_LINK_SALT, 'sas|room']]) {
			const t = hkdf4(ss, salt, info);
			const n = ((t[0] << 24) | (t[1] << 16) | (t[2] << 8) | t[3]) >>> 0;
			expect(sixDigitCode(ss, salt, info)).toBe(String(n % 1_000_000).padStart(6, '0'));
		}
		// Pinned, so a change to the derivation shows as a change of this value.
		expect(sixDigitCode(ss, RECOVERY_RETURN_SALT, `sas|${REF}`)).toBe('614469');
		expect(sixDigitCode(ss, DEVICE_LINK_SALT, 'sas|room')).toBe('759005');
		expect(sixDigitCode(ss, RECOVERY_RETURN_SALT, 'sas|x')).not.toBe(sixDigitCode(ss, DEVICE_LINK_SALT, 'sas|x'));
	});
});

describe('a block', () => {
	it('opens on the temporary account, with the guardian\'s digits, once they are confirmed', async () => {
		const { block, digits } = await sealReturnBlock({ cryptPkey: temp.publicKey, part, guardianUserHash: GUARDIAN, sign });
		expect(digits).toMatch(/^\d{6}$/);
		// A messenger wrapped the line and added spaces.
		const wrapped = block.replace(/(.{80})/g, '$1\n  ');
		const parsed = parseReturnBlock(wrapped);
		expect(parsed.guardian).toBe(GUARDIAN);
		expect(blockSignedBy(parsed, signer.publicKey)).toBe(true);
		const read = await readReturnBlock(parsed, REF, decapsulate);
		expect(read.digits).toBe(digits);
		expect(await read.open()).toEqual(part);
	});

	it('gives other digits when someone else encapsulated it, and opens nothing for another device', async () => {
		const { digits } = await sealReturnBlock({ cryptPkey: temp.publicKey, part, guardianUserHash: GUARDIAN, sign });
		// A relay swapped in a block of its own, to the same key: the digits differ (2^-20 aside).
		const forged = await sealReturnBlock({ cryptPkey: temp.publicKey, part: { ...part, shareB64: 'CAEE' }, guardianUserHash: GUARDIAN, sign });
		const readForged = await readReturnBlock(parseReturnBlock(forged.block), REF, decapsulate);
		expect(readForged.digits).not.toBe(digits);
		// A block made for another temporary account does not open on this one.
		const other = ml_kem1024.keygen();
		const elsewhere = await sealReturnBlock({ cryptPkey: other.publicKey, part, guardianUserHash: GUARDIAN, sign });
		const read = await readReturnBlock(parseReturnBlock(elsewhere.block), REF, decapsulate);
		await expect(read.open()).rejects.toThrow(ManualReturnError);
	});

	it('derives its key and digits from the secret it is for', async () => {
		const { block, digits } = await sealReturnBlock({ cryptPkey: temp.publicKey, part, guardianUserHash: GUARDIAN, sign });
		const read = await readReturnBlock(parseReturnBlock(block), REF.replace('9f', '9e'), decapsulate);
		expect(read.digits).not.toBe(digits);
		await expect(read.open()).rejects.toThrow(/made for another/);
	});

	it('is not opened once put aside', async () => {
		const { block } = await sealReturnBlock({ cryptPkey: temp.publicKey, part, guardianUserHash: GUARDIAN, sign });
		const read = await readReturnBlock(parseReturnBlock(block), REF, decapsulate);
		read.forget();
		await expect(read.open()).rejects.toThrow(ManualReturnError);
	});

	it('is refused when damaged, and its signature covers the guardian it names', async () => {
		const { block } = await sealReturnBlock({ cryptPkey: temp.publicKey, part, guardianUserHash: GUARDIAN, sign });
		expect(() => parseReturnBlock('hello')).toThrow(ManualReturnError);
		expect(() => parseReturnBlock(block.split('.').slice(0, 4).join('.'))).toThrow(ManualReturnError);
		const segs = block.split('.');
		expect(() => parseReturnBlock([segs[0], segs[1].slice(8), ...segs.slice(2)].join('.'))).toThrow(/damaged/);
		const renamed = parseReturnBlock([...segs.slice(0, 3), 'u_' + 'b'.repeat(128), segs[4]].join('.'));
		expect(blockSignedBy(renamed, signer.publicKey)).toBe(false);
		expect(blockSignedBy(parseReturnBlock(block), ml_dsa87.keygen(new Uint8Array(32).fill(8)).publicKey)).toBe(false);
	});
});

describe('the binding as text', () => {
	it('round-trips, whitespace forgiven, and refuses anything else', () => {
		const b = { kind: 'recovery_binding' as const, secretRef: REF, candidate: '0x' + '5a'.repeat(20), userHash: 'u_' + 'c'.repeat(128), signatureB64: 'qy9NRNn6+/AA' };
		expect(parseBindingText(` ${bindingText(b)}\n`)).toEqual(b);
		expect(() => parseBindingText('BUCKITUP-SHARE.a.b.c.d')).toThrow(ManualReturnError);
		expect(() => parseBindingText(bindingText(b) + '.x')).toThrow(ManualReturnError);
	});
});

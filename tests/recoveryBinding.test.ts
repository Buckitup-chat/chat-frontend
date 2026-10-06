// The binding a recovering account sends a guardian, and the ten words both
// screens show (pq_recovery_shares § Returning, step 3). Pinned values are
// computed outside the module: noble's secp256k1 and keccak, @scure/bip39's list.
import { describe, it, expect } from 'vitest';
import { canonicalCandidate, checkBinding, recoveryWords, signBinding } from '@/lib/recovery/recoveryBinding';

const candidateKey = '0x' + '11'.repeat(32);
const candidate = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
const secretRef = 'eip155:10:0x45907bd5636ccece1819fcd6433dec71c78f3bb3/0x' + '9f'.repeat(32);
const temp = 'u_' + 'c'.repeat(128);

describe('the binding', () => {
	const binding = () => ({ secretRef, candidate, userHash: temp, signatureB64: signBinding(candidateKey, secretRef, temp) });

	it('is signed by the candidate key, pinned', () => {
		expect(binding().signatureB64).toBe('qy9NRNn6FqR69EI5M9GqAWifIkz8W1j+j0UCh5ZVcOU6AYUN4z1Q0lKXvSmHmNbbfw5rcH2VZ8tmoKmqaZHlWRw');
	});

	const asked = { secretRef, dialogPeerUserHash: temp };

	it('passes for the secret asked about and the dialog peer it names, and gives the candidate canonical', () => {
		expect(checkBinding(binding(), asked)).toBe(candidate);
		expect(checkBinding({ ...binding(), candidate: candidate.toUpperCase().replace('0X', '0x') }, asked)).toBe(candidate);
	});

	it('is refused from another account, for another candidate, or another secret', () => {
		expect(() => checkBinding(binding(), { ...asked, dialogPeerUserHash: 'u_' + 'd'.repeat(128) })).toThrow(/another account/);
		expect(() => checkBinding({ ...binding(), candidate: '0x' + '22'.repeat(20) }, asked)).toThrow(/not signed by the candidate/);
		expect(() => checkBinding({ ...binding(), secretRef: secretRef.replace('9f', '9e') }, asked)).toThrow(/another secret/);
		expect(() => checkBinding({ ...binding(), signatureB64: 'AAAA' }, asked)).toThrow(/not signed by the candidate/);
	});

	it('is refused when it answers another secret, even signed correctly for that one', () => {
		// A binding made for secret B must not carry an approval for secret A.
		const other = secretRef.replace('9f', '9e');
		const forOther = { secretRef: other, candidate, userHash: temp, signatureB64: signBinding(candidateKey, other, temp) };
		expect(() => checkBinding(forOther, asked)).toThrow(/another secret/);
	});
});

describe('the ten words', () => {
	it('are pinned, and the same whatever case the candidate arrives in', () => {
		const words = 'guitar series enemy pet clean action dream bargain tired sudden'.split(' ');
		expect(recoveryWords(secretRef, candidate, temp)).toEqual(words);
		expect(recoveryWords(secretRef, candidate.toUpperCase().replace('0X', '0x'), temp)).toEqual(words);
	});

	it('change with any of the three things they cover', () => {
		const words = recoveryWords(secretRef, candidate, temp).join(' ');
		expect(recoveryWords(secretRef, '0x' + '22'.repeat(20), temp).join(' ')).not.toBe(words);
		expect(recoveryWords(secretRef, candidate, 'u_' + 'd'.repeat(128)).join(' ')).not.toBe(words);
		expect(recoveryWords(secretRef.replace('9f', '9e'), candidate, temp).join(' ')).not.toBe(words);
	});

	it('refuse a secret_ref or user_hash that is not in canonical form', () => {
		expect(() => recoveryWords(secretRef.toUpperCase(), candidate, temp)).toThrow(/canonical secret_ref/);
		expect(() => recoveryWords(secretRef, candidate, temp + '\ud800')).toThrow(/user_hash/);
		expect(() => signBinding(candidateKey, 'eip155:010:' + secretRef.slice(10), temp)).toThrow(/canonical secret_ref/);
	});

	it('refuse a candidate that is not an address', () => {
		expect(() => canonicalCandidate('0x1234')).toThrow(/not an address/);
		expect(() => recoveryWords(secretRef, 'alice', temp)).toThrow(/not an address/);
	});
});

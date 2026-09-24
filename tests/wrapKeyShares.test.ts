// Shares of the wrap key: any k of n give it back, and every way a pasted set
// can be wrong — short, repeated, mixed, damaged — is refused with a reason
// rather than combined into 32 bytes that open nothing.
import { describe, it, expect } from 'vitest';
import { newWrapKey } from '@/lib/pq/vaultEnvelope';
import { BackupFormatError } from '@/lib/backupCrypto';
import { splitWrapKey, combineWrapKeyShares } from '@/lib/wrapKeyShares';

describe('wrap key shares (bks2)', () => {
	it('any k of n give the key back, in any order', () => {
		const s = newWrapKey();
		const shares = splitWrapKey(s, 5, 3);
		expect(combineWrapKeyShares([shares[4], shares[1], shares[2]])).toEqual(s);
	});

	it('refuses fewer than k different shares — repeats do not count', () => {
		const shares = splitWrapKey(newWrapKey(), 5, 3);
		expect(() => combineWrapKeyShares([shares[0], shares[1]])).toThrow(/need 3/);
		expect(() => combineWrapKeyShares([shares[0], shares[0], shares[0]])).toThrow(/need 3/);
	});

	it('tolerates blank lines and surrounding whitespace', () => {
		const s = newWrapKey();
		const shares = splitWrapKey(s, 3, 2);
		expect(combineWrapKeyShares(['', `  ${shares[0]}\n`, shares[2]])).toEqual(s);
	});

	it('refuses shares of two different backups instead of combining them into a wrong key', () => {
		// Same n and k, different keys: without a set id the two would combine
		// into 32 bytes that open nothing, reported as a missing vault.
		const a = splitWrapKey(newWrapKey(), 3, 2);
		const b = splitWrapKey(newWrapKey(), 3, 2);
		expect(() => combineWrapKeyShares([a[0], b[1]])).toThrow(/different backups/);
	});

	it('refuses shares of two splits of one key, which carry the same set id', () => {
		const s = newWrapKey();
		const a = splitWrapKey(s, 3, 2);
		const b = splitWrapKey(s, 3, 2);
		expect(() => combineWrapKeyShares([a[0], b[1]])).toThrow(/combine into their key/);
	});

	it('detects a damaged share instead of computing garbage from it', () => {
		const shares = splitWrapKey(newWrapKey(), 3, 2);
		const cut = shares[0].slice(0, -10);
		expect(() => combineWrapKeyShares([cut, shares[1]])).toThrow(/damaged|not a bks2/);
		const flipped = shares[0].replace(/\.([A-Za-z0-9+/=]+)\.([0-9a-f]{8})$/, (_m, ks, crc) => `.${ks.slice(0, -2)}AA.${crc}`);
		expect(() => combineWrapKeyShares([flipped, shares[1]])).toThrow(BackupFormatError);
	});

	it('does not accept a threshold of 1', () => {
		expect(() => splitWrapKey(newWrapKey(), 3, 1)).toThrow(/threshold below 2/);
	});

	it('splits a key and nothing else', () => {
		expect(() => splitWrapKey(new Uint8Array(16), 3, 2)).toThrow(/32 bytes/);
	});
});

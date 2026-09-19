// The backup envelopes: a password file that actually uses the password
// (all of it), and Shamir shares that are noise below the threshold.
// Every negative case must throw BackupFormatError — plausible garbage from
// a wrong password or a forged share set is the failure mode this module
// exists to kill.
import { describe, it, expect } from 'vitest';
import {
	encryptBackupFile, decryptBackupFile,
	packBackupShares, unpackBackupShares,
	BackupFormatError, PBKDF2_ITERATIONS,
} from '@/lib/backupCrypto';

const VAULT = JSON.stringify({
	version: 1,
	identity: { user_hash: 'u_' + 'a'.repeat(128), name: 'Тестовый Аккаунт' },
	keys: { sign_skey: 'QUJD', crypt_skey: 'REVG', evm_skey: '0x11' },
});

describe('password file (v2)', () => {
	it('round-trips, including non-latin content', async () => {
		const file = await encryptBackupFile(VAULT, 'корректный пароль 42');
		expect(await decryptBackupFile(file, 'корректный пароль 42')).toBe(VAULT);
	});

	it('a wrong password fails loudly, not with garbage', async () => {
		const file = await encryptBackupFile(VAULT, 'right password');
		await expect(decryptBackupFile(file, 'wrong password')).rejects.toThrow(BackupFormatError);
	});

	// The old scheme keyed on bytes 8..24 of the password: two passwords
	// sharing a tail decrypted each other's files. Never again.
	it('passwords differing only in the first 8 chars are different keys', async () => {
		const file = await encryptBackupFile(VAULT, 'AAAAAAAA-common-tail');
		await expect(decryptBackupFile(file, 'BBBBBBBB-common-tail')).rejects.toThrow(BackupFormatError);
	});

	it('tampered ciphertext is rejected (GCM integrity)', async () => {
		const file = JSON.parse(await encryptBackupFile(VAULT, 'pw-pw-pw-pw'));
		const ct = Buffer.from(file.ct, 'base64');
		ct[0] ^= 1;
		file.ct = ct.toString('base64');
		await expect(decryptBackupFile(JSON.stringify(file), 'pw-pw-pw-pw')).rejects.toThrow(BackupFormatError);
	});

	it('legacy and malformed files are refused, not misread', async () => {
		await expect(decryptBackupFile('U2FsdGVkX19legacyblob', 'pw')).rejects.toThrow(BackupFormatError);
		await expect(decryptBackupFile('{"v":1,"data":"x"}', 'pw')).rejects.toThrow(BackupFormatError);
	});

	it('a forged low iteration count is neutralized, not honoured', async () => {
		const file = JSON.parse(await encryptBackupFile(VAULT, 'pw-pw-pw-pw'));
		expect(file.iter).toBe(PBKDF2_ITERATIONS);
		// decrypt clamps to max(iter, floor): the forged "1" is ignored and
		// the derivation still runs at the true count — so it still decrypts,
		// and an attacker cannot make the client do cheap KDF work.
		file.iter = 1;
		expect(await decryptBackupFile(JSON.stringify(file), 'pw-pw-pw-pw')).toBe(VAULT);
	});
});

describe('shamir shares (bks1)', () => {
	it('any k of n self-contained shares restore; order does not matter', async () => {
		const shares = await packBackupShares(VAULT, 5, 3);
		expect(shares).toHaveLength(5);
		const picked = [shares[4], shares[1], shares[2]].map((s) => s.text);
		expect(await unpackBackupShares(picked)).toBe(VAULT);
	});

	it('below threshold fails loudly — including duplicates of one share', async () => {
		const shares = await packBackupShares(VAULT, 5, 3);
		await expect(unpackBackupShares([shares[0].text, shares[1].text])).rejects.toThrow(/need 3/);
		await expect(unpackBackupShares([shares[0].text, shares[0].text, shares[0].text])).rejects.toThrow(/need 3/);
	});

	// The previous scheme split the raw key JSON, so one share leaked real
	// fragments. Now the payload rides only as AES-GCM ciphertext and the
	// split covers a random wrap key.
	it('a share never contains vault material in the clear', async () => {
		const shares = await packBackupShares(VAULT, 3, 2);
		for (const s of shares) {
			expect(s.text).not.toContain('sign_skey');
			expect(s.text).not.toContain('u_' + 'a'.repeat(128));
			expect(s.text).not.toContain('Тестовый');
		}
	});

	it('mixed share sets from two backups are refused', async () => {
		const a = await packBackupShares(VAULT, 3, 2);
		const b = await packBackupShares(VAULT, 3, 2); // same payload, fresh key/iv
		await expect(unpackBackupShares([a[0].text, b[1].text])).rejects.toThrow(/different backups/);
	});

	it('a truncated or edited share is caught by its checksum', async () => {
		const shares = await packBackupShares(VAULT, 3, 2);
		const cut = shares[0].text.slice(0, shares[0].text.length - 12);
		await expect(unpackBackupShares([cut, shares[1].text])).rejects.toThrow(/damaged|not a bks1/);
		const flipped = shares[0].text.replace(/\.(\w)/, (m, c) => '.' + (c === 'A' ? 'B' : 'A'));
		await expect(unpackBackupShares([flipped, shares[1].text])).rejects.toThrow(BackupFormatError);
	});

	it('threshold=1 is refused — a single share must never be the secret', async () => {
		await expect(packBackupShares(VAULT, 3, 1)).rejects.toThrow(/threshold below 2/);
	});
});

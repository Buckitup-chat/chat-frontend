// The password file: one that actually uses the password (all of it). Every
// negative case must throw BackupFormatError — plausible garbage from a wrong
// password is the failure mode this module exists to kill.
import { describe, it, expect } from 'vitest';
import {
	encryptBackupFile, decryptBackupFile,
	BackupFormatError, PBKDF2_ITERATIONS, isEncryptedBackupFile,
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

describe('telling a backup file from a plain export', () => {
	// Both are JSON, so a restore screen that guesses by parseability feeds the
	// envelope to the importer and calls a perfectly good backup corrupt.
	it('recognises an encrypted file', async () => {
		expect(isEncryptedBackupFile(await encryptBackupFile('{"a":1}', 'pw'))).toBe(true);
	});

	it('does not mistake a plain vault export for one', () => {
		expect(isEncryptedBackupFile(JSON.stringify({ sign_skey: 'x', crypt_skey: 'y' }))).toBe(false);
	});

	it('says no to anything that is not JSON', () => {
		expect(isEncryptedBackupFile('not a file at all')).toBe(false);
	});
});

describe('what the envelope refuses before asking for a password', () => {
	const envelope = async (over: Record<string, unknown>) => {
		const file = { ...JSON.parse(await encryptBackupFile(VAULT, 'pw-pw-pw-pw')), ...over };
		return JSON.stringify(file);
	};

	it('refuses a work factor that turns one attempt into a hang', async () => {
		// The count comes out of the file, so it is the attacker's choice: at
		// two billion iterations the restore modal never comes back, and it is
		// modalStatic, so there is nothing to close.
		const forged = await envelope({ iter: 2_000_000_000 });
		expect(isEncryptedBackupFile(forged)).toBe(false);
		await expect(decryptBackupFile(forged, 'pw-pw-pw-pw')).rejects.toThrow(BackupFormatError);
	});

	it('refuses an envelope with nothing in it rather than blaming the password', async () => {
		for (const field of ['salt', 'iv', 'ct']) {
			const hollow = await envelope({ [field]: '' });
			expect(isEncryptedBackupFile(hollow)).toBe(false);
			await expect(decryptBackupFile(hollow, 'pw-pw-pw-pw')).rejects.toThrow(BackupFormatError);
		}
	});
});

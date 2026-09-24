// The Local File backup envelope (Security & Recovery page); the other way an
// account leaves the device is lib/wrapKeyShares.
//
// - Local File: the vault JSON encrypted under a password. PBKDF2-SHA-256
//   (600k iterations, random salt) → AES-256-GCM. The previous format sliced
//   raw password bytes into a Blowfish key — for a minimum-length password
//   that was two characters of effective key — and is not read anymore (the
//   project owes no backward compatibility).
//
// GCM's tag is the integrity check: a wrong password or a tampered file fails
// decryption loudly instead of yielding plausible garbage.

import { Buffer } from 'buffer';

const subtle = globalThis.crypto.subtle;
const randomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export const PBKDF2_ITERATIONS = 600_000;
/** A ceiling on the file-supplied work factor: two billion iterations is a
 * quarter of an hour of PBKDF2 per attempt, and the modal it blocks is static —
 * a password attempt stops being a wait and becomes a hang. */
export const MAX_PBKDF2_ITERATIONS = 10_000_000;
const FILE_VERSION = 2;

export class BackupFormatError extends Error {}

const aesEncrypt = async (key: CryptoKey, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> =>
	new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource));

const aesDecrypt = async (key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> => {
	try {
		return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource));
	} catch {
		throw new BackupFormatError('wrong password or corrupted backup');
	}
};

const passwordKey = async (password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> => {
	const material = await subtle.importKey('raw', utf8(password) as BufferSource, 'PBKDF2', false, ['deriveKey']);
	return subtle.deriveKey(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
};

// ---------- Local File (password) ----------

export interface EncryptedBackupFile {
	v: number;
	kdf: 'PBKDF2-SHA-256';
	iter: number;
	salt: string; // base64
	iv: string; // base64
	ct: string; // base64, AES-256-GCM (tag appended)
}

export const encryptBackupFile = async (json: string, password: string): Promise<string> => {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = await passwordKey(password, salt, PBKDF2_ITERATIONS);
	const ct = await aesEncrypt(key, iv, utf8(json));
	const file: EncryptedBackupFile = {
		v: FILE_VERSION, kdf: 'PBKDF2-SHA-256', iter: PBKDF2_ITERATIONS,
		salt: toB64(salt), iv: toB64(iv), ct: toB64(ct),
	};
	return JSON.stringify(file);
};

// One place decides what an encrypted backup is, because both callers need the
// same answer: a plain export and an envelope are both JSON, so parseability
// cannot tell them apart. A sniffer one field wider than the decryptor sends a
// file to a password prompt that cannot succeed.
const readBackupFile = (fileText: string): EncryptedBackupFile | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fileText);
	} catch {
		return null;
	}
	const file = parsed as Partial<EncryptedBackupFile> | null;
	if (!file || typeof file !== 'object') return null;
	if (file.v !== FILE_VERSION || file.kdf !== 'PBKDF2-SHA-256') return null;
	// Non-empty, not merely a string: an envelope with an empty salt or
	// ciphertext passes every type check and then fails to decrypt, which the
	// restore screen can only report as a wrong password.
	if (!(['salt', 'iv', 'ct'] as const).every((k) => typeof file[k] === 'string' && file[k])) return null;
	// The work factor comes out of the file, so an attacker picks it. Too low is
	// clamped up by the decryptor; too high is refused here.
	if (Number(file.iter) > MAX_PBKDF2_ITERATIONS) return null;
	return file as EncryptedBackupFile;
};

/** Whether this text is an encrypted backup rather than a plain vault export. */
export const isEncryptedBackupFile = (fileText: string): boolean => readBackupFile(fileText) !== null;

export const decryptBackupFile = async (fileText: string, password: string): Promise<string> => {
	const file = readBackupFile(fileText);
	if (!file) {
		// Either not a backup at all, or one written by the sliced-password
		// cipher this format replaced. Reading those would bless that scheme.
		throw new BackupFormatError('unsupported backup format — create a new backup from a logged-in device');
	}
	// The stored iteration count is honoured (forward compatibility with a
	// future bump) but never below the current floor: a forged header must
	// not be able to downgrade the work factor.
	const iterations = Math.max(Number(file.iter) || 0, PBKDF2_ITERATIONS);
	const key = await passwordKey(password, fromB64(file.salt), iterations);
	return fromUtf8(await aesDecrypt(key, fromB64(file.iv), fromB64(file.ct)));
};

// ---------- Shamir shares ----------

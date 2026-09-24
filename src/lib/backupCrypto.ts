// Account backup envelopes (Security & Recovery page).
//
// Two consumers, one crypto core:
//
// - Local File: the vault JSON encrypted under a password. PBKDF2-SHA-256
//   (600k iterations, random salt) → AES-256-GCM. The previous format sliced
//   raw password bytes into a Blowfish key — for a minimum-length password
//   that was two characters of effective key — and is not read anymore (the
//   project owes no backward compatibility).
//
// - Shamir shares: the vault JSON is encrypted under a fresh random 32-byte
//   key and only THE KEY is Shamir-split. A share alone — or any set below
//   the threshold — is ciphertext-grade noise, unlike the previous scheme
//   where shares were raw fragments of the unencrypted key JSON. Each share
//   is self-contained (carries the ciphertext), so collecting k share files
//   is all a restore needs.
//
// GCM's tag doubles as the integrity check for both paths: a wrong password,
// a tampered file, or a mixed/forged share set fails decryption loudly
// instead of yielding plausible garbage.

import sss from 'shamirs-secret-sharing';
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
const SHARE_VERSION = 1;
const SHARE_PREFIX = 'bks';

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

const rawKey = (bytes: Uint8Array): Promise<CryptoKey> =>
	subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

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

// crc32 over the share body: catches paste truncation and typos cheaply;
// real integrity is GCM's at combine time.
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
const crc32 = (s: string): string => {
	let c = 0xffffffff;
	const b = utf8(s);
	for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
	return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
};

export interface BackupShare {
	index: number;
	total: number;
	threshold: number;
	text: string; // the full self-contained share line
}

/**
 * Splits a backup into n self-contained shares, any k of which restore it.
 * Share line: `bks1.<index>.<total>.<threshold>.<keyShareB64>.<ctB64>.<ivB64>.<crc>`
 */
export const packBackupShares = async (
	json: string,
	total: number,
	threshold: number,
): Promise<BackupShare[]> => {
	if (!Number.isInteger(total) || !Number.isInteger(threshold)) throw new BackupFormatError('bad parameters');
	if (threshold < 2) throw new BackupFormatError('threshold below 2 makes every single share the whole secret');
	if (threshold > total || total > 255) throw new BackupFormatError('bad parameters');

	const wrapKey = randomBytes(32);
	const iv = randomBytes(12);
	const ct = await aesEncrypt(await rawKey(wrapKey), iv, utf8(json));
	const keyShares = sss.split(Buffer.from(wrapKey), { shares: total, threshold }) as Buffer[];

	const ctB64 = toB64(ct);
	const ivB64 = toB64(iv);
	return keyShares.map((ks, i) => {
		const body = `${SHARE_PREFIX}${SHARE_VERSION}.${i + 1}.${total}.${threshold}.${toB64(new Uint8Array(ks))}.${ctB64}.${ivB64}`;
		return { index: i + 1, total, threshold, text: `${body}.${crc32(body)}` };
	});
};

interface ParsedShare {
	index: number;
	total: number;
	threshold: number;
	keyShare: Uint8Array;
	ct: string;
	iv: string;
}

const parseShare = (line: string, position: number): ParsedShare => {
	const parts = line.trim().split('.');
	if (parts.length !== 8 || parts[0] !== `${SHARE_PREFIX}${SHARE_VERSION}`) {
		throw new BackupFormatError(`share ${position}: not a ${SHARE_PREFIX}${SHARE_VERSION} share`);
	}
	const body = parts.slice(0, 7).join('.');
	if (crc32(body) !== parts[7]) {
		throw new BackupFormatError(`share ${position}: damaged (checksum mismatch) — re-copy it in full`);
	}
	const [, index, total, threshold, keyShare, ct, iv] = parts;
	return {
		index: Number(index), total: Number(total), threshold: Number(threshold),
		keyShare: fromB64(keyShare), ct, iv,
	};
};

/** Combines k+ shares back into the backup JSON. Throws BackupFormatError on
 * malformed/mixed/insufficient shares — never returns garbage. */
export const unpackBackupShares = async (lines: string[]): Promise<string> => {
	const shares = lines.filter((l) => l.trim()).map((line, i) => parseShare(line, i + 1));
	if (!shares.length) throw new BackupFormatError('no shares given');

	const [first] = shares;
	for (const s of shares) {
		if (s.ct !== first.ct || s.iv !== first.iv || s.threshold !== first.threshold || s.total !== first.total) {
			throw new BackupFormatError('shares belong to different backups');
		}
	}
	const unique = new Map(shares.map((s) => [s.index, s]));
	if (unique.size < first.threshold) {
		throw new BackupFormatError(`need ${first.threshold} different shares, got ${unique.size}`);
	}

	const wrapKey = sss.combine([...unique.values()].map((s) => Buffer.from(s.keyShare)));
	const plaintext = await aesDecrypt(await rawKey(new Uint8Array(wrapKey)), fromB64(first.iv), fromB64(first.ct));
	return fromUtf8(plaintext);
};

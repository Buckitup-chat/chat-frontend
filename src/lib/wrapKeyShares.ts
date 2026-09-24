// Shares of the wrap key (lib/pq/vaultEnvelope): the 32-byte key the sealed
// vault on the server opens under is Shamir-split, and only the key. A share
// alone — or any set below the threshold — says nothing about the key, and
// the vault is not in the shares at all. The crc catches paste damage, the set
// id catches mixing; a wrong key surfaces when the vault fails to open
// (lib/recovery/vault).
//
// Its own module because it is the only thing that needs Shamir and the
// Buffer polyfill, and its callers are the sandbox-gated share screens: the
// store that mints the key loads it on demand, so nothing here reaches the
// startup bundle.
import sss from 'shamirs-secret-sharing';
import { Buffer } from 'buffer';
import { deriveVaultLocator } from '@/lib/pq/vaultEnvelope';
import { BackupFormatError } from '@/lib/backupCrypto';
import { fetchVault } from '@/lib/recovery/vault';
import type { BackupContents } from '@/lib/backupContents';

const SHARE_TAG = 'bks2';

const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

// crc32 over the share body: catches paste truncation and typos cheaply;
// real integrity is the vault's GCM at fetch time (lib/recovery/vault).
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
	const b = new TextEncoder().encode(s);
	for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
	return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
};

// Four bytes that name the split without saying anything about the key, so a
// set that mixes two backups is refused as such instead of combining into 32
// bytes that open nothing and being reported as a missing vault. A prefix of
// the vault's address rather than a second hash of the key: the address is
// public the moment a share exists, and one derivation is one to review.
const setId = (wrapKey: Uint8Array): string => deriveVaultLocator(wrapKey).slice(0, 8);

/**
 * Splits the wrap key into n share lines, any k of which give it back.
 * Share line: `bks2.<set>.<index>.<total>.<threshold>.<keyShareB64>.<crc>`
 */
export const splitWrapKey = (wrapKey: Uint8Array, total: number, threshold: number): string[] => {
	if (!Number.isInteger(total) || !Number.isInteger(threshold)) throw new BackupFormatError('bad parameters');
	if (threshold < 2) throw new BackupFormatError('threshold below 2 makes every single share the whole secret');
	if (threshold > total || total > 255) throw new BackupFormatError('bad parameters');

	const set = setId(wrapKey); // refuses anything but 32 bytes
	const secret = Buffer.from(wrapKey);
	try {
		return (sss.split(secret, { shares: total, threshold }) as Buffer[]).map((ks, i) => {
			const body = `${SHARE_TAG}.${set}.${i + 1}.${total}.${threshold}.${toB64(new Uint8Array(ks))}`;
			return `${body}.${crc32(body)}`;
		});
	} finally {
		secret.fill(0);
	}
};

interface ParsedShare {
	set: string;
	index: number;
	total: number;
	threshold: number;
	keyShare: Uint8Array;
}

const parseShare = (line: string, position: number): ParsedShare => {
	const parts = line.trim().split('.');
	if (parts.length !== 7 || parts[0] !== SHARE_TAG) {
		throw new BackupFormatError(`share ${position}: not a ${SHARE_TAG} share`);
	}
	const body = parts.slice(0, 6).join('.');
	if (crc32(body) !== parts[6]) {
		throw new BackupFormatError(`share ${position}: damaged (checksum mismatch) — re-copy it in full`);
	}
	const [, set, index, total, threshold, keyShare] = parts;
	return { set, index: Number(index), total: Number(total), threshold: Number(threshold), keyShare: fromB64(keyShare) };
};

/** Combines k+ shares back into the wrap key. Throws BackupFormatError on
 * malformed/mixed/insufficient shares — never returns garbage. */
export const combineWrapKeyShares = (lines: string[]): Uint8Array => {
	const shares = lines.filter((l) => l.trim()).map((line, i) => parseShare(line, i + 1));
	if (!shares.length) throw new BackupFormatError('no shares given');

	const [first] = shares;
	for (const s of shares) {
		if (s.set !== first.set || s.threshold !== first.threshold || s.total !== first.total) {
			throw new BackupFormatError('shares belong to different backups');
		}
	}
	const unique = new Map(shares.map((s) => [s.index, s]));
	if (unique.size < first.threshold) {
		throw new BackupFormatError(`need ${first.threshold} different shares, got ${unique.size}`);
	}
	const combined = sss.combine([...unique.values()].map((s) => Buffer.from(s.keyShare)));
	const wrapKey = new Uint8Array(combined);
	combined.fill(0);
	// The set id names the key, not the split: two splits of one key carry
	// the same id and their shares pass every check above, then combine into
	// garbage. The key itself is the last word.
	if (wrapKey.length !== 32 || setId(wrapKey) !== first.set) {
		wrapKey.fill(0);
		throw new BackupFormatError('shares do not combine into their key');
	}
	return wrapKey;
};

/** Shares in, account out; the key exists for the duration of the call. */
export const restoreFromShares = async (lines: string[]): Promise<BackupContents> => {
	const wrapKey = combineWrapKeyShares(lines);
	try {
		return await fetchVault(wrapKey);
	} finally {
		wrapKey.fill(0);
	}
};

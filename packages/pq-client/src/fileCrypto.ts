// Chunk cryptography for the file transport (chat docs: reqs/pq_files.md).
//
// A file is split into 4 MiB chunks; each chunk is AES-256-GCM encrypted
// client-side under a per-file random secret, wire format
// nonce(12) || ciphertext || tag(16). The device stores and serves opaque
// bytes — it never sees plaintext, and GCM authentication means corruption
// fails decryption rather than producing garbage.

import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

/** Fixed by the protocol (pq_files §12); changing it orphans nothing but
 * makes resume diffs meaningless across versions. */
export const CHUNK_SIZE = 4 * 1024 * 1024;

export const generateEncSecret = (): Uint8Array => randomBytes(32);

/** 'f_' + UUIDv7 hex, dashes stripped — matches the server CHECK ^f_[a-f0-9]{32}$. */
export const newFileId = (uuidV7: string): string => 'f_' + uuidV7.replace(/-/g, '');

const importKey = (secret: Uint8Array) =>
	crypto.subtle.importKey('raw', secret as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

export const encryptChunk = async (secret: Uint8Array, plain: Uint8Array): Promise<Uint8Array> => {
	const nonce = randomBytes(12);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await importKey(secret), plain),
	);
	const out = new Uint8Array(12 + ct.length);
	out.set(nonce, 0);
	out.set(ct, 12);
	return out;
};

export const decryptChunk = async (secret: Uint8Array, blob: Uint8Array): Promise<Uint8Array> => {
	if (blob.length < 12 + 16) throw new Error('chunk too short to hold nonce and tag');
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: blob.slice(0, 12) },
			await importKey(secret),
			blob.slice(12),
		),
	);
};

/** Trust-chain identity of the encrypted bytes: "fd_" + hex(SHA3-512(raw)). */
export const chunkDataHash = (encrypted: Uint8Array): string => 'fd_' + bytesToHex(sha3_512(encrypted));

export const chunkCountOf = (totalSize: number): number => Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));

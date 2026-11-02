// Chunk cryptography for the file transport (chat docs: reqs/pq_files.md).
//
// A file is split into 4 MiB chunks; each chunk is AES-256-GCM encrypted
// client-side under a per-file random secret, wire format
// nonce(12) || ciphertext || tag(16). The device stores and serves opaque
// bytes — it never sees plaintext, and GCM authentication means corruption
// fails decryption rather than producing garbage.

import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { openAesGcm, sealAesGcm } from './aesGcm.js';

/** Fixed by the protocol (pq_files §12); changing it orphans nothing but
 * makes resume diffs meaningless across versions. */
export const CHUNK_SIZE = 4 * 1024 * 1024;

export const generateEncSecret = (): Uint8Array => randomBytes(32);

/** 'f_' + UUIDv7 hex, dashes stripped — matches the server CHECK ^f_[a-f0-9]{32}$. */
export const newFileId = (uuidV7: string): string => 'f_' + uuidV7.replace(/-/g, '');

/** A chunk sealed under the file's secret: nonce(12) || ciphertext || tag(16). */
export const encryptChunk = sealAesGcm;

export const decryptChunk = openAesGcm;

/** Trust-chain identity of the encrypted bytes: "fd_" + hex(SHA3-512(raw)). */
export const chunkDataHash = (encrypted: Uint8Array): string => 'fd_' + bytesToHex(sha3_512(encrypted));

export const chunkCountOf = (totalSize: number): number => Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));

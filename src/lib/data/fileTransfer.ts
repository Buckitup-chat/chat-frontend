// File transport over the chunk endpoints (chat docs: reqs/pq_files.md §4–§6).
//
// Upload: encrypt each 4 MiB chunk client-side, PUT the raw bytes with the
// signed metadata in headers — the chunk signature binds the uploader key to
// the exact bytes and position, which is why this endpoint needs no
// challenge. When every chunk is on the device, commit the signed manifest
// through the normal ingest path; the server verifies each stored chunk
// against chunk_sign_hashes before accepting it.
//
// Resume is client-driven (§4.1): re-read which chunk indexes the device
// already holds through the file_chunks shape and re-PUT only the gaps.
// Progress is reported in chunks, not guessed percentages (§2.1).

import { signFields, toBase64, fromBase64 } from '@/lib/pq/signature';
import { sha3_512 } from '@noble/hashes/sha3';
import {
	CHUNK_SIZE,
	chunkCountOf,
	chunkDataHash,
	decryptChunk,
	encryptChunk,
	generateEncSecret,
	newFileId,
} from '@/lib/pq/fileCrypto';
import { sendMutationsAndAwaitShape } from './ingest';
import { deleteCachedChunk, getCachedChunk, putCachedChunk, requestPersistentStorage } from './chunkCache';
import { readShapeOnce } from './shapeRead';
import { bearerFor, openSession } from './readSession';
import { ChunkHashes, FileVerificationError, assertChunkBytes, readVerifiedManifest } from './fileIntegrity';
import type { SignPkeyResolver } from './rowVerification';

declare const ELECTRIC_API_URL: string; // the chunk endpoints below are not shapes

export interface UploadProgress {
	fileId: string;
	done: number;
	total: number;
}

export interface UploadResult {
	fileId: string;
	encSecretB64: string;
	size: number;
	chunkCount: number;
}

/**
 * Mints the identifiers an upload needs. The caller persists BOTH before the
 * first PUT (§4.1): file_id alone cannot resume — enc_secret is one random
 * value per file, and a fresh secret would make re-sent chunks undecryptable
 * next to the ones already stored.
 */
export const prepareUpload = (uuidV7: string) => ({
	fileId: newFileId(uuidV7),
	encSecretB64: toBase64(generateEncSecret()),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chunk rows the device already verified and stored for this file, by index.
 * Resume needs the stored sign_b64, not just presence: a re-encrypted chunk
 * gets a fresh nonce and therefore a different hash — the manifest must bind
 * the bytes that are actually on the device. */
const existingChunks = async (fileId: string): Promise<Map<number, { sign_b64: string }>> => {
	const out = new Map<number, { sign_b64: string }>();
	try {
		const rows = await readShapeOnce<{ chunk_index: number | string; sign_b64: string }>(
			'file_chunks', `file_id='${fileId}'`,
		);
		for (const row of rows) out.set(Number(row.chunk_index), { sign_b64: row.sign_b64 });
	} catch {
		/* unreachable shape = empty map; the PUTs below are idempotent anyway */
	}
	return out;
};

const putChunk = async (
	fileId: string,
	index: number,
	body: Uint8Array,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<void> => {
	for (let attempt = 0; ; attempt++) {
		const r = await fetch(`${ELECTRIC_API_URL}/file_chunk/${fileId}/${index}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/octet-stream', ...headers },
			body: body as unknown as globalThis.BodyInit,
			signal,
		});
		if (r.ok) return;
		// 429: the drive's single-writer upload lane is busy — the protocol
		// answer is to wait as told and retry, not to fail the file (§4).
		if (r.status === 429 && attempt < 8) {
			const after = Number(r.headers.get('Retry-After') || 1);
			await sleep(Math.min(after, 10) * 1000);
			continue;
		}
		throw new Error(`chunk ${index} rejected: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
	}
};

export const uploadFile = async (opts: {
	bytes: Uint8Array;
	uploaderHash: string;
	signSkey: Uint8Array;
	/** From prepareUpload(); the same pair resumes an interrupted upload. */
	fileId: string;
	encSecretB64: string;
	/**
	 * Set when chunks may already be on the device (retry after a failure).
	 * Waits for the file_chunks shape to settle before deciding what to skip:
	 * the shape lags the commit by seconds, and treating a stored chunk as
	 * absent re-PUTs a different body onto the same index — the server keeps
	 * the old metadata row (insert on_conflict: nothing) while the bytes get
	 * replaced, and the manifest can never match both.
	 */
	resuming?: boolean;
	onProgress?: (p: UploadProgress) => void;
	signal?: AbortSignal;
}): Promise<UploadResult> => {
	const { bytes, uploaderHash, signSkey, fileId, onProgress, signal } = opts;
	const encSecret = fromBase64(opts.encSecretB64);
	const total = chunkCountOf(bytes.length);
	const ownerTimestamp = Math.floor(Date.now() / 1000);
	const chunkSignHashes: string[] = [];

	// A fresh-where snapshot (see existingChunks) reflects the device's actual
	// state, so one read suffices for both the fresh and the resume path.
	const already = opts.resuming ? await existingChunks(fileId) : new Map<number, { sign_b64: string }>();

	for (let i = 0; i < total; i++) {
		signal?.throwIfAborted();

		const stored = already.get(i);
		if (stored) {
			// The device already holds these bytes; the manifest must bind
			// their stored signature — re-encrypting would change the hash.
			chunkSignHashes.push(toBase64(sha3_512(fromBase64(stored.sign_b64))));
			onProgress?.({ fileId, done: i + 1, total });
			continue;
		}

		const plain = bytes.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, bytes.length));
		const encrypted = await encryptChunk(encSecret, plain);
		const dataHash = chunkDataHash(encrypted);

		// The signed payload is the chunk's manifest row (pq_files §1.2);
		// canonicalPayload sorts the fields, so order here is cosmetic.
		const signB64 = signFields(
			{
				chunk_index: i,
				data_hash: dataHash,
				file_id: fileId,
				owner_timestamp: ownerTimestamp,
				size: encrypted.length,
				uploader_hash: uploaderHash,
			},
			signSkey,
		);
		// The manifest binds SHA3-512 of the RAW signature bytes per chunk.
		chunkSignHashes.push(toBase64(sha3_512(fromBase64(signB64))));

		await putChunk(fileId, i, encrypted, {
			'x-data-hash': dataHash,
			'x-size': String(encrypted.length),
			'x-uploader-hash': uploaderHash,
			'x-owner-timestamp': String(ownerTimestamp),
			'x-signature': signB64,
		}, signal);
		// Seed the local chunk cache: the sender should never re-download
		// bytes it just encrypted. Fire-and-forget — caching must not slow
		// or fail the upload.
		void putCachedChunk(fileId, i, encrypted);
		onProgress?.({ fileId, done: i + 1, total });
	}

	// Manifest commit: the trust anchor other devices use to accept chunks.
	const manifestFields = {
		chunk_count: total,
		chunk_sign_hashes: chunkSignHashes,
		chunk_size: CHUNK_SIZE,
		deleted_flag: false,
		file_id: fileId,
		owner_timestamp: ownerTimestamp,
		total_size: bytes.length,
		uploader_hash: uploaderHash,
	};
	const manifestSign = signFields(manifestFields as never, signSkey);
	const manifestHandle = await sendMutationsAndAwaitShape(
		[{
			type: 'insert',
			syncMetadata: { relation: 'files' },
			modified: { ...manifestFields, sign_b64: manifestSign },
		}],
		signSkey,
	);
	const manifestOutcome = await manifestHandle.acceptance;
	if (manifestOutcome.kind !== 'accepted') {
		const reason = manifestOutcome.kind === 'rejected' ? manifestOutcome.error : 'discarded before delivery';
		throw new Error(`File manifest for ${fileId} was not accepted: ${reason}`);
	}

	return { fileId, encSecretB64: opts.encSecretB64, size: bytes.length, chunkCount: total };
};

export interface FileAvailability {
	/** Chunks this node can already serve. */
	present: number;
	/** Chunks the signed manifest says the file has. */
	total: number;
	/** The manifest itself has not arrived — nothing is known about the file. */
	unknown: boolean;
	deleted: boolean;
}

/**
 * How much of a file this node can serve right now (§2.4).
 *
 * Partial availability is a normal state in a network without internet, not
 * an error: manifests replicate ahead of bytes, and the missing chunks come
 * on their own. The counts come from the same rows the sync protocol uses —
 * the manifest for the total, the chunk rows for what is here. The total and
 * the deleted flag are the uploader's only once the manifest verifies: one
 * that does not is refused with a FileVerificationError, and one that cannot
 * be checked yet counts as not arrived.
 */
export const fileAvailability = async (
	fileId: string,
	opts: { resolveSignPkey?: SignPkeyResolver } = {},
): Promise<FileAvailability> => {
	const unknown: FileAvailability = { present: 0, total: 0, unknown: true, deleted: false };
	let manifest;
	try {
		manifest = await readVerifiedManifest(fileId, opts);
	} catch (e) {
		if (e instanceof FileVerificationError && e.kind === 'invalid') throw e;
		return unknown;
	}
	if (!manifest) return unknown;

	const chunks = await existingChunks(fileId);
	return { present: chunks.size, total: manifest.chunkCount, unknown: false, deleted: manifest.deleted };
};

export interface DownloadProgress {
	fileId: string;
	done: number;
	total: number;
}

/**
 * Fetches and decrypts a file. The count and order of its chunks are the
 * uploader's: the manifest and each chunk's row must verify, and each
 * chunk's bytes must hash to what its row says (fileIntegrity.ts) — GCM
 * alone would accept any of the file's chunks at any index. A file that
 * fails is refused with a FileVerificationError before anything more is
 * fetched, and nothing of it is cached.
 */
export const downloadFile = async (opts: {
	fileId: string;
	encSecretB64: string;
	onProgress?: (p: DownloadProgress) => void;
	/** Each decrypted chunk as it lands — lets a consumer start before the end. */
	onChunk?: (index: number, plain: Uint8Array) => void;
	signal?: AbortSignal;
	resolveSignPkey?: SignPkeyResolver;
}): Promise<Uint8Array> => {
	const { fileId, encSecretB64, onProgress, signal } = opts;
	const secret = fromBase64(encSecretB64);

	const manifest = await readVerifiedManifest(fileId, { signal, resolveSignPkey: opts.resolveSignPkey });
	if (!manifest) throw new Error('file manifest not found');
	if (manifest.deleted) throw new Error('file was deleted by its uploader');
	const total = manifest.chunkCount;
	const hashes = new ChunkHashes(manifest, signal);

	requestPersistentStorage();
	const parts: Uint8Array[] = [];
	let size = 0;
	for (let i = 0; i < total; i++) {
		signal?.throwIfAborted();
		const expected = await hashes.expected(i);
		// Disk before network: chunks are immutable, so a cached one is
		// exactly the one the device would serve — a reload or a lost uplink
		// reassembles from here. A cached copy that does not match is dropped
		// and fetched again.
		let encrypted = await getCachedChunk(fileId, i);
		if (encrypted && chunkDataHash(encrypted) !== expected) {
			await deleteCachedChunk(fileId, i);
			encrypted = null;
		}
		const fromCache = !!encrypted;
		if (!encrypted) {
			const fetchChunk = () => {
				const auth = bearerFor('file_chunk');
				return fetch(`${ELECTRIC_API_URL}/file_chunk/${fileId}/${i}`, {
					signal,
					headers: auth ? { Authorization: auth } : undefined,
				});
			};
			let r = await fetchChunk();
			if (r.status === 401) {
				await openSession('file_chunk');
				r = await fetchChunk();
			}
			if (!r.ok) throw new Error(`chunk ${i} unavailable: HTTP ${r.status}`);
			encrypted = new Uint8Array(await r.arrayBuffer());
			assertChunkBytes(fileId, i, expected, encrypted);
		}
		const plain = await decryptChunk(secret, encrypted);
		// Cached only once it is the signed chunk and decrypts: a bad fetch
		// must not poison future loads.
		if (!fromCache) void putCachedChunk(fileId, i, encrypted);
		parts.push(plain);
		size += plain.length;
		opts.onChunk?.(i, plain);
		onProgress?.({ fileId, done: i + 1, total });
	}

	const out = new Uint8Array(size);
	let off = 0;
	for (const p of parts) { out.set(p, off); off += p.length; }
	return out;
};

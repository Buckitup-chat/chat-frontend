// File transport over the chunk endpoints (chat docs: reqs/pq_files.md §4–§6).
//
// Upload: @buckitup/pq-client/fileUpload encrypts each 4 MiB chunk, PUTs the
// raw bytes with the signed metadata in headers and signs the manifest. When
// every chunk is on the device, commit the signed manifest through the normal
// ingest path; the server verifies each stored chunk against
// chunk_sign_hashes before accepting it.
//
// Resume is client-driven (§4.1): re-read which chunk indexes the device
// already holds through the file_chunks shape and re-PUT only the gaps.
// Progress is reported in chunks, not guessed percentages (§2.1).

import { toBase64, fromBase64 } from '@buckitup/pq-client/signature';
import { concatBytes } from '@noble/hashes/utils';
import { decryptChunk, generateEncSecret, newFileId } from '@buckitup/pq-client/fileCrypto';
import { uploadFileChunks } from '@buckitup/pq-client/fileUpload';
import { sendMutationsAndAwaitShape } from './ingest';
import { getCachedChunk, pinCachedChunks, pinChunk, putCachedChunk, requestPersistentStorage } from './chunkCache';
import { bearerFor, openSession } from './readSession';
import { assertChunkBytes, FileVerificationError, isRefusedFile, readChunkRows, readVerifiedFile } from './fileIntegrity';
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
	manifestAwaitingApproval?: Promise<void>;
}

/**
 * Mints the identifiers an upload needs. The caller keeps BOTH from before
 * the first PUT for as long as the upload may resume: file_id alone cannot
 * resume — enc_secret is one random value per file, and a fresh secret would
 * make re-sent chunks undecryptable next to the ones already stored.
 *
 * pq_files §4.1 asks for a durable record, removed when the manifest commits,
 * so an upload resumes after a reload: the transfer queue keeps the pair in
 * one sealed through `secureStore` (pendingUploads.ts), since the secret opens
 * the file (docs/invariants.md §1).
 */
export const prepareUpload = (uuidV7: string) => ({
	fileId: newFileId(uuidV7),
	encSecretB64: toBase64(generateEncSecret()),
});

export { FileIdTakenError, NoWriteRightsError } from '@buckitup/pq-client/fileUpload';

export const uploadFile = async (opts: {
	bytes: Uint8Array;
	uploaderHash: string;
	signSkey: Uint8Array;
	signPkey: string | Uint8Array;
	/** From prepareUpload(); the same pair resumes an interrupted upload. */
	fileId: string;
	encSecretB64: string;
	/**
	 * Set when chunks may already be on the device (retry after a failure):
	 * the stored indexes are read first and not sent again. A stored chunk
	 * missed by that read is not lost — the device never replaces it and
	 * answers 409, and the upload then binds the stored row instead.
	 */
	resuming?: boolean;
	onProgress?: (p: UploadProgress) => void;
	signal?: AbortSignal;
}): Promise<UploadResult> => {
	const { fileId, signSkey, signal } = opts;
	const { manifest, ...result } = await uploadFileChunks({
		...opts,
		apiUrl: ELECTRIC_API_URL,
		readChunkRows,
		onChunkStored: putCachedChunk,
	});
	signal?.throwIfAborted();

	// Manifest commit: the trust anchor other devices use to accept chunks.
	const committed = (async (): Promise<UploadResult> => {
		const manifestHandle = await sendMutationsAndAwaitShape([manifest], signSkey);
		signal?.throwIfAborted();
		const manifestAccepted = manifestHandle.acceptance.then((outcome) => {
			if (outcome.kind === 'accepted') return;
			const reason = outcome.kind === 'rejected' ? outcome.error : 'discarded before delivery';
			throw new Error(`File manifest for ${fileId} was not accepted: ${reason}`);
		});
		if (manifestHandle.held?.reason === 'awaiting_approval') return { ...result, manifestAwaitingApproval: manifestAccepted };
		await manifestAccepted;
		signal?.throwIfAborted();
		return result;
	})();
	if (!signal) return committed;
	return new Promise<UploadResult>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener('abort', onAbort);
			reject(signal.reason);
		};
		signal.addEventListener('abort', onAbort, { once: true });
		committed.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
		if (signal.aborted) onAbort();
	});
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
 * the manifest for the total, the chunk rows for what is here. Both are the
 * uploader's: the manifest must verify under `uploaderHash`, the sender of
 * the message carrying the file, and a chunk counts only if its row is the
 * one the manifest lists. A manifest that fails is refused with a
 * FileVerificationError; one that cannot be checked yet counts as not arrived.
 */
export const fileAvailability = async (
	fileId: string,
	uploaderHash: string,
	opts: { resolveSignPkey?: SignPkeyResolver } = {},
): Promise<FileAvailability> => {
	const unknown: FileAvailability = { present: 0, total: 0, unknown: true, deleted: false };
	let file;
	try {
		file = await readVerifiedFile(fileId, uploaderHash, opts);
	} catch (e) {
		if (isRefusedFile(e)) throw e;
		return unknown;
	}
	if (!file) return unknown;
	return { present: file.hashes.listedPresent(), total: file.manifest.chunkCount, unknown: false, deleted: file.manifest.deleted };
};

/**
 * The uploader deleted the file (pq_files §7): its manifest is a tombstone
 * with no chunk list, and the server reclaims the bytes. Not a network
 * failure — another attempt gets the same answer.
 */
export class FileDeletedError extends Error {
	constructor(readonly fileId: string) {
		super(`file ${fileId} was deleted by its uploader`);
		this.name = 'FileDeletedError';
	}
}

export const isDeletedFile = (e: unknown): boolean => e instanceof FileDeletedError;

/** The file's verified manifest and chunk rows, or why there is nothing to read. */
export const readLiveFile = async (fileId: string, uploaderHash: string, opts: { signal?: AbortSignal; resolveSignPkey?: SignPkeyResolver }) => {
	const file = await readVerifiedFile(fileId, uploaderHash, opts);
	if (!file) throw new Error('file manifest not found');
	if (file.manifest.deleted) throw new FileDeletedError(fileId);
	return file;
};

/**
 * Chunk `i` as the uploader signed it: from disk when this device holds it,
 * from the network otherwise. Bytes fetched are held to `expected` before
 * anything else sees them. `touch: false` reads from disk without moving the
 * chunk in the eviction order, for a caller that pins it next.
 */
const readChunk = async (
	fileId: string,
	i: number,
	expected: string,
	opts: { signal?: AbortSignal; touch?: boolean } = {},
): Promise<{ encrypted: Uint8Array; fromCache: boolean }> => {
	const { signal } = opts;
	// Disk before network: chunks are immutable, so a cached one is
	// exactly the one the device would serve — a reload or a lost uplink
	// reassembles from here. The cache answers only for the signed hash; a
	// copy stored under another is fetched again and overwritten.
	const cached = await getCachedChunk(fileId, i, expected, { touch: opts.touch });
	if (cached) return { encrypted: cached, fromCache: true };
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
	const encrypted = new Uint8Array(await r.arrayBuffer());
	assertChunkBytes(fileId, i, expected, encrypted);
	return { encrypted, fromCache: false };
};

/**
 * Chunk `i` decrypted under the file's secret. Its bytes already hold to the
 * hash the uploader signed, so bytes that do not open refuse the file:
 * another attempt gets the same bytes and the same answer.
 */
const openChunk = async (fileId: string, i: number, secret: Uint8Array, encrypted: Uint8Array): Promise<Uint8Array> => {
	try {
		return await decryptChunk(secret, encrypted);
	} catch {
		throw new FileVerificationError(fileId, 'invalid', "it does not decrypt under the file's secret", i);
	}
};

export interface DownloadProgress {
	fileId: string;
	done: number;
	total: number;
}

/**
 * Fetches and decrypts a file. The count and order of its chunks are the
 * uploader's — `uploaderHash`, the sender of the message carrying it: the
 * manifest and each chunk's row must verify, and each
 * chunk's bytes must hash to what its row says (fileIntegrity.ts) — GCM
 * alone would accept any of the file's chunks at any index. A file that
 * fails is refused with a FileVerificationError before anything more is
 * fetched, and nothing of it is cached.
 */
export const downloadFile = async (opts: {
	fileId: string;
	uploaderHash: string;
	encSecretB64: string;
	onProgress?: (p: DownloadProgress) => void;
	/** Each decrypted chunk as it lands — lets a consumer start before the end. */
	onChunk?: (index: number, plain: Uint8Array) => void;
	signal?: AbortSignal;
	resolveSignPkey?: SignPkeyResolver;
}): Promise<Uint8Array> => {
	const { fileId, encSecretB64, onProgress, signal } = opts;
	const secret = fromBase64(encSecretB64);

	const { hashes, manifest } = await readLiveFile(fileId, opts.uploaderHash, { signal, resolveSignPkey: opts.resolveSignPkey });
	const total = manifest.chunkCount;

	requestPersistentStorage();
	const parts: Uint8Array[] = [];
	for (let i = 0; i < total; i++) {
		signal?.throwIfAborted();
		const expected = await hashes.expected(i);
		const { encrypted, fromCache } = await readChunk(fileId, i, expected, { signal });
		const plain = await openChunk(fileId, i, secret, encrypted);
		// Cached only once it is the signed chunk and decrypts: a bad fetch
		// must not poison future loads.
		if (!fromCache) void putCachedChunk(fileId, i, encrypted, expected);
		parts.push(plain);
		opts.onChunk?.(i, plain);
		onProgress?.({ fileId, done: i + 1, total });
	}
	return concatBytes(...parts);
};

/** Rows verified between two yields: each signature check holds the main thread for milliseconds. */
const VERIFY_BATCH = 8;

/** Lets the page handle input; a message, unlike a chain of timers, is not throttled in a hidden tab. */
const yieldToPage = (): Promise<void> =>
	new Promise((resolve) => {
		const { port1, port2 } = new MessageChannel();
		port1.onmessage = () => {
			port1.close();
			resolve();
		};
		port2.postMessage(null);
	});

/**
 * Pins every chunk of a file for `owner` (keptFiles.ts), fetching the ones
 * this device lacks first, and returns each chunk's signed data hash in index
 * order — what opening the kept copy later checks the bytes against, with no
 * manifest needed. Before anything is pinned the last chunk must decrypt
 * under `encSecretB64`, so a secret that is not the file's fetches nothing
 * more. The chunks already on disk under their signed hash are pinned as
 * they are, not decrypted; each one fetched is verified as a download
 * verifies it and must decrypt. A failed pin throws (a full disk as
 * QuotaExceededError); the chunks pinned before it stay pinned, and the
 * caller releases them.
 */
export const pinFileChunks = async (opts: {
	fileId: string;
	uploaderHash: string;
	encSecretB64: string;
	owner: string;
	onProgress?: (p: DownloadProgress) => void;
	signal?: AbortSignal;
	resolveSignPkey?: SignPkeyResolver;
}): Promise<string[]> => {
	const { fileId, owner, onProgress, signal } = opts;
	const secret = fromBase64(opts.encSecretB64);
	const { hashes, manifest } = await readLiveFile(fileId, opts.uploaderHash, { signal, resolveSignPkey: opts.resolveSignPkey });
	const total = manifest.chunkCount;
	requestPersistentStorage();
	const dataHashes: string[] = [];
	for (let i = 0; i < total; i++) {
		if (i % VERIFY_BATCH === VERIFY_BATCH - 1) await yieldToPage();
		signal?.throwIfAborted();
		dataHashes.push(await hashes.expected(i));
	}
	if (!total) return dataHashes;
	// Read without the LRU touch, here and below: pinning the chunk writes its metadata anyway.
	const last = await readChunk(fileId, total - 1, dataHashes[total - 1], { signal, touch: false });
	await openChunk(fileId, total - 1, secret, last.encrypted);
	const held = await pinCachedChunks(fileId, dataHashes, owner);
	let done = held.size;
	if (done) onProgress?.({ fileId, done, total });
	for (let i = 0; i < total; i++) {
		if (held.has(i)) continue;
		signal?.throwIfAborted();
		let encrypted = last.encrypted;
		if (i < total - 1) {
			encrypted = (await readChunk(fileId, i, dataHashes[i], { signal, touch: false })).encrypted;
			await openChunk(fileId, i, secret, encrypted);
		}
		await pinChunk(fileId, i, dataHashes[i], owner, encrypted);
		onProgress?.({ fileId, done: ++done, total });
	}
	return dataHashes;
};

/**
 * Reassembles a kept file from this device alone: chunk `i` must be on disk
 * under `dataHashes[i]`, the hash its signed row gave when it was kept.
 * Throws when one is missing — the browser may have cleared the origin's
 * storage — so the caller can try the network.
 */
export const readKeptChunks = async (opts: {
	fileId: string;
	encSecretB64: string;
	dataHashes: string[];
	onProgress?: (p: DownloadProgress) => void;
	signal?: AbortSignal;
}): Promise<Uint8Array> => {
	const { fileId, dataHashes, onProgress, signal } = opts;
	const secret = fromBase64(opts.encSecretB64);
	const total = dataHashes.length;
	const parts: Uint8Array[] = [];
	for (let i = 0; i < total; i++) {
		signal?.throwIfAborted();
		const encrypted = await getCachedChunk(fileId, i, dataHashes[i]);
		if (!encrypted) throw new Error(`chunk ${i} of the kept copy of ${fileId} is not on this device`);
		parts.push(await openChunk(fileId, i, secret, encrypted));
		onProgress?.({ fileId, done: i + 1, total });
	}
	return concatBytes(...parts);
};

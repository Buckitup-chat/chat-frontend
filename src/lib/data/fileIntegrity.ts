// A file's integrity on the read path (docs/invariants.md §6a; chat docs: reqs/pq_files.md).
//
// AES-GCM proves a chunk was encrypted under this file's secret, not that it
// is chunk i: each chunk has its own random nonce and no associated data, so a
// server can serve chunk 3 for index 1, or chunk 0 for every index, and each
// one decrypts. What pins a chunk to its position is the uploader's signatures:
// - the manifest (`files`) lists, in index order, SHA3-512 of each chunk's
//   signature (`chunk_sign_hashes`), and is signed itself;
// - each chunk's row (`file_chunks`) binds its index to `data_hash`, the
//   SHA3-512 of its encrypted bytes, under the same uploader's key.
//
// The uploader is the sender of the message that carries the file: a
// manifest anyone else signed, however validly, does not speak for the file.
// A chunk's row is accepted when its signature is the one the manifest lists
// at that index and verifies over the row. What that yields is one expected
// `data_hash` per index; the bytes are then held to it. The service worker,
// which streams video and cannot afford ML-DSA per range request, asks the
// page for the hash of each chunk and compares hashes only.

import { sha3_512 } from '@noble/hashes/sha3';
import { equalBytes } from '@noble/post-quantum/utils.js';
import { chunkDataHash } from '@/lib/pq/fileCrypto';
import { toBytes } from '@/lib/pq/signature';
import { wireBool } from '@/lib/pq/schema';
import { verifyReplicatedRow, verifyRowWithKey, type SignPkeyResolver } from './rowVerification';
import { readShapeOnce } from './shapeRead';

type Row = Record<string, unknown>;

/**
 * `invalid`: the data contradicts the uploader's signatures. The file is
 * refused, not retried — another attempt gets the same answer.
 * `unavailable`: what the check needs (the uploader's card, a chunk's row) has
 * not arrived yet. A later attempt may pass.
 */
export type FileVerificationKind = 'invalid' | 'unavailable';

export class FileVerificationError extends Error {
	constructor(
		readonly fileId: string,
		readonly kind: FileVerificationKind,
		readonly detail: string,
		readonly chunkIndex: number | null = null,
	) {
		const what = chunkIndex === null ? `file ${fileId}` : `chunk ${chunkIndex} of file ${fileId}`;
		super(`${what} ${kind === 'invalid' ? 'could not be verified' : 'cannot be verified yet'}: ${detail}`);
		this.name = 'FileVerificationError';
	}
}

/** True for a file the UI shows as "could not be verified". */
export const isRefusedFile = (e: unknown): boolean => e instanceof FileVerificationError && e.kind === 'invalid';

export interface VerifiedManifest {
	fileId: string;
	/** The uploader's verified signing key; the chunk rows are checked under it. */
	signPkey: string;
	chunkCount: number;
	deleted: boolean;
	/** SHA3-512 of each chunk's signature, in index order. */
	chunkSignHashes: Uint8Array[];
}

const defaultResolver: SignPkeyResolver = async (userHash) =>
	(await import('./cardRegistry')).getVerifiedSignPkey(userHash);

/** The file's chunk rows by index, as the shape has them now. */
export const readChunkRows = async (fileId: string, signal?: AbortSignal): Promise<Map<number, Row>> => {
	const rows = await readShapeOnce<Row>('file_chunks', `file_id='${fileId}'`, signal);
	return new Map(rows.map((r) => [Number(r.chunk_index), r]));
};

/** The manifest row as signed by `uploaderHash`, the sender of the message carrying the file. */
export const verifyManifest = async (
	fileId: string,
	uploaderHash: string,
	row: Row,
	resolveSignPkey: SignPkeyResolver = defaultResolver,
): Promise<VerifiedManifest> => {
	const refuse = (detail: string) => new FileVerificationError(fileId, 'invalid', detail);
	if (row.file_id !== fileId) throw refuse('the manifest names another file');
	if (row.uploader_hash !== uploaderHash) throw refuse("the manifest is not the sender's");

	let signPkey: string | null = null;
	const verdict = await verifyReplicatedRow('files', row, async (hash) => (signPkey = await resolveSignPkey(hash)));
	if (verdict.status === 'unavailable') {
		throw new FileVerificationError(fileId, 'unavailable', verdict.reason === 'locked' ? 'the vault is locked' : "the uploader's card has not arrived");
	}
	if (verdict.status !== 'verified' || !signPkey) throw refuse(`the manifest's signature does not hold (${verdict.status === 'verified' ? 'no key' : verdict.reason})`);

	const deleted = wireBool(row.deleted_flag);
	const chunkCount = Number(row.chunk_count);
	const listed = Array.isArray(row.chunk_sign_hashes) ? (row.chunk_sign_hashes as Array<string | Uint8Array>) : [];
	// A signed manifest can still be self-contradictory; a deleted one has
	// nothing left to download.
	if (!deleted && (!Number.isInteger(chunkCount) || chunkCount < 1 || listed.length !== chunkCount)) {
		throw refuse(`the manifest lists ${listed.length} chunk signatures for ${row.chunk_count} chunks`);
	}
	return { fileId, signPkey, chunkCount, deleted, chunkSignHashes: listed.map(toBytes) };
};

/** True when the row carries the signature the manifest lists at `index`: a hash comparison, no signature check. */
const isListed = (manifest: VerifiedManifest, index: number, row: Row): boolean => {
	const listed = manifest.chunkSignHashes[index];
	return !!listed && typeof row.sign_b64 === 'string' && !!row.sign_b64 && equalBytes(sha3_512(toBytes(row.sign_b64)), listed);
};

/**
 * The `data_hash` a chunk's bytes must have, from its row; throws if the row
 * is not the uploader's. The row's file, index and uploader need no check of
 * their own: they are signed, and the signature is the one the manifest lists
 * at this index.
 */
export const verifyChunkRow = (manifest: VerifiedManifest, index: number, row: Row): string => {
	const refuse = (detail: string) => new FileVerificationError(manifest.fileId, 'invalid', detail, index);
	if (!isListed(manifest, index, row)) throw refuse('its row carries a signature the manifest does not list');
	const verdict = verifyRowWithKey('file_chunks', row, manifest.signPkey);
	if (verdict.status !== 'verified') throw refuse(`its row's signature does not hold (${verdict.reason})`);
	if (typeof row.data_hash !== 'string') throw refuse('its row has no data hash');
	return row.data_hash;
};

/** Holds a chunk's bytes to the hash its verified row gives; throws if they differ. */
export const assertChunkBytes = (fileId: string, index: number, expectedDataHash: string, encrypted: Uint8Array): void => {
	if (chunkDataHash(encrypted) !== expectedDataHash) {
		throw new FileVerificationError(fileId, 'invalid', 'its bytes are not the ones the uploader signed', index);
	}
};

/**
 * Expected chunk hashes of one verified file. Chunk rows replicate after the
 * manifest and one by one: a row missing from those read with the manifest is
 * read for again once. A row is verified the first time it is needed.
 */
export class ChunkHashes {
	private readonly expectedByIndex = new Map<number, string>();

	constructor(
		readonly manifest: VerifiedManifest,
		private rows: Map<number, Row>,
		private readonly signal?: AbortSignal,
	) {}

	/** Chunks here whose row is the one the manifest lists. */
	listedPresent(): number {
		let n = 0;
		for (const [index, row] of this.rows) if (isListed(this.manifest, index, row)) n++;
		return n;
	}

	/** The hash chunk `index` must have; throws `unavailable` while its row is missing, `invalid` if it is refused. */
	async expected(index: number): Promise<string> {
		const known = this.expectedByIndex.get(index);
		if (known) return known;
		if (!this.rows.has(index)) this.rows = await readChunkRows(this.manifest.fileId, this.signal);
		const row = this.rows.get(index);
		if (!row) throw new FileVerificationError(this.manifest.fileId, 'unavailable', 'its signed row has not arrived', index);
		const hash = verifyChunkRow(this.manifest, index, row);
		this.expectedByIndex.set(index, hash);
		return hash;
	}
}

/**
 * The file's verified manifest and its chunk rows, read together; null when
 * the manifest has not arrived. Refuses before anything is fetched.
 */
export const readVerifiedFile = async (
	fileId: string,
	uploaderHash: string,
	opts: { signal?: AbortSignal; resolveSignPkey?: SignPkeyResolver } = {},
): Promise<{ manifest: VerifiedManifest; hashes: ChunkHashes } | null> => {
	const [manifests, rows] = await Promise.all([
		readShapeOnce<Row>('files', `file_id='${fileId}'`, opts.signal),
		readChunkRows(fileId, opts.signal),
	]);
	const row = manifests.find((r) => r.file_id === fileId);
	if (!row) return null;
	const manifest = await verifyManifest(fileId, uploaderHash, row, opts.resolveSignPkey);
	return { manifest, hashes: new ChunkHashes(manifest, rows, opts.signal) };
};

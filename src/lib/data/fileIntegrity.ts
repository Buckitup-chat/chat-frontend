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
// A chunk's row is accepted when its signature is the one the manifest lists
// at that index and verifies over the row. What that yields is one expected
// `data_hash` per index; the bytes are then held to it. The service worker,
// which streams video and cannot afford ML-DSA per range request, gets those
// hashes from the page and compares hashes only.

import { sha3_512 } from '@noble/hashes/sha3';
import { chunkDataHash } from '@/lib/pq/fileCrypto';
import { toBytes } from '@/lib/pq/signature';
import { wireBool } from '@/lib/pq/schema';
import { VaultLockedError } from './keyCustody';
import { verifyRowWithKey, type SignPkeyResolver } from './rowVerification';
import { readShapeOnce } from './shapeRead';

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
	uploaderHash: string;
	/** The uploader's verified signing key; the chunk rows are checked under it. */
	signPkey: string;
	chunkCount: number;
	deleted: boolean;
	/** SHA3-512 of each chunk's signature, in index order. */
	chunkSignHashes: Uint8Array[];
}

const defaultResolver: SignPkeyResolver = async (userHash) =>
	(await import('./cardRegistry')).getVerifiedSignPkey(userHash);

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

/** The manifest row as signed by its uploader, or a FileVerificationError. */
export const verifyManifest = async (
	fileId: string,
	row: Record<string, unknown>,
	resolveSignPkey: SignPkeyResolver = defaultResolver,
): Promise<VerifiedManifest> => {
	const refuse = (detail: string) => new FileVerificationError(fileId, 'invalid', detail);
	if (row.file_id !== fileId) throw refuse('the manifest names another file');
	const uploaderHash = typeof row.uploader_hash === 'string' ? row.uploader_hash : '';
	if (!uploaderHash) throw refuse('the manifest names no uploader');

	let signPkey: string | null;
	try {
		signPkey = await resolveSignPkey(uploaderHash);
	} catch (e) {
		if (e instanceof VaultLockedError) throw new FileVerificationError(fileId, 'unavailable', 'the vault is locked');
		throw e;
	}
	if (!signPkey) throw new FileVerificationError(fileId, 'unavailable', "the uploader's card has not arrived");

	const verdict = verifyRowWithKey('files', row, signPkey);
	if (verdict.status !== 'verified') throw refuse(`the manifest's signature does not hold (${verdict.reason})`);

	const deleted = wireBool(row.deleted_flag);
	const chunkCount = Number(row.chunk_count);
	const listed = Array.isArray(row.chunk_sign_hashes) ? (row.chunk_sign_hashes as Array<string | Uint8Array>) : [];
	// A signed manifest can still be self-contradictory; a deleted one has
	// nothing left to download.
	if (!deleted && (!Number.isInteger(chunkCount) || chunkCount < 1 || listed.length !== chunkCount)) {
		throw refuse(`the manifest lists ${listed.length} chunk signatures for ${row.chunk_count} chunks`);
	}
	return { fileId, uploaderHash, signPkey, chunkCount, deleted, chunkSignHashes: listed.map(toBytes) };
};

/**
 * The file's verified manifest, or null when it has not arrived. Refuses
 * before anything is fetched.
 */
export const readVerifiedManifest = async (
	fileId: string,
	opts: { signal?: AbortSignal; resolveSignPkey?: SignPkeyResolver } = {},
): Promise<VerifiedManifest | null> => {
	const rows = await readShapeOnce<Record<string, unknown>>('files', `file_id='${fileId}'`, opts.signal);
	const row = rows.find((r) => r.file_id === fileId);
	return row ? verifyManifest(fileId, row, opts.resolveSignPkey) : null;
};

/**
 * The `data_hash` a chunk's bytes must have, from its row; throws if the row
 * is not the uploader's. The row's file, index and uploader need no check of
 * their own: they are signed, and the signature is the one the manifest lists
 * at this index.
 */
export const verifyChunkRow = (manifest: VerifiedManifest, index: number, row: Record<string, unknown>): string => {
	const refuse = (detail: string) => new FileVerificationError(manifest.fileId, 'invalid', detail, index);
	const listed = manifest.chunkSignHashes[index];
	if (!listed) throw refuse(`the manifest has ${manifest.chunkCount} chunks`);
	if (typeof row.sign_b64 !== 'string' || !row.sign_b64 || !equalBytes(sha3_512(toBytes(row.sign_b64)), listed)) {
		throw refuse('its row carries a signature the manifest does not list');
	}
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

/** Per index: the expected hash, `null` while the row has not arrived, `false` when the row is refused. */
export type ChunkHashList = Array<string | null | false>;

/**
 * Expected chunk hashes of one verified file. Chunk rows replicate after the
 * manifest and one by one, so they are read once, and again when an index is
 * missing; a row is verified the first time it is needed.
 */
export class ChunkHashes {
	private rows: Map<number, Record<string, unknown>> | null = null;
	private readonly expectedByIndex = new Map<number, string>();

	constructor(
		readonly manifest: VerifiedManifest,
		private readonly signal?: AbortSignal,
	) {}

	private async load(fresh: boolean): Promise<Map<number, Record<string, unknown>>> {
		if (this.rows && !fresh) return this.rows;
		const rows = await readShapeOnce<Record<string, unknown>>('file_chunks', `file_id='${this.manifest.fileId}'`, this.signal);
		this.rows = new Map(rows.map((r) => [Number(r.chunk_index), r]));
		return this.rows;
	}

	/** The hash chunk `index` must have; throws `unavailable` while its row is missing, `invalid` if it is refused. */
	async expected(index: number): Promise<string> {
		const known = this.expectedByIndex.get(index);
		if (known) return known;
		const row = (await this.load(false)).get(index) ?? (await this.load(true)).get(index);
		if (!row) throw new FileVerificationError(this.manifest.fileId, 'unavailable', 'its signed row has not arrived', index);
		const hash = verifyChunkRow(this.manifest, index, row);
		this.expectedByIndex.set(index, hash);
		return hash;
	}

	/** Every index at once, for a consumer that cannot verify rows itself. `fresh` re-reads the rows. */
	async list(fresh = false): Promise<ChunkHashList> {
		const rows = await this.load(fresh);
		return Array.from({ length: this.manifest.chunkCount }, (_, index) => {
			const known = this.expectedByIndex.get(index);
			if (known) return known;
			const row = rows.get(index);
			if (!row) return null;
			try {
				const hash = verifyChunkRow(this.manifest, index, row);
				this.expectedByIndex.set(index, hash);
				return hash;
			} catch {
				return false;
			}
		});
	}
}

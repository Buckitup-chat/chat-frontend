// Uploads that outlive the page (pq_files §4.1). The transfer queue keeps one
// record per composed message: its peer and caption, the parts already
// uploaded, and per file still uploading the file_id and enc_secret, written
// before the file's first chunk PUT. After a reload the queue shows those files
// paused, and the same file picked again resumes where the device stopped.
// The record holds keys that open content, so it is sealed with the account's
// local key (docs/invariants.md §1).

import { accountSealedStore } from './accountSealedStore';
import { CHUNK_SIZE } from '@buckitup/pq-client/fileCrypto';

/** The server drops the chunks of an upload left uncommitted for 48 hours (pq_files §8). */
export const PENDING_UPLOAD_TTL_MS = 48 * 60 * 60 * 1000;

export interface PendingFile {
	/** Position in the composed message. */
	order: number;
	name: string;
	size: number;
	mimeType: string;
	createdAt: number;
	fileId: string;
	encSecretB64: string;
	chunkSize: number;
	chunkCount: number;
	/** uploadDigest() of the bytes, recorded before the first chunk PUT; absent when nothing was sent. */
	digest?: string;
}

export interface PendingBatch {
	batchId: string;
	peerHash: string;
	caption: string;
	/** Files uploaded already, as the message will carry them. */
	parts: { order: number; part: Record<string, unknown> }[];
	files: PendingFile[];
	updatedAt: number;
}

const store = accountSealedStore('buckitup-pending-uploads');

export const _setPendingUploadsStoreForTests = store.setForTests;

const isPendingFile = (f: PendingFile): boolean =>
	[f?.fileId, f?.encSecretB64, f?.name, f?.mimeType].every((v) => typeof v === 'string')
	&& [f.order, f.size, f.chunkCount, f.createdAt].every(Number.isInteger)
	// Chunks cut at another size cannot join the ones on the device.
	&& f.chunkSize === CHUNK_SIZE
	&& (f.digest === undefined || typeof f.digest === 'string');

const isPendingBatch = (b: PendingBatch): boolean =>
	typeof b?.batchId === 'string' && typeof b.peerHash === 'string' && typeof b.caption === 'string'
	&& typeof b.updatedAt === 'number' && Array.isArray(b.parts) && Array.isArray(b.files)
	// A record is kept only while a file is still uploading (transfers.store.js).
	&& b.files.length > 0 && b.files.every(isPendingFile);

export const savePendingBatch = (owner: string, batch: PendingBatch): Promise<void> =>
	store.sealed(owner).set(store.keyOf(owner, batch.batchId), JSON.stringify(batch));

export const forgetPendingBatch = (owner: string, batchId: string): Promise<void> => store.raw.delete(store.keyOf(owner, batchId));

/**
 * The owner's records still worth resuming. A malformed record or one past
 * PENDING_UPLOAD_TTL_MS is removed; one that does not open is left alone and
 * skipped, like every sealed record (docs/persistence-encryption.md).
 */
export const pendingBatches = async (owner: string, now = Date.now()): Promise<PendingBatch[]> => {
	const found: PendingBatch[] = [];
	for (const key of await store.raw.keys()) {
		if (!store.isOwners(owner, key)) continue;
		let stored: string | null;
		try {
			stored = await store.sealed(owner).get(key);
		} catch (e) {
			console.warn('[pendingUploads] a record did not open:', e);
			continue;
		}
		let batch: PendingBatch | null = null;
		try {
			batch = stored === null ? null : JSON.parse(stored);
		} catch { /* malformed: removed below */ }
		if (batch && isPendingBatch(batch) && now - batch.updatedAt <= PENDING_UPLOAD_TTL_MS) found.push(batch);
		else await store.raw.delete(key);
	}
	return found;
};

export const forgetAccountPendingUploads = (owner: string): Promise<void> => store.forgetAccount(owner);

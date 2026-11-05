// Uploads that outlive the page (pq_files §4.1). The transfer queue keeps one
// record per composed message: its peer and caption, the parts already
// uploaded, and per file still uploading the file_id and enc_secret, written
// before the file's first chunk PUT. After a reload the queue shows those files
// paused, and the same file picked again resumes where the device stopped.
// The record holds keys that open content, so it is sealed with the account's
// local key (docs/invariants.md §1).

import { IndexedDbStore } from './indexedDbStore';
import { createSecureStore, type StringStore } from './secureStore';
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

let raw: StringStore = new IndexedDbStore('buckitup-pending-uploads');
let keyFor = async (owner: string): Promise<CryptoKey> =>
	(await import('./localCrypto')).getLocalStorageKeyFor(owner);

export const _setPendingUploadsStoreForTests = (store: StringStore, key?: (owner: string) => Promise<CryptoKey>): void => {
	raw = store;
	if (key) keyFor = key;
};

const sealed = (owner: string): StringStore => createSecureStore(raw, { getKey: () => keyFor(owner) });
const prefix = (owner: string) => `${owner}|`;

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
	sealed(owner).set(prefix(owner) + batch.batchId, JSON.stringify(batch));

export const forgetPendingBatch = (owner: string, batchId: string): Promise<void> => raw.delete(prefix(owner) + batchId);

/**
 * The owner's records still worth resuming. A malformed record or one past
 * PENDING_UPLOAD_TTL_MS is removed; one that does not open is left alone and
 * skipped, like every sealed record (docs/persistence-encryption.md).
 */
export const pendingBatches = async (owner: string, now = Date.now()): Promise<PendingBatch[]> => {
	const found: PendingBatch[] = [];
	for (const key of await raw.keys()) {
		if (!key.startsWith(prefix(owner))) continue;
		let stored: string | null;
		try {
			stored = await sealed(owner).get(key);
		} catch (e) {
			console.warn('[pendingUploads] a record did not open:', e);
			continue;
		}
		let batch: PendingBatch | null = null;
		try {
			batch = stored === null ? null : JSON.parse(stored);
		} catch { /* malformed: removed below */ }
		if (batch && isPendingBatch(batch) && now - batch.updatedAt <= PENDING_UPLOAD_TTL_MS) found.push(batch);
		else await raw.delete(key);
	}
	return found;
};

export const forgetAccountPendingUploads = async (owner: string): Promise<void> => {
	for (const key of await raw.keys()) if (key.startsWith(prefix(owner))) await raw.delete(key);
};

// Uploads that outlive the page (pq_files §4.1). The transfer queue keeps one
// record per composed message: its peer and caption, the parts already
// uploaded, and per file still uploading the file_id and enc_secret, written
// before the file's first chunk PUT. After a reload the queue shows those files
// paused, and the same file picked again resumes where the device stopped; a
// record whose files had all landed has its message stored for sending.
// The record holds keys that open content, so it is sealed with the account's
// local key (docs/invariants.md §1).

import { accountSealedStore } from './accountSealedStore';
import type { StringStore } from './secureStore';
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

// As stored, a record is its write time in the clear beside the sealed rest.
// The time is not content; kept outside the seal, it lets any account's
// sign-in remove the expired records of every account on this device,
// including one that never signs in here again.
interface Stored {
	updatedAt: number;
	sealed: string;
}

const storedOf = (value: string | null): Stored | null => {
	if (value === null) return null;
	try {
		const stored = JSON.parse(value) as Stored;
		return typeof stored?.updatedAt === 'number' && typeof stored.sealed === 'string' ? stored : null;
	} catch {
		return null;
	}
};

/** The raw store seen through the envelope; what it writes carries `updatedAt`. */
const enveloped = (updatedAt?: number): StringStore => ({
	get: async (key) => storedOf(await store.raw.get(key))?.sealed ?? null,
	set: (key, sealed) => store.raw.set(key, JSON.stringify({ updatedAt, sealed })),
	delete: (key) => store.raw.delete(key),
	keys: () => store.raw.keys(),
	clear: () => store.raw.clear(),
});

const isPendingFile = (f: PendingFile): boolean =>
	[f?.fileId, f?.encSecretB64, f?.name, f?.mimeType].every((v) => typeof v === 'string')
	&& [f.order, f.size, f.chunkCount, f.createdAt].every(Number.isInteger)
	// Chunks cut at another size cannot join the ones on the device.
	&& f.chunkSize === CHUNK_SIZE
	&& (f.digest === undefined || typeof f.digest === 'string');

const isPendingBatch = (b: PendingBatch): boolean =>
	typeof b?.batchId === 'string' && typeof b.peerHash === 'string' && typeof b.caption === 'string'
	&& Array.isArray(b.parts) && Array.isArray(b.files)
	// A record is kept only while its message has something to send (transfers.store.js).
	&& (b.files.length > 0 || b.parts.length > 0) && b.files.every(isPendingFile);

export const savePendingBatch = (owner: string, { updatedAt, ...content }: PendingBatch): Promise<void> =>
	store.sealed(owner, enveloped(updatedAt)).set(store.keyOf(owner, content.batchId), JSON.stringify(content));

export const forgetPendingBatch = (owner: string, batchId: string): Promise<void> => store.raw.delete(store.keyOf(owner, batchId));

/**
 * The owner's records still worth resuming. Removes every account's records
 * past PENDING_UPLOAD_TTL_MS or not in the stored form, with no key, and a
 * malformed record of the owner; one that does not open is left alone and
 * skipped, like every sealed record (docs/persistence-encryption.md).
 */
export const pendingBatches = async (owner: string, now = Date.now()): Promise<PendingBatch[]> => {
	const found: PendingBatch[] = [];
	for (const key of await store.raw.keys()) {
		const stored = storedOf(await store.raw.get(key));
		if (!stored || now - stored.updatedAt > PENDING_UPLOAD_TTL_MS) {
			await store.raw.delete(key);
			continue;
		}
		if (!store.isOwners(owner, key)) continue;
		let content: string | null;
		try {
			// The record read above, opened without reading it again.
			content = await store.sealed(owner, { ...enveloped(), get: async () => stored.sealed }).get(key);
		} catch (e) {
			console.warn('[pendingUploads] a record did not open:', e);
			continue;
		}
		let batch: PendingBatch | null = null;
		try {
			batch = content === null ? null : { ...JSON.parse(content), updatedAt: stored.updatedAt };
		} catch { /* malformed: removed below */ }
		if (batch && isPendingBatch(batch)) found.push(batch);
		else await store.raw.delete(key);
	}
	return found;
};

export const forgetAccountPendingUploads = (owner: string): Promise<void> => store.forgetAccount(owner);

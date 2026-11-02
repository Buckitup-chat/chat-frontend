// Files an account keeps on this device ("Keep on this device").
//
// A kept file is its ciphertext chunks in the chunk cache, pinned for the
// account so eviction skips them (chunkCache.ts), plus one entry in the
// account's index. The entry carries everything opening the file needs —
// the secret, the name and type, and each chunk's signed data hash — so the
// copy opens with no message, no manifest and no network: offline, after the
// uploader deleted the file, or after the message carrying it was deleted.
//
// The index is one record per account, sealed under the account's local
// storage key: another account on the device sees neither which files it
// keeps nor their secrets. Its record name carries the account hash in the
// clear (local metadata need not be hidden, docs/invariants.md §1), so the
// record goes with the account without its key. Plaintext never touches disk.
//
// A kept copy stays on this device only: it is not written to User Storage
// and does not sync to the account's other devices.

import { IndexedDbStore } from './indexedDbStore';
import { createSecureStore, type StringStore } from './secureStore';
import { serialized } from './serialized';
import { fileKey } from './fileKey';
import { downloadFile, pinFileChunks, readKeptChunks, type DownloadProgress } from './fileTransfer';
import { pinnedBytesOf, unpinAllOf, unpinFile } from './chunkCache';
import type { SignPkeyResolver } from './rowVerification';

export interface KeptFile {
	/** `uploaderHash/fileId` (fileKey.ts). */
	fileKey: string;
	fileId: string;
	uploaderHash: string;
	encSecretB64: string;
	kind: string;
	name: string;
	size: number;
	mimeType: string;
	createdAt: number;
	dialogHash: string;
	messageId: string;
	/** The sender of the message carrying the file. */
	senderHash: string;
	/** Unix seconds. */
	keptAt: number;
	/** Each chunk's signed data hash, in index order, as verified when the file was kept. */
	chunkHashes: string[];
}

/** By fileKey. */
export type KeptIndex = Record<string, KeptFile>;

/** A file part as decryptMessageRow builds it. */
export interface KeepablePart {
	kind?: string;
	fileId: string;
	uploaderHash: string;
	encSecretB64: string;
	name?: string;
	size?: number;
	mimeType?: string;
	createdAt?: number;
}

export interface KeepContext {
	dialogHash: string;
	messageId: string;
	senderHash: string;
}

let raw: StringStore = new IndexedDbStore('buckitup-kept-files');
let keyFor = async (owner: string): Promise<CryptoKey> => (await import('./localCrypto')).getLocalStorageKeyFor(owner);

export const _setKeptFilesStoreForTests = (store: StringStore, key?: (owner: string) => Promise<CryptoKey>): void => {
	raw = store;
	if (key) keyFor = key;
};

const sealed = (owner: string): StringStore => createSecureStore(raw, { getKey: () => keyFor(owner) });
const indexKey = (owner: string) => `${owner}|kept`;
const locks = new Map<string, Promise<unknown>>();

/** What `owner` keeps on this device. Throws while the account is locked. */
export const listKeptFiles = async (owner: string): Promise<KeptIndex> => {
	const value = await sealed(owner).get(indexKey(owner));
	return value ? (JSON.parse(value) as KeptIndex) : {};
};

const updateIndex = (owner: string, change: (index: KeptIndex) => void): Promise<KeptIndex> =>
	serialized(locks, owner, async () => {
		const index = await listKeptFiles(owner);
		change(index);
		await sealed(owner).set(indexKey(owner), JSON.stringify(index));
		return index;
	});

/**
 * Keeps a file for `owner`: pins its chunks, fetching the missing ones with
 * `onProgress`, then records it in the index. Throws if any step fails — a
 * full disk as the browser's QuotaExceededError — and then nothing of it
 * stays pinned for `owner`.
 */
export const keepFile = async (
	owner: string,
	part: KeepablePart,
	ctx: KeepContext,
	opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal; resolveSignPkey?: SignPkeyResolver } = {},
): Promise<KeptFile> => {
	const key = fileKey(part);
	const index = await listKeptFiles(owner);
	if (index[key]) return index[key];
	// Chunks are stored by file id; another sender's file under the same id
	// would share them, and releasing one would release the other.
	if (Object.values(index).some((f) => f.fileId === part.fileId)) {
		throw new Error('Another file with the same id is already kept on this device.');
	}
	try {
		const chunkHashes = await pinFileChunks({
			fileId: part.fileId, uploaderHash: part.uploaderHash, encSecretB64: part.encSecretB64, owner, ...opts,
		});
		const entry: KeptFile = {
			fileKey: key,
			fileId: part.fileId,
			uploaderHash: part.uploaderHash,
			encSecretB64: part.encSecretB64,
			kind: part.kind ?? 'file',
			name: part.name ?? '',
			size: part.size ?? 0,
			mimeType: part.mimeType ?? '',
			createdAt: part.createdAt ?? 0,
			dialogHash: ctx.dialogHash,
			messageId: ctx.messageId,
			senderHash: ctx.senderHash,
			keptAt: Math.floor(Date.now() / 1000),
			chunkHashes,
		};
		await updateIndex(owner, (current) => { current[key] = entry; });
		return entry;
	} catch (e) {
		await unpinFile(part.fileId, owner).catch((err) => console.warn('[keptFiles] could not release the pins of a failed keep', err));
		throw e;
	}
};

/** `owner` stops keeping the file: its chunks become cache again unless another account keeps them. */
export const releaseKeptFile = async (owner: string, key: string): Promise<void> => {
	let removed: KeptFile | undefined;
	await updateIndex(owner, (index) => {
		removed = index[key];
		delete index[key];
	});
	if (removed) await unpinFile(removed.fileId, owner);
};

/** The kept copy's bytes, decrypted from this device alone; null when `owner` does not keep the file. */
export const openKeptFile = async (
	owner: string,
	key: string,
	opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
): Promise<Uint8Array | null> => {
	const entry = (await listKeptFiles(owner))[key];
	if (!entry) return null;
	return readKeptChunks({ fileId: entry.fileId, encSecretB64: entry.encSecretB64, dataHashes: entry.chunkHashes, ...opts });
};

/**
 * A file's bytes for the chat: from the kept copy when `owner` keeps it,
 * otherwise — or when the kept copy cannot be read — downloaded.
 */
export const openFile = async (
	owner: string | null | undefined,
	part: KeepablePart,
	opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
): Promise<Uint8Array> => {
	if (owner) {
		try {
			const kept = await openKeptFile(owner, fileKey(part), opts);
			if (kept) return kept;
		} catch (e) {
			console.warn('[keptFiles] the kept copy could not be read; downloading instead', e);
		}
	}
	return downloadFile({ fileId: part.fileId, uploaderHash: part.uploaderHash, encSecretB64: part.encSecretB64, ...opts });
};

/** Bytes `owner` keeps on this device; readable without the account's key. */
export const keptBytesOf = (owner: string): Promise<number> => pinnedBytesOf(owner);

/** Removes everything `owner` keeps: called when the account leaves this device. */
export const forgetAccountKeptFiles = async (owner: string): Promise<void> => {
	// Each half runs whatever the other did: a missing index must not leave pins behind.
	const [index, pins] = await Promise.allSettled([raw.delete(indexKey(owner)), unpinAllOf(owner)]);
	for (const r of [index, pins]) if (r.status === 'rejected') throw r.reason;
};

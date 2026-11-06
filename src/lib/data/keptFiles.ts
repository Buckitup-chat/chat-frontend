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
import { withNamedLock } from './serialized';
import { fileKey } from './fileKey';
import { downloadFile, pinFileChunks, readKeptChunks, type DownloadProgress } from './fileTransfer';
import { unpinAllOf, unpinFile } from './chunkCache';
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
	/** The message that carried the file: a deleted message still shows its kept copies. */
	messageId: string;
	/** Each chunk's signed data hash, in index order, as verified when the file was kept. */
	chunkHashes: string[];
	peerHash?: string;
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

let raw: StringStore = new IndexedDbStore('buckitup-kept-files');
let keyFor = async (owner: string): Promise<CryptoKey> => (await import('./localCrypto')).getLocalStorageKeyFor(owner);

export const _setKeptFilesStoreForTests = (store: StringStore, key?: (owner: string) => Promise<CryptoKey>): void => {
	raw = store;
	if (key) keyFor = key;
	unsealed = null;
};

const sealed = (owner: string): StringStore => createSecureStore(raw, { getKey: () => keyFor(owner) });
const indexKey = (owner: string) => `${owner}|kept`;
/**
 * Locks across tabs. The index lock covers one read-change-write of an
 * account's index, each from the index as stored, so no tab writes back an
 * index another tab has changed since. The file lock covers a keep or a
 * release of one file id, download included, so a failed keep releases only
 * its own pins. Taken in that order: file, then index.
 */
const underIndexLock = <T>(owner: string, fn: () => Promise<T>): Promise<T> => withNamedLock(`buckitup-kept-files:${owner}`, fn);
const underFileLock = <T>(owner: string, fileId: string, fn: () => Promise<T>): Promise<T> =>
	withNamedLock(`buckitup-kept-files:${owner}|${fileId}`, fn);

/**
 * The open account's index as last read or written by this tab: opening any
 * file asks whether it is kept, and that must not unseal the index every
 * time. Another tab's change shows here after a reload.
 */
let unsealed: { owner: string; index: KeptIndex } | null = null;

const readIndex = async (owner: string): Promise<KeptIndex> => {
	const value = await sealed(owner).get(indexKey(owner));
	const index = value ? (JSON.parse(value) as KeptIndex) : {};
	unsealed = { owner, index };
	return { ...index };
};

const writeIndex = async (owner: string, index: KeptIndex): Promise<void> => {
	await sealed(owner).set(indexKey(owner), JSON.stringify(index));
	unsealed = { owner, index: { ...index } };
};

/** What `owner` keeps on this device; a copy. Throws unless `owner` is the open, unlocked account. */
export const listKeptFiles = async (owner: string): Promise<KeptIndex> => {
	// Asked every time, cached index or not: after logout or a switch the key is gone.
	await keyFor(owner);
	return unsealed?.owner === owner ? { ...unsealed.index } : readIndex(owner);
};

/**
 * Keeps a file for `owner`: pins its chunks, fetching the missing ones with
 * `onProgress`, then records it in the index. Throws if any step fails — a
 * full disk as the browser's QuotaExceededError — and then nothing of it
 * stays pinned for `owner`. A keep or release of the same file id waits
 * until it is done.
 */
export const keepFile = (
	owner: string,
	part: KeepablePart,
	messageId: string,
	opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal; resolveSignPkey?: SignPkeyResolver; peerHash?: string } = {},
): Promise<KeptFile> => underFileLock(owner, part.fileId, async () => {
	const key = fileKey(part);
	const index = await readIndex(owner);
	if (index[key]) return index[key];
	// Chunks are stored by file id; another sender's file under the same id
	// would share them, and releasing one would release the other.
	if (Object.values(index).some((f) => f.fileId === part.fileId)) {
		throw new Error('Another file with the same id is already kept on this device.');
	}
	try {
		const { peerHash, ...transfer } = opts;
		const chunkHashes = await pinFileChunks({
			fileId: part.fileId, uploaderHash: part.uploaderHash, encSecretB64: part.encSecretB64, owner, ...transfer,
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
			messageId,
			chunkHashes,
			...(peerHash ? { peerHash } : {}),
		};
		await underIndexLock(owner, async () => writeIndex(owner, { ...(await readIndex(owner)), [key]: entry }));
		return entry;
	} catch (e) {
		// Under the file lock, with no entry for this file id: every pin `owner` holds on it is this keep's.
		await unpinFile(part.fileId, owner).catch((err) => console.warn('[keptFiles] could not release the pins of a failed keep', err));
		throw e;
	}
});

/** `owner` stops keeping the file: its chunks become cache again unless another account keeps them. */
export const releaseKeptFile = (owner: string, key: string): Promise<void> =>
	underFileLock(owner, key.slice(key.lastIndexOf('/') + 1), async () => {
		const removed = await underIndexLock(owner, async () => {
			const index = await readIndex(owner);
			const entry = index[key];
			if (entry) {
				delete index[key];
				await writeIndex(owner, index);
			}
			return entry;
		});
		if (removed) await unpinFile(removed.fileId, owner);
	});

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

export const readKeptCopy = async (
	owner: string | null | undefined,
	part: KeepablePart,
	opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
): Promise<Uint8Array | null> => {
	if (!owner) return null;
	try {
		return await openKeptFile(owner, fileKey(part), opts);
	} catch (e) {
		console.warn('[keptFiles] the kept copy could not be read; downloading instead', e);
		return null;
	}
};

/**
 * A file's bytes for the chat: from the kept copy when `owner` keeps it,
 * otherwise — or when the kept copy cannot be read — downloaded.
 */
export const openFile = async (
	owner: string | null | undefined,
	part: KeepablePart,
	opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
): Promise<Uint8Array> =>
	(await readKeptCopy(owner, part, opts))
	?? downloadFile({ fileId: part.fileId, uploaderHash: part.uploaderHash, encSecretB64: part.encSecretB64, ...opts });

/** Removes everything `owner` keeps: called when the account leaves this device. */
export const forgetAccountKeptFiles = async (owner: string): Promise<void> => {
	if (unsealed?.owner === owner) unsealed = null;
	// Each half runs whatever the other did: a missing index must not leave pins behind.
	const [index, pins] = await Promise.allSettled([raw.delete(indexKey(owner)), unpinAllOf(owner)]);
	for (const r of [index, pins]) if (r.status === 'rejected') throw r.reason;
};

import { IndexedDbStore } from './indexedDbStore';
import { createSecureStore, type StringStore } from './secureStore';

interface SavedUpload {
	fileId: string;
	encSecretB64: string;
}

let raw: StringStore = new IndexedDbStore('buckitup-upload-reuse');
let keyFor = async (owner: string): Promise<CryptoKey> =>
	(await import('./localCrypto')).getLocalStorageKeyFor(owner);

export const _setUploadReuseStoreForTests = (store: StringStore, key?: (owner: string) => Promise<CryptoKey>): void => {
	raw = store;
	if (key) keyFor = key;
};

const sealed = (owner: string): StringStore => createSecureStore(raw, { getKey: () => keyFor(owner) });
const recordKey = (owner: string, digest: string) => `${owner}|${digest}`;

export const uploadDigest = async (bytes: Uint8Array): Promise<string> => {
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const reusableUpload = async (
	owner: string,
	digest: string,
	availability: (fileId: string, owner: string) => Promise<{ unknown: boolean; deleted: boolean; present: number; total: number }>,
): Promise<SavedUpload | null> => {
	const key = recordKey(owner, digest);
	const stored = await sealed(owner).get(key);
	if (!stored) return null;
	let saved: SavedUpload;
	try {
		saved = JSON.parse(stored) as SavedUpload;
		if (typeof saved.fileId !== 'string' || typeof saved.encSecretB64 !== 'string') throw new Error('invalid upload reference');
	} catch {
		await raw.delete(key);
		return null;
	}
	try {
		const available = await availability(saved.fileId, owner);
		if (!available.unknown && !available.deleted && available.total > 0 && available.present === available.total) return saved;
		if (available.deleted) await raw.delete(key);
	} catch {
		await raw.delete(key);
	}
	return null;
};

export const rememberUpload = (owner: string, digest: string, upload: SavedUpload): Promise<void> =>
	sealed(owner).set(recordKey(owner, digest), JSON.stringify(upload));

export const forgetAccountUploads = async (owner: string): Promise<void> => {
	for (const key of await raw.keys()) if (key.startsWith(`${owner}|`)) await raw.delete(key);
};

import { accountSealedStore } from './accountSealedStore';

interface SavedUpload {
	fileId: string;
	encSecretB64: string;
}

const store = accountSealedStore('buckitup-upload-reuse');

export const _setUploadReuseStoreForTests = store.setForTests;

export const uploadDigest = async (bytes: Uint8Array): Promise<string> => {
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const reusableUpload = async (
	owner: string,
	digest: string,
	availability: (fileId: string, owner: string) => Promise<{ unknown: boolean; deleted: boolean; present: number; total: number }>,
): Promise<SavedUpload | null> => {
	const key = store.keyOf(owner, digest);
	const stored = await store.sealed(owner).get(key);
	if (!stored) return null;
	let saved: SavedUpload;
	try {
		saved = JSON.parse(stored) as SavedUpload;
		if (typeof saved.fileId !== 'string' || typeof saved.encSecretB64 !== 'string') throw new Error('invalid upload reference');
	} catch {
		await store.raw.delete(key);
		return null;
	}
	try {
		const available = await availability(saved.fileId, owner);
		if (!available.unknown && !available.deleted && available.total > 0 && available.present === available.total) return saved;
		if (available.deleted) await store.raw.delete(key);
	} catch {
		await store.raw.delete(key);
	}
	return null;
};

export const rememberUpload = (owner: string, digest: string, upload: SavedUpload): Promise<void> =>
	store.sealed(owner).set(store.keyOf(owner, digest), JSON.stringify(upload));

export const forgetAccountUploads = (owner: string): Promise<void> => store.forgetAccount(owner);

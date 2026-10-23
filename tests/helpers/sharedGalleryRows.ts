import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64, type SignableFields } from '@/lib/pq/signature';
import { signableFields } from '@/lib/pq/schema';
import { photoToWire, type ImagePart } from '@/lib/pq/content';
import type { UserStorageRow } from '@/lib/data/types';
import type { SharedGalleryRecord } from '@/lib/avatars/sharedGallery';

export const galleryAccount = (seed: number) => {
	const keys = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	return { ...keys, userHash: 'u_' + bytesToHex(sha3_512(keys.publicKey)) };
};
type GalleryAccount = ReturnType<typeof galleryAccount>;

export const signPkeyResolver = (...accounts: GalleryAccount[]) => {
	const cards = new Map(accounts.map((a) => [a.userHash, toBase64(a.publicKey)]));
	return async (userHash: string) => cards.get(userHash) ?? null;
};

const galleryPhoto = (n: number): ImagePart => ({
	kind: 'image', widthAspect: 4, heightAspect: 3, thumbHashB64: 'thumb', name: `p${n}.jpg`, size: 1000 + n,
	mimeType: 'image/jpeg', createdAt: 1_780_000_000, fileId: 'f_' + String(n).repeat(32).slice(0, 32),
	encSecretB64: toBase64(new Uint8Array(32).fill(n)),
});

export const galleryRecord = (...entries: Array<[string, number, number]>): SharedGalleryRecord => ({
	version: 1,
	avatars: Object.fromEntries(entries.map(([avatarId, n, at]) => [avatarId, { photo: photoToWire(galleryPhoto(n)), at }])),
});

export const signStorageRow = (signer: GalleryAccount, fields: Partial<UserStorageRow>): UserStorageRow => {
	const row = {
		user_hash: signer.userHash, uuid: '', value_b64: '', deleted_flag: false,
		parent_sign_hash: null, owner_timestamp: 1_780_000_001, ...fields,
	} as UserStorageRow;
	const signB64 = signFields(signableFields('user_storage', row) as SignableFields, signer.secretKey);
	return { ...row, sign_b64: signB64, sign_hash: deriveSignHash('uss_', signB64) };
};

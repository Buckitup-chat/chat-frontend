import { randomBytes } from '@noble/hashes/utils';
import { isAvatarId, isGalleryKeyB64, isGalleryUuid, photoFromWire } from '@/lib/pq/content';
import { fromBase64, toBase64, toBytes } from '@/lib/pq/signature';
import { wireBool } from '@/lib/pq/schema';
import { verifyReplicatedRow, type RowInvalidReason, type SignPkeyResolver } from '@/lib/data/rowVerification';
import type { UserStorageRow } from '@/lib/data/types';
import { ALLOWED_IMAGE_TYPES, ownGalleryOf, type GalleryEntry } from './gallery';

export const SHARED_GALLERY_VERSION = 1;
const SHARED_GALLERY_PURPOSE = 'buckitup/avatar-gallery';
export const SHARED_GALLERY_MAX_ENTRIES = 100;
const MAX_PAYLOAD_CHARS = 256 * 1024;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const USER_HASH = /^u_[0-9a-f]{128}$/;
const FILE_ID = /^f_[0-9a-f]{32}$/;

export interface SharedGalleryEntryWire {
	photo: unknown;
	at: number;
}

export interface SharedGalleryRecord {
	version: typeof SHARED_GALLERY_VERSION;
	avatars: Record<string, SharedGalleryEntryWire>;
}

export const galleryKeyFromB64 = (b64: string): Uint8Array => {
	if (!isGalleryKeyB64(b64)) throw new TypeError('not a gallery key');
	return fromBase64(b64);
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v);

const hasExactKeys = (obj: Record<string, unknown>, keys: string[]): boolean => {
	const own = Object.keys(obj);
	return own.length === keys.length && keys.every((k) => Object.hasOwn(obj, k));
};

const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isNonNegativeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isPositiveNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

const isFileSecret = (b64: string): boolean => {
	try {
		return toBytes(b64).length === 32;
	} catch {
		return false;
	}
};

const photoProblem = (wire: unknown): string | null => {
	if (!isPlainObject(wire) || !hasExactKeys(wire, ['image'])) return 'photo is not an out-of-band image';
	const im = wire.image;
	if (!Array.isArray(im) || im.length < 9) return 'image element too short';
	const [width, height, thumbHash, name, size, mimeType, createdAt, fileId, encSecret] = im;
	if (!isPositiveNumber(width) || !isPositiveNumber(height)) return 'image aspect';
	if (typeof thumbHash !== 'string' || typeof name !== 'string') return 'image thumbhash or name';
	if (!isPositiveInt(size)) return 'image size';
	if (typeof mimeType !== 'string' || !ALLOWED_IMAGE_TYPES.includes(mimeType)) return 'image mime type';
	if (!isNonNegativeInt(createdAt)) return 'image creation time';
	if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) return 'image file id';
	if (typeof encSecret !== 'string' || !isFileSecret(encSecret)) return 'image file secret';
	return photoFromWire(wire)?.kind === 'image' ? null : 'image element';
};

const payloadProblem = (value: Record<string, unknown>): string | null => {
	if (!hasExactKeys(value, ['version', 'avatars'])) return 'payload keys';
	const avatars = value.avatars;
	if (!isPlainObject(avatars)) return 'avatars is not a map';
	const entries = Object.entries(avatars);
	if (entries.length > SHARED_GALLERY_MAX_ENTRIES) return 'too many avatars';
	for (const [avatarId, entry] of entries) {
		if (!isAvatarId(avatarId)) return 'avatar id';
		if (!isPlainObject(entry) || !hasExactKeys(entry, ['photo', 'at'])) return 'avatar entry keys';
		if (!isPositiveInt(entry.at)) return 'avatar entry at';
		const problem = photoProblem(entry.photo);
		if (problem) return problem;
	}
	return null;
};

export type PayloadDecode =
	| { ok: true; record: SharedGalleryRecord }
	| { ok: false; state: 'unsupported_version'; version: number }
	| { ok: false; state: 'invalid_payload'; reason: string };

export const encodeSharedGallery = (record: SharedGalleryRecord): string => {
	const json = JSON.stringify({ version: record.version, avatars: record.avatars });
	const decoded = decodeSharedGallery(json);
	if (!decoded.ok) {
		const problem = decoded.state === 'invalid_payload' ? decoded.reason : `version ${decoded.version}`;
		throw new TypeError(`malformed shared gallery: ${problem}`);
	}
	return json;
};

export const decodeSharedGallery = (json: string): PayloadDecode => {
	if (json.length > MAX_PAYLOAD_CHARS) return { ok: false, state: 'invalid_payload', reason: 'payload too large' };
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return { ok: false, state: 'invalid_payload', reason: 'payload is not JSON' };
	}
	if (!isPlainObject(value)) return { ok: false, state: 'invalid_payload', reason: 'payload is not an object' };
	if (!Number.isSafeInteger(value.version)) return { ok: false, state: 'invalid_payload', reason: 'version' };
	if (value.version !== SHARED_GALLERY_VERSION) return { ok: false, state: 'unsupported_version', version: value.version as number };
	const problem = payloadProblem(value);
	if (problem) return { ok: false, state: 'invalid_payload', reason: problem };
	return { ok: true, record: value as unknown as SharedGalleryRecord };
};

export interface GalleryAddress {
	ownerHash: string;
	galleryUuid: string;
}

export const galleryAad = ({ ownerHash, galleryUuid }: GalleryAddress, version = SHARED_GALLERY_VERSION): Uint8Array => {
	if (!USER_HASH.test(ownerHash)) throw new TypeError('not a user hash');
	if (!isGalleryUuid(galleryUuid)) throw new TypeError('not a gallery uuid');
	return new TextEncoder().encode(`${SHARED_GALLERY_PURPOSE}\n${version}\n${ownerHash}\n${galleryUuid}`);
};

const importKey = (key: Uint8Array, use: 'encrypt' | 'decrypt') => {
	if (!(key instanceof Uint8Array) || key.length !== 32) throw new TypeError('the gallery key must be 32 bytes');
	return crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [use]);
};

export const sealSharedGallery = async (address: GalleryAddress, key: Uint8Array, record: SharedGalleryRecord): Promise<string> => {
	const plaintext = new TextEncoder().encode(encodeSharedGallery(record));
	const nonce = randomBytes(NONCE_BYTES);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: nonce, additionalData: galleryAad(address) },
		await importKey(key, 'encrypt'),
		plaintext,
	));
	const out = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
	out[0] = SHARED_GALLERY_VERSION;
	out.set(nonce, 1);
	out.set(ciphertext, 1 + NONCE_BYTES);
	return toBase64(out);
};

export type OpenResult =
	| PayloadDecode
	| { ok: false; state: 'decrypt_failed'; reason: 'format' | 'key' };

export const openSharedGallery = async (address: GalleryAddress, key: Uint8Array, valueB64: string | Uint8Array): Promise<OpenResult> => {
	let bytes: Uint8Array;
	try {
		bytes = toBytes(valueB64);
	} catch {
		return { ok: false, state: 'decrypt_failed', reason: 'format' };
	}
	if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES) return { ok: false, state: 'decrypt_failed', reason: 'format' };
	if (bytes[0] !== SHARED_GALLERY_VERSION) return { ok: false, state: 'unsupported_version', version: bytes[0] };
	const aad = galleryAad(address);
	const cryptoKey = await importKey(key, 'decrypt');
	let plaintext: ArrayBuffer;
	try {
		plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: bytes.subarray(1, 1 + NONCE_BYTES), additionalData: aad },
			cryptoKey,
			bytes.subarray(1 + NONCE_BYTES),
		);
	} catch {
		return { ok: false, state: 'decrypt_failed', reason: 'key' };
	}
	let json: string;
	try {
		json = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
	} catch {
		return { ok: false, state: 'invalid_payload', reason: 'payload is not UTF-8' };
	}
	return decodeSharedGallery(json);
};

export type GalleryRowRead =
	| { kind: 'rows'; rows: UserStorageRow[] }
	| { kind: 'blocked' }
	| { kind: 'failed' };

export type SharedGalleryState =
	| { state: 'gallery'; entries: GalleryEntry[]; record: SharedGalleryRecord }
	| { state: 'empty'; record: SharedGalleryRecord }
	| { state: 'deleted' }
	| { state: 'missing' }
	| { state: 'unavailable'; reason: 'blocked' | 'read_failed' | 'author_card_unavailable' | 'locked' }
	| { state: 'wrong_row' }
	| { state: 'invalid_signature'; reason: RowInvalidReason | 'no_local_verification' }
	| { state: 'decrypt_failed'; reason: 'format' | 'key' }
	| { state: 'unsupported_version'; version: number }
	| { state: 'invalid_payload'; reason: string };

export const readSharedGalleryRow = async (
	read: GalleryRowRead,
	address: GalleryAddress,
	key: Uint8Array,
	resolveSignPkey: SignPkeyResolver,
): Promise<SharedGalleryState> => {
	if (read.kind === 'blocked') return { state: 'unavailable', reason: 'blocked' };
	if (read.kind === 'failed') return { state: 'unavailable', reason: 'read_failed' };

	const matching = read.rows.filter((r) => r.user_hash === address.ownerHash && r.uuid === address.galleryUuid);
	if (matching.length === 0) return read.rows.length ? { state: 'wrong_row' } : { state: 'missing' };
	if (matching.length > 1) return { state: 'wrong_row' };
	const row = matching[0];

	const verdict = await verifyReplicatedRow('user_storage', row, resolveSignPkey);
	if (verdict.status === 'unavailable') return { state: 'unavailable', reason: verdict.reason };
	if (verdict.status !== 'verified') return { state: 'invalid_signature', reason: verdict.reason };

	if (wireBool(row.deleted_flag)) return { state: 'deleted' };

	const opened = await openSharedGallery(address, key, row.value_b64 ?? '');
	if (!opened.ok) {
		if (opened.state === 'decrypt_failed') return { state: 'decrypt_failed', reason: opened.reason };
		if (opened.state === 'unsupported_version') return { state: 'unsupported_version', version: opened.version };
		return { state: 'invalid_payload', reason: opened.reason };
	}
	const entries = ownGalleryOf(opened.record);
	return entries.length
		? { state: 'gallery', entries, record: opened.record }
		: { state: 'empty', record: opened.record };
};

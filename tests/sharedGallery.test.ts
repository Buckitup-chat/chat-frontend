import { describe, it, expect } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { signFields, deriveSignHash, toBase64, type SignableFields } from '@/lib/pq/signature';
import { signableFields } from '@/lib/pq/schema';
import { photoToWire, type ImagePart } from '@/lib/pq/content';
import type { UserStorageRow } from '@/lib/data/types';
import {
	encodeSharedGallery, decodeSharedGallery, sealSharedGallery, openSharedGallery, readSharedGalleryRow,
	type GalleryAddress, type SharedGalleryRecord,
} from '@/lib/avatars/sharedGallery';

const account = (seed: number) => {
	const keys = ml_dsa87.keygen(new Uint8Array(32).fill(seed));
	return { ...keys, userHash: 'u_' + bytesToHex(sha3_512(keys.publicKey)) };
};
const OWNER = account(1);
const STRANGER = account(2);
const UUID = '0b7e3a52-9c1d-4f6e-8a2b-3c4d5e6f7a8b';
const OTHER_UUID = '1c8f4b63-ad2e-4071-9b3c-4d5e6f7a8b9c';
const address: GalleryAddress = { ownerHash: OWNER.userHash, galleryUuid: UUID };
const KEY = randomBytes(32);

const cards = new Map([[OWNER.userHash, toBase64(OWNER.publicKey)], [STRANGER.userHash, toBase64(STRANGER.publicKey)]]);
const resolveSignPkey = async (userHash: string) => cards.get(userHash) ?? null;

const photo = (n: number): ImagePart => ({
	kind: 'image', widthAspect: 4, heightAspect: 3, thumbHashB64: 'thumb', name: `p${n}.jpg`, size: 1000 + n,
	mimeType: 'image/jpeg', createdAt: 1_780_000_000, fileId: 'f_' + String(n).repeat(32).slice(0, 32),
	encSecretB64: toBase64(new Uint8Array(32).fill(n)),
});
const id = (c: string) => c.repeat(32);
const record = (avatars: Record<string, { n: number; at: number }> = {}): SharedGalleryRecord => ({
	version: 1,
	avatars: Object.fromEntries(Object.entries(avatars).map(([avatarId, { n, at }]) => [avatarId, { photo: photoToWire(photo(n)), at }])),
});
const GALLERY = record({ [id('a')]: { n: 1, at: 100 }, [id('b')]: { n: 2, at: 300 }, [id('c')]: { n: 3, at: 200 } });

const signRow = (signer: typeof OWNER, fields: Partial<UserStorageRow>): UserStorageRow => {
	const row = {
		user_hash: signer.userHash, uuid: UUID, value_b64: '', deleted_flag: false,
		parent_sign_hash: null, owner_timestamp: 1_780_000_001, ...fields,
	} as UserStorageRow;
	const signB64 = signFields(signableFields('user_storage', row) as SignableFields, signer.secretKey);
	return { ...row, sign_b64: signB64, sign_hash: deriveSignHash('uss_', signB64) };
};

const rowsRead = (...rows: UserStorageRow[]) => ({ kind: 'rows' as const, rows });
const read = (r: Parameters<typeof readSharedGalleryRow>[0], key = KEY, resolve = resolveSignPkey) =>
	readSharedGalleryRow(r, address, key, resolve);

describe('payload codec', () => {
	it('round-trips a gallery and an empty gallery', () => {
		for (const r of [GALLERY, record()]) {
			expect(decodeSharedGallery(encodeSharedGallery(r))).toEqual({ ok: true, record: r });
		}
	});

	it('tells an unknown version from a malformed payload', () => {
		expect(decodeSharedGallery(JSON.stringify({ version: 2, whatever: true }))).toEqual({ ok: false, state: 'unsupported_version', version: 2 });
		expect(decodeSharedGallery(JSON.stringify({ version: '1', avatars: {} }))).toMatchObject({ state: 'invalid_payload' });
		expect(decodeSharedGallery(JSON.stringify({ avatars: {} }))).toMatchObject({ state: 'invalid_payload' });
	});
});

describe('sealing: AES-256-GCM bound to purpose, owner, uuid and version', () => {
	it('opens what it sealed, also as the shape serves it (unpadded)', async () => {
		const value = await sealSharedGallery(address, KEY, GALLERY);
		expect(await openSharedGallery(address, KEY, value)).toEqual({ ok: true, record: GALLERY });
		expect(await openSharedGallery(address, KEY, value.replace(/=+$/, ''))).toEqual({ ok: true, record: GALLERY });
	});

	it('does not open at another owner, another uuid, or under another key', async () => {
		const value = await sealSharedGallery(address, KEY, GALLERY);
		const decryptFailed = { ok: false, state: 'decrypt_failed', reason: 'key' };
		expect(await openSharedGallery({ ...address, ownerHash: STRANGER.userHash }, KEY, value)).toEqual(decryptFailed);
		expect(await openSharedGallery({ ...address, galleryUuid: OTHER_UUID }, KEY, value)).toEqual(decryptFailed);
		expect(await openSharedGallery(address, randomBytes(32), value)).toEqual(decryptFailed);
	});
});

describe('what a read of the gallery row means', () => {
	it('a verified gallery: newest first, avatar_id breaking a tie', async () => {
		const tied = record({ [id('a')]: { n: 1, at: 100 }, [id('b')]: { n: 2, at: 300 }, [id('d')]: { n: 4, at: 300 } });
		const row = signRow(OWNER, { value_b64: await sealSharedGallery(address, KEY, tied) });
		const state = await read(rowsRead(row));
		expect(state).toMatchObject({ state: 'gallery' });
		expect(state.state === 'gallery' && state.entries.map((e) => e.avatarId)).toEqual([id('d'), id('b'), id('a')]);
		expect(state.state === 'gallery' && state.entries[0].photo).toMatchObject({ kind: 'image', fileId: photo(4).fileId });
	});

	it('no row is missing; a verified tombstone is deleted; neither is empty', async () => {
		expect(await read(rowsRead())).toEqual({ state: 'missing' });
		const tombstone = signRow(OWNER, { deleted_flag: true, value_b64: '' });
		expect(await read(rowsRead(tombstone))).toEqual({ state: 'deleted' });
		const served = { ...tombstone, deleted_flag: 't' as unknown as boolean };
		expect(await read(rowsRead(served))).toMatchObject({ state: 'deleted' });
	});

	it('verifies before decrypting: a valid gallery under a broken signature is refused', async () => {
		const signed = signRow(OWNER, { value_b64: await sealSharedGallery(address, KEY, record()) });
		const swapped = { ...signed, value_b64: await sealSharedGallery(address, KEY, GALLERY) };
		expect(await read(rowsRead(swapped))).toMatchObject({ state: 'invalid_signature' });
		const forged = signRow(STRANGER, { value_b64: await sealSharedGallery(address, KEY, GALLERY) });
		expect(await read(rowsRead({ ...forged, user_hash: OWNER.userHash }))).toMatchObject({ state: 'invalid_signature' });
		const tombstone = signRow(OWNER, { deleted_flag: true, value_b64: '' });
		expect(await read(rowsRead({ ...tombstone, deleted_flag: false }))).toMatchObject({ state: 'invalid_signature' });
	});

	it('refuses a row for another owner or uuid instead of calling the gallery missing', async () => {
		const strangers = signRow(STRANGER, {
			value_b64: await sealSharedGallery({ ownerHash: STRANGER.userHash, galleryUuid: UUID }, KEY, GALLERY),
		});
		expect(await read(rowsRead(strangers))).toEqual({ state: 'wrong_row' });
		const elsewhere = signRow(OWNER, {
			uuid: OTHER_UUID, value_b64: await sealSharedGallery({ ...address, galleryUuid: OTHER_UUID }, KEY, GALLERY),
		});
		expect(await read(rowsRead(elsewhere))).toEqual({ state: 'wrong_row' });
		const own = signRow(OWNER, { value_b64: await sealSharedGallery(address, KEY, GALLERY) });
		expect(await read(rowsRead(strangers, own))).toMatchObject({ state: 'gallery' });
		expect(await read(rowsRead(own, { ...own }))).toEqual({ state: 'wrong_row' });
	});
});

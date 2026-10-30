import { isAvatarId, isGalleryUuid, photoFromWire, photoToWire } from '@buckitup/pq-client/content';
import { AVATARS_SLOT } from './gallery';
import type { GalleryMapping, MappingResult } from './galleryMapping';
import {
	encodeSharedGallery, galleryKeyFromB64, sealSharedGallery, SHARED_GALLERY_VERSION,
	type SharedGalleryRecord, type SharedGalleryState,
} from './sharedGallery';

export type LegacyConversion =
	| { state: 'ok'; record: SharedGalleryRecord }
	| { state: 'needs-conversion'; avatarIds: string[] }
	| { state: 'invalid'; reason: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export const legacyToSharedGallery = (legacy: unknown): LegacyConversion => {
	if (legacy !== null && !isPlainObject(legacy)) return { state: 'invalid', reason: 'the legacy avatars slot is not a record' };
	const avatars = legacy === null ? {} : legacy.avatars;
	if (!isPlainObject(avatars)) return { state: 'invalid', reason: 'the legacy avatars slot holds no avatars map' };
	const out: SharedGalleryRecord['avatars'] = {};
	const inline: string[] = [];
	for (const [avatarId, entry] of Object.entries(avatars)) {
		if (entry === null) continue;
		if (!isAvatarId(avatarId) || typeof entry !== 'object' || Array.isArray(entry)) {
			return { state: 'invalid', reason: `legacy avatar ${avatarId} is malformed` };
		}
		const { photo: wire, at } = entry as { photo?: unknown; at?: unknown };
		if (wire === undefined) continue;
		if (!Number.isSafeInteger(at) || (at as number) <= 0) return { state: 'invalid', reason: `legacy avatar ${avatarId} has no order` };
		const photo = photoFromWire(wire);
		if (!photo) return { state: 'invalid', reason: `legacy avatar ${avatarId} has an unreadable photo` };
		if (photo.kind === 'inline_image') {
			inline.push(avatarId);
			continue;
		}
		out[avatarId] = { photo: photoToWire(photo), at: at as number };
	}
	if (inline.length) return { state: 'needs-conversion', avatarIds: inline.sort() };
	const record: SharedGalleryRecord = { version: SHARED_GALLERY_VERSION, avatars: out };
	try {
		encodeSharedGallery(record);
	} catch (e) {
		return { state: 'invalid', reason: (e as Error).message };
	}
	return { state: 'ok', record };
};

export type AvatarsSlotRef =
	| { state: 'none' }
	| { state: 'slot'; uuid: string }
	| { state: 'malformed'; reason: string };

export const avatarsSlotOf = (root: unknown): AvatarsSlotRef => {
	if (!isPlainObject(root)) return { state: 'malformed', reason: 'the account record is not a record' };
	if (root.slots === undefined) return { state: 'none' };
	if (!isPlainObject(root.slots)) return { state: 'malformed', reason: 'the account record\'s slot map is not a map' };
	const uuid = root.slots[AVATARS_SLOT];
	if (uuid === undefined) return { state: 'none' };
	if (!isGalleryUuid(uuid)) return { state: 'malformed', reason: 'the account record names the avatars slot by something that is not a uuid' };
	return { state: 'slot', uuid };
};

export type LegacyRead =
	| { state: 'found'; record: unknown }
	| { state: 'malformed'; reason: string }
	| { state: 'unknown' };

export type RowWriteStatus = 'synced' | 'queued' | 'syncing' | 'awaiting-approval' | 'awaiting-recovery' | 'failed';

export interface PublishAccess {
	ownerHash: string;
	obtainMapping(): Promise<MappingResult>;
	readLegacy(): Promise<LegacyRead>;
	readSharedRow(mapping: GalleryMapping): Promise<SharedGalleryState>;
	writeRow(mapping: GalleryMapping, valueB64: string): Promise<{ status: RowWriteStatus; error?: unknown }>;
	assertCurrent(): void;
}

export type PublishResult =
	| { state: 'published'; mapping: GalleryMapping }
	| { state: 'adopted'; mapping: GalleryMapping }
	| { state: 'pending'; reason: 'mapping' | 'legacy' | 'row' | 'queued' | 'syncing' | 'awaiting-approval' | 'awaiting-recovery'; detail?: string }
	| { state: 'needs-conversion'; avatarIds: string[] }
	| { state: 'refused'; reason: string }
	| { state: 'failed'; error: unknown };

const REFUSED_ROW_STATES = new Set(['deleted', 'wrong_row', 'invalid_signature', 'decrypt_failed', 'unsupported_version', 'invalid_payload']);

export const publishInitialSharedGallery = async (access: PublishAccess): Promise<PublishResult> => {
	access.assertCurrent();
	const obtained = await access.obtainMapping();
	access.assertCurrent();
	if (obtained.state !== 'ready') return { state: 'pending', reason: 'mapping', detail: obtained.reason };
	const { mapping } = obtained;

	const legacy = await access.readLegacy();
	access.assertCurrent();
	if (legacy.state === 'malformed') return { state: 'refused', reason: legacy.reason };
	if (legacy.state !== 'found') return { state: 'pending', reason: 'legacy' };
	const converted = legacyToSharedGallery(legacy.record);
	if (converted.state === 'needs-conversion') return converted;
	if (converted.state === 'invalid') return { state: 'refused', reason: converted.reason };

	const row = await access.readSharedRow(mapping);
	access.assertCurrent();
	if ((row.state === 'gallery' || row.state === 'empty') && sameSharedGallery(row.record, converted.record)) {
		return { state: 'adopted', mapping };
	}
	if (row.state === 'unavailable') return { state: 'pending', reason: 'row', detail: row.reason };
	if (REFUSED_ROW_STATES.has(row.state)) return { state: 'refused', reason: `the shared row is there and cannot be used: ${row.state}` };
	if (row.state !== 'missing' && row.state !== 'gallery' && row.state !== 'empty') {
		return { state: 'refused', reason: `unexpected shared row state ${row.state}` };
	}

	return sealAndWrite(access, mapping, converted.record);
};

const sealAndWrite = async (access: PublishAccess, mapping: GalleryMapping, record: SharedGalleryRecord): Promise<PublishResult> => {
	const valueB64 = await sealSharedGallery(
		{ ownerHash: access.ownerHash, galleryUuid: mapping.galleryUuid },
		galleryKeyFromB64(mapping.galleryKeyB64),
		record,
	);
	access.assertCurrent();
	const { status, error } = await access.writeRow(mapping, valueB64);
	access.assertCurrent();
	if (status === 'synced') return { state: 'published', mapping };
	if (status === 'failed') return { state: 'failed', error };
	return { state: 'pending', reason: status };
};

export const publishSharedGalleryRecord = async (
	access: Pick<PublishAccess, 'ownerHash' | 'obtainMapping' | 'writeRow' | 'assertCurrent'>,
	record: SharedGalleryRecord,
): Promise<PublishResult> => {
	access.assertCurrent();
	encodeSharedGallery(record);
	const obtained = await access.obtainMapping();
	access.assertCurrent();
	if (obtained.state !== 'ready') return { state: 'pending', reason: 'mapping', detail: obtained.reason };
	return sealAndWrite(access as PublishAccess, obtained.mapping, record);
};

const sameSharedGallery = (a: SharedGalleryRecord, b: SharedGalleryRecord): boolean => {
	const canonical = (r: SharedGalleryRecord) => JSON.stringify(
		Object.entries(r.avatars).sort(([x], [y]) => (x < y ? -1 : 1)).map(([id, e]) => [id, e.at, e.photo]),
	);
	return canonical(a) === canonical(b);
};

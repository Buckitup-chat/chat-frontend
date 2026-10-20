import { isGalleryKeyB64, isGalleryUuid } from '@/lib/pq/content';
import { deriveInitialGalleryKey, deriveInitialGalleryUuid } from '@/lib/pq/galleryKeys';
import { toBase64Unpadded } from '@/lib/pq/signature';

export const SHARED_GALLERY_FIELD = 'sharedGallery';

export interface GalleryMapping {
	galleryUuid: string;
	galleryKeyB64: string;
	generation: number;
}

export class GalleryMappingError extends Error {}

export const parseGalleryMapping = (value: unknown): GalleryMapping | null => {
	if (value === undefined || value === null) return null;
	const m = value as Partial<GalleryMapping>;
	if (
		typeof value !== 'object' || Array.isArray(value)
		|| !isGalleryUuid(m.galleryUuid) || !isGalleryKeyB64(m.galleryKeyB64)
		|| !Number.isSafeInteger(m.generation) || (m.generation as number) < 1
	) {
		throw new GalleryMappingError('The account record holds a malformed shared gallery mapping');
	}
	return { galleryUuid: m.galleryUuid, galleryKeyB64: m.galleryKeyB64, generation: m.generation as number };
};

export const initialGalleryMapping = (cryptSkey: Uint8Array): GalleryMapping => ({
	galleryUuid: deriveInitialGalleryUuid(cryptSkey),
	galleryKeyB64: toBase64Unpadded(deriveInitialGalleryKey(cryptSkey)),
	generation: 1,
});

export type RootRead = { state: 'found'; record: Record<string, unknown> } | { state: 'unknown' };

export type RootWriteStatus = 'synced' | 'queued' | 'syncing' | 'awaiting-approval' | 'awaiting-recovery';

export interface MappingRootAccess {
	readLive(): Promise<RootRead>;
	writePatch(patch: Record<string, unknown>): Promise<RootWriteStatus>;
	assertCurrent(): void;
}

export type MappingResult =
	| { state: 'ready'; mapping: GalleryMapping }
	| { state: 'pending'; reason: Exclude<RootWriteStatus, 'synced'> };

export const obtainGalleryMapping = async (root: MappingRootAccess, initial: GalleryMapping): Promise<MappingResult> => {
	root.assertCurrent();
	const live = await root.readLive();
	root.assertCurrent();
	const existing = live.state === 'found' ? parseGalleryMapping(live.record[SHARED_GALLERY_FIELD]) : null;
	if (existing) return { state: 'ready', mapping: existing };

	const status = await root.writePatch({ [SHARED_GALLERY_FIELD]: { ...initial } });
	root.assertCurrent();
	if (status !== 'synced') return { state: 'pending', reason: status };
	return { state: 'ready', mapping: initial };
};

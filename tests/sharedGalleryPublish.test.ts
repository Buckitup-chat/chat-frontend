import { describe, it, expect, beforeEach } from 'vitest';
import { photoToWire, type ImagePart } from '@buckitup/pq-client/content';
import { toBase64 } from '@buckitup/pq-client/signature';
import { SessionFencedError } from '@/lib/data/sessionGuard';
import type { UserStorageRow } from '@/lib/data/types';
import { initialGalleryMapping, type GalleryMapping, type MappingResult } from '@/lib/avatars/galleryMapping';
import {
	readSharedGalleryRow, sealSharedGallery, galleryKeyFromB64, type GalleryRowRead,
} from '@/lib/avatars/sharedGallery';
import {
	legacyToSharedGallery, publishInitialSharedGallery, publishSharedGalleryRecord,
	type LegacyRead, type PublishAccess, type RowWriteStatus,
} from '@/lib/avatars/sharedGalleryPublish';
import { galleryAccount, galleryRecord, signPkeyResolver, signStorageRow } from './helpers/sharedGalleryRows';

const OWNER = galleryAccount(1);
const MAPPING = initialGalleryMapping(new Uint8Array(64).fill(3));
const id = (c: string) => c.repeat(32);

const image = (n: number, over: Partial<ImagePart> = {}): ImagePart => ({
	kind: 'image', widthAspect: 4, heightAspect: 3, thumbHashB64: 'thumb', name: `p${n}.jpg`, size: 1000 + n,
	mimeType: 'image/jpeg', createdAt: 1_780_000_000, fileId: 'f_' + String(n).repeat(32).slice(0, 32),
	encSecretB64: toBase64(new Uint8Array(32).fill(n)), ...over,
});
const inline = { inline_image: [1, 1, 'th', 'small.jpg', 10, 'image/jpeg', 0, 'AAAA'] };
const legacySlot = (entries: Record<string, { photo?: unknown; at?: unknown }>) => ({ avatars: entries });

let table: UserStorageRow[];
let ts: number;
const address = (m: GalleryMapping) => ({ ownerHash: OWNER.userHash, galleryUuid: m.galleryUuid });
const reader = (m = MAPPING) => readSharedGalleryRow({ kind: 'rows', rows: table }, address(m), galleryKeyFromB64(m.galleryKeyB64), signPkeyResolver(OWNER));

const makeAccess = () => {
	const calls: string[] = [];
	const state = {
		current: true,
		mapping: { state: 'ready', mapping: MAPPING } as MappingResult,
		legacy: { state: 'found', record: legacySlot({ [id('a')]: { photo: photoToWire(image(1)), at: 100 }, [id('b')]: { photo: photoToWire(image(2)), at: 300 } }) } as LegacyRead,
		rowRead: 'ok' as 'ok' | 'blocked' | 'failed',
		cardAvailable: true,
		writeStatus: 'synced' as RowWriteStatus,
		beforeWrite: null as null | (() => Promise<void> | void),
		writes: [] as string[],
	};
	const access: PublishAccess = {
		ownerHash: OWNER.userHash,
		assertCurrent: () => {
			if (!state.current) throw new SessionFencedError('[test] the account changed');
		},
		obtainMapping: async () => { calls.push('mapping'); return state.mapping; },
		readLegacy: async () => { calls.push('legacy'); return state.legacy; },
		readSharedRow: async (m) => {
			calls.push('row');
			const read: GalleryRowRead = state.rowRead === 'ok' ? { kind: 'rows', rows: table } : { kind: state.rowRead };
			const resolve = state.cardAvailable ? signPkeyResolver(OWNER) : async () => null;
			const result = await readSharedGalleryRow(read, address(m), galleryKeyFromB64(m.galleryKeyB64), resolve);
			await state.beforeWrite?.();
			return result;
		},
		writeRow: async (m, valueB64) => {
			calls.push('write');
			state.writes.push(valueB64);
			if (state.writeStatus === 'synced') table = [signStorageRow(OWNER, { uuid: m.galleryUuid, value_b64: valueB64, owner_timestamp: ++ts })];
			return { status: state.writeStatus, ...(state.writeStatus === 'failed' ? { error: 'rejected by the server' } : {}) };
		},
	};
	return { state, access, calls };
};

const sealedRow = async (record = galleryRecord([id('c'), 3, 500]), key = galleryKeyFromB64(MAPPING.galleryKeyB64)) =>
	signStorageRow(OWNER, { uuid: MAPPING.galleryUuid, owner_timestamp: ++ts, value_b64: await sealSharedGallery(address(MAPPING), key, record) });

beforeEach(() => {
	table = [];
	ts = 1_780_000_000;
});

describe('converting the legacy gallery', () => {
	it('carries every out-of-band photo and its order as they are', () => {
		const result = legacyToSharedGallery(legacySlot({ [id('a')]: { photo: photoToWire(image(1)), at: 100 } }));
		expect(result).toEqual({ state: 'ok', record: { version: 1, avatars: { [id('a')]: { photo: photoToWire(image(1)), at: 100 } } } });
	});

	it('an inline photo stops the conversion, naming every one, and converts nothing', () => {
		expect(legacyToSharedGallery(legacySlot({
			[id('b')]: { photo: inline, at: 200 }, [id('a')]: { photo: photoToWire(image(1)), at: 100 }, [id('c')]: { photo: inline, at: 300 },
		}))).toEqual({ state: 'needs-conversion', avatarIds: [id('b'), id('c')] });
	});
});

describe('publishing when the row is absent', () => {
	it('publishes the converted gallery, sealed under the mapping, and a reader sees it in order', async () => {
		const { access, calls } = makeAccess();
		expect(await publishInitialSharedGallery(access)).toEqual({ state: 'published', mapping: MAPPING });
		expect(calls).toEqual(['mapping', 'legacy', 'row', 'write']);
		const read = await reader();
		expect(read.state === 'gallery' && read.entries.map((e) => e.avatarId)).toEqual([id('b'), id('a')]);
	});

	it('publishes an empty gallery only for an account whose legacy read found none', async () => {
		const { state, access } = makeAccess();
		state.legacy = { state: 'found', record: null };
		expect(await publishInitialSharedGallery(access)).toMatchObject({ state: 'published' });
		expect(await reader()).toMatchObject({ state: 'empty' });
	});
});

describe('a row already there', () => {
	it('a valid gallery or empty gallery holding other photos than the slot is overwritten from the slot', async () => {
		for (const record of [galleryRecord([id('c'), 3, 500]), galleryRecord()]) {
			table = [await sealedRow(record)];
			const { state, access } = makeAccess();
			expect(await publishInitialSharedGallery(access)).toEqual({ state: 'published', mapping: MAPPING });
			expect(state.writes).toHaveLength(1);
			const read = await reader();
			expect(read.state === 'gallery' && read.entries.map((e) => e.avatarId)).toEqual([id('b'), id('a')]);
		}
	});

	it('a row holding what the private slot holds is adopted, and nothing is written', async () => {
		const { state, access } = makeAccess();
		const converted = legacyToSharedGallery((state.legacy as { record: unknown }).record);
		if (converted.state !== 'ok') throw new Error('fixture');
		table = [await sealedRow(converted.record)];
		expect(await publishInitialSharedGallery(access)).toEqual({ state: 'adopted', mapping: MAPPING });
		expect(state.writes).toEqual([]);
	});
});

describe('what is not known is not absence', () => {
	it.each([['blocked'], ['failed']] as const)('a %s row read is pending, and nothing is written', async (rowRead) => {
		const { state, access } = makeAccess();
		state.rowRead = rowRead;
		expect(await publishInitialSharedGallery(access)).toMatchObject({ state: 'pending', reason: 'row' });
		expect(state.writes).toEqual([]);
	});

	it('an avatars slot read as {} is refused, not published as an empty gallery', async () => {
		const { state, access } = makeAccess();
		state.legacy = { state: 'found', record: {} };
		expect(await publishInitialSharedGallery(access)).toMatchObject({ state: 'refused' });
		expect(state.writes).toEqual([]);
		expect(table).toEqual([]);
	});
});

describe('account switching', () => {
	it('a switch while the write is out reports nothing to the next account', async () => {
		const { state, access } = makeAccess();
		const write = access.writeRow;
		access.writeRow = async (m, v) => { const r = await write(m, v); state.current = false; return r; };
		await expect(publishInitialSharedGallery(access)).rejects.toThrow(SessionFencedError);
	});
});

describe('publishing the gallery after an owner\'s edit', () => {
	const edited = () => {
		const converted = legacyToSharedGallery(legacySlot({ [id('a')]: { photo: photoToWire(image(1)), at: 100 }, [id('d')]: { photo: photoToWire(image(4)), at: 900 } }));
		if (converted.state !== 'ok') throw new Error('fixture');
		return converted.record;
	};

	it('replaces what the row holds with the whole gallery, without reading it first', async () => {
		table = [await sealedRow()];
		const { access, calls } = makeAccess();
		expect(await publishSharedGalleryRecord(access, edited())).toEqual({ state: 'published', mapping: MAPPING });
		expect(calls).toEqual(['mapping', 'write']);
		const read = await reader();
		expect(read.state === 'gallery' && read.entries.map((e) => e.avatarId)).toEqual([id('d'), id('a')]);
	});

	it('a switch while the write is out reports nothing to the next account', async () => {
		const { state, access } = makeAccess();
		const write = access.writeRow;
		access.writeRow = async (m, v) => { const r = await write(m, v); state.current = false; return r; };
		await expect(publishSharedGalleryRecord(access, edited())).rejects.toThrow(SessionFencedError);
	});
});

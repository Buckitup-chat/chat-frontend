// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { defineComponent, h, ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { cards, installFakeServer, publishFile, serve, type FakeServer } from './helpers/fileServer';
import { limitChunkStore } from './helpers/idbByteLimit';

vi.mock('@/lib/data/cardRegistry', () => ({ getVerifiedSignPkey: async (hash: string) => cards[hash] ?? null }));

const { __resetChunkCacheForTests, getCachedChunk, pinnedBytesOf, cachedBytes, clearChunkCache } = await import('@/lib/data/chunkCache');
const { _setKeptFilesStoreForTests, listKeptFiles, openFile } = await import('@/lib/data/keptFiles');
const { useKeptFiles, askKeepNearQuota } = await import('@/composables/useKeptFiles');
const { fileKey } = await import('@/lib/data/fileKey');
const FileStateModal = (await import('@/components/chat/FileStateModal.vue')).default;

const OWNER = 'u_' + '1'.repeat(128);
const availability = { present: 2, total: 2, unknown: false, deleted: false };
const CHUNK = 'x'.repeat(100);
const ENCRYPTED = 100 + 12 + 16;

let server: FakeServer;
let limit: ReturnType<typeof limitChunkStore>;

beforeEach(async () => {
	globalThis.indexedDB = new IDBFactory();
	__resetChunkCacheForTests();
	const raw = new Map<string, string>();
	const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
	_setKeptFilesStoreForTests({
		get: async (k) => raw.get(k) ?? null,
		set: async (k, v) => { raw.set(k, v); },
		delete: async (k) => { raw.delete(k); },
		keys: async () => [...raw.keys()],
		clear: async () => raw.clear(),
	}, async () => key);
	server = installFakeServer();
	limit = limitChunkStore();
});

afterEach(() => limit.restore());

const settle = async () => {
	for (let i = 0; i < 20; i++) {
		await flushPromises();
		await new Promise((r) => setTimeout(r, 2));
	}
};

let fileNo = 0;
const published = async (chunks: number) => {
	fileNo += 1;
	const f = await publishFile('f_' + fileNo.toString(16).padStart(32, '0'), Array.from({ length: chunks }, () => CHUNK));
	serve(server, f);
	return f;
};

type Estimate = { usage: number | null; quota: number | null };

const mountScreen = (part: Record<string, unknown> & { fileId: string; uploaderHash: string; encSecretB64: string }, opts: {
	estimate?: () => Promise<Estimate>;
	confirmNearQuota?: (info: { usage: number; quota: number; size: number; ratio: number }) => Promise<boolean>;
} = {}) => {
	const told: string[] = [];
	const Harness = defineComponent({
		setup() {
			const owner = ref(OWNER);
			const k = useKeptFiles({ owner: () => owner.value, onError: (message) => told.push(message), ...opts });
			return () => h(FileStateModal, {
				part,
				availability,
				kept: !!k.kept.value[fileKey(part)],
				keeping: k.keeping.value[fileKey(part)] || null,
				keepError: k.errors.value[fileKey(part)] || '',
				onKeep: (on: boolean) => k.setKept(part, 'dmsg_1', on),
			});
		},
	});
	return { wrapper: mount(Harness), told };
};

const toggleOn = async (wrapper: ReturnType<typeof mount>) => {
	const input = wrapper.find('#fs-keep');
	(input.element as HTMLInputElement).checked = true;
	await input.trigger('change');
	await settle();
};

describe('keeping a file that would fill the storage', () => {
	it('asks first when keeping it would take the storage past 80% of the quota, and keeps nothing on cancel', async () => {
		const f = await published(2);
		const asked: Array<{ ratio: number }> = [];
		const { wrapper, told } = mountScreen(f.part, {
			estimate: async () => ({ usage: 790, quota: 1000 }),
			confirmNearQuota: async (info) => { asked.push(info); return false; },
		});
		await settle();
		await toggleOn(wrapper);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ usage: 790, quota: 1000, size: f.part.size });
		expect(asked[0].ratio).toBeGreaterThan(0.8);
		expect((wrapper.find('#fs-keep').element as HTMLInputElement).checked).toBe(false);
		expect(told).toEqual([]);
		expect(await listKeptFiles(OWNER)).toEqual({});
		expect(server.chunkRequests).toEqual([]);
	});

	it('keeps it when the person goes ahead', async () => {
		const f = await published(2);
		const { wrapper } = mountScreen(f.part, {
			estimate: async () => ({ usage: 790, quota: 1000 }),
			confirmNearQuota: async () => true,
		});
		await settle();
		await toggleOn(wrapper);
		expect(Object.keys(await listKeptFiles(OWNER))).toEqual([fileKey(f.part)]);
	});

	it('does not ask below 80%, or when the browser does not say', async () => {
		for (const estimate of [{ usage: 100, quota: 1_000_000 }, { usage: null, quota: null }]) {
			const f = await published(1);
			const confirmNearQuota = vi.fn(async () => false);
			const { wrapper } = mountScreen(f.part, { estimate: async () => estimate, confirmNearQuota });
			await settle();
			await toggleOn(wrapper);
			expect(confirmNearQuota).not.toHaveBeenCalled();
			expect(Object.keys(await listKeptFiles(OWNER))).toContain(fileKey(f.part));
		}
	});

	it('the warning says how full the storage would be and leads to Storage on this device', async () => {
		const fire = vi.fn(async () => ({ isConfirmed: false, isDenied: true, isDismissed: false }));
		const openStorage = vi.fn();
		const confirm = askKeepNearQuota({ fire }, openStorage);
		expect(await confirm({ usage: 850, quota: 1000, size: 20, ratio: 0.87 })).toBe(false);
		expect(openStorage).toHaveBeenCalledTimes(1);
		const shown = JSON.stringify(fire.mock.calls[0]);
		expect(shown).toContain('87%');
		expect(shown).toContain('Storage');

		fire.mockResolvedValueOnce({ isConfirmed: true, isDenied: false, isDismissed: false });
		expect(await confirm({ usage: 850, quota: 1000, size: 20, ratio: 0.87 })).toBe(true);
		expect(openStorage).toHaveBeenCalledTimes(1);
	});
});

const keepNow = async (part: Parameters<typeof mountScreen>[0]) => {
	const { wrapper, told } = mountScreen(part, { estimate: async () => ({ usage: null, quota: null }) });
	await settle();
	await toggleOn(wrapper);
	return { wrapper, told };
};

const cacheFile = async (chunks: number) => {
	const f = await published(chunks);
	await openFile(null, f.part);
	await settle();
	await new Promise((r) => setTimeout(r, 5));
	return f;
};

describe('space under pressure', () => {
	it('a keep that hits the quota frees the oldest cache first, never a kept file, and then succeeds', async () => {
		const older = await cacheFile(2);
		const newer = await cacheFile(2);
		const earlier = await published(2);
		await keepNow(earlier.part);
		limit.setLimit(ENCRYPTED * 7);

		const wanted = await published(2);
		const { wrapper, told } = await keepNow(wanted.part);
		expect(told).toEqual([]);
		expect((wrapper.find('#fs-keep').element as HTMLInputElement).checked).toBe(true);
		expect(await getCachedChunk(older.fileId, 0, older.chunkRows[0].data_hash as string)).toBeNull();
		expect(await getCachedChunk(newer.fileId, 0, newer.chunkRows[0].data_hash as string)).not.toBeNull();
		expect(await getCachedChunk(newer.fileId, 1, newer.chunkRows[1].data_hash as string)).not.toBeNull();
		server.offline = true;
		expect(new TextDecoder().decode(await openFile(OWNER, earlier.part))).toBe(earlier.plain);
		expect(new TextDecoder().decode(await openFile(OWNER, wanted.part))).toBe(wanted.plain);
	});

	it('when even an empty cache is not enough, the keep fails with the quota error, the switch stays off, and kept files stay', async () => {
		await cacheFile(2);
		const earlier = await published(2);
		await keepNow(earlier.part);
		limit.setLimit(ENCRYPTED * 5);

		const wanted = await published(4);
		const { wrapper, told } = await keepNow(wanted.part);
		expect(told).toEqual(['There is not enough storage on this device to keep this file.']);
		expect((wrapper.find('#fs-keep').element as HTMLInputElement).checked).toBe(false);
		expect(wrapper.find('.fs-refused').text()).toBe('There is not enough storage on this device to keep this file.');
		expect(Object.keys(await listKeptFiles(OWNER))).toEqual([fileKey(earlier.part)]);
		expect(await pinnedBytesOf(OWNER)).toBe(ENCRYPTED * 2);
		server.offline = true;
		expect(new TextDecoder().decode(await openFile(OWNER, earlier.part))).toBe(earlier.plain);
	});

	it('clearing the cache removes what can be fetched again and keeps every kept file', async () => {
		const plain = await cacheFile(2);
		const kept = await published(2);
		await keepNow(kept.part);
		expect(await cachedBytes()).toBe(ENCRYPTED * 2);

		await clearChunkCache();
		expect(await cachedBytes()).toBe(0);
		expect(await pinnedBytesOf(OWNER)).toBe(ENCRYPTED * 2);
		server.offline = true;
		expect(new TextDecoder().decode(await openFile(OWNER, kept.part))).toBe(kept.plain);
		await expect(openFile(null, plain.part)).rejects.toThrow();
	});
});

describe('what keeping promises', () => {
	it('the file screen says the browser can still remove a kept file, and promises no more', async () => {
		const f = await published(1);
		const { wrapper } = await keepNow(f.part);
		const note = wrapper.text();
		expect(note).toMatch(/clear(s|ing)? (this|the) site's data/i);
		expect(note).toMatch(/browser/i);
		expect(note).not.toMatch(/forever|always|guarantee/i);
	});
});

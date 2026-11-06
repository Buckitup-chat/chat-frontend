// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { installFakeServer, publishFile, serve, UPLOADER, type FakeServer, type PublishedFile } from './helpers/fileServer';

const ALICE = 'u_' + '1'.repeat(128);
const BOHDAN = 'u_' + '3'.repeat(128);
const session = vi.hoisted(() => ({ user: '' }));

vi.mock('@/lib/data/cardRegistry', async (importOriginal) => {
	const { cards } = await import('./helpers/fileServer');
	return { ...(await importOriginal<object>()), getVerifiedSignPkey: async (hash: string) => cards[hash] ?? null };
});
vi.mock('@/store/userPQ.store', async () => {
	const { UPLOADER: anna } = await import('./helpers/fileServer');
	return {
		userPQStore: () => ({
			get currentUserHash() { return session.user; },
			contacts: [{ user_hash: anna, name: 'Anna' }, { user_hash: 'u_' + '3'.repeat(128), name: 'Bohdan' }],
			getUserByHash: () => null,
		}),
	};
});
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => ({}) } }));
vi.mock('@/lib/data/localCrypto', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getLocalStorageKeyFor: async (owner: string) => {
		if (session.user !== owner) throw Object.assign(new Error('No unlocked account'), { name: 'VaultLockedError' });
		const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`local key of ${owner}`));
		return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
	},
}));

let server: FakeServer;
const blobs = new Map<string, Blob>();
const opened: string[] = [];
const saved: Array<{ name: string; url: string }> = [];

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	server = installFakeServer();
	session.user = ALICE;
	blobs.clear();
	opened.length = 0;
	saved.length = 0;
	URL.createObjectURL = (b: Blob) => {
		const url = `blob:test/${blobs.size + 1}`;
		blobs.set(url, b);
		return url;
	};
	URL.revokeObjectURL = () => {};
	window.confirm = () => true;
	window.open = ((url: string) => { opened.push(url); return null; }) as typeof window.open;
	HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { saved.push({ name: this.download, url: this.href }); };
	Object.defineProperty(navigator, 'storage', {
		configurable: true,
		value: { estimate: async () => ({ usage: 5_000_000, quota: 100_000_000 }), persisted: async () => false },
	});
});

const settle = async () => {
	for (let i = 0; i < 20; i++) {
		await flushPromises();
		await new Promise((r) => setTimeout(r, 2));
	}
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const blobText = (url: string) => new Promise<string>((ok, fail) => {
	const blob = blobs.get(url);
	if (!blob) return fail(new Error(`${url} is not a blob made here`));
	const reader = new FileReader();
	reader.onload = () => ok(text(new Uint8Array(reader.result as ArrayBuffer)));
	reader.onerror = () => fail(reader.error);
	reader.readAsArrayBuffer(blob);
});

const load = async () => {
	vi.resetModules();
	return {
		keptFiles: await import('@/lib/data/keptFiles'),
		chunkCache: await import('@/lib/data/chunkCache'),
		useKeptFiles: (await import('@/composables/useKeptFiles')).useKeptFiles,
		formatBytes: (await import('@/lib/storageStatus')).formatBytes,
		Manager: (await import('@/components/storage/KeptFilesManager.vue')).default,
	};
};
type Loaded = Awaited<ReturnType<typeof load>>;

let fileNo = 0;
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
type Part = PublishedFile['part'] & Record<string, unknown>;

const published = async (over: Partial<Part>, plains = ['one ', 'two']) => {
	fileNo += 1;
	const f = await publishFile('f_' + fileNo.toString(16).padStart(32, '0'), plains);
	serve(server, f);
	return { f, part: { ...f.part, ...over } as Part };
};

const keep = async (m: Loaded, part: Part, peerHash: string, messageId = 'dmsg_' + part.fileId) => {
	const k = m.useKeptFiles({ owner: () => session.user });
	await settle();
	await k.setKept(part, messageId, true, peerHash);
	expect(k.errors.value).toEqual({});
};

const world = async () => {
	let m = await load();
	const report = await published({ name: 'Report Q3.pdf', createdAt: NOW - 2 * DAY }, ['quarterly ', 'report']);
	const beach = await published({ kind: 'image', name: 'beach.jpg', mimeType: 'image/jpeg', createdAt: NOW - 20 * DAY, widthAspect: 4, heightAspect: 3, thumbHashB64: 'AAAA' }, ['jpeg ', 'bytes']);
	const clip = await published({ kind: 'video', name: 'clip.mp4', mimeType: 'video/mp4', createdAt: NOW - 60 * DAY, widthAspect: 16, heightAspect: 9, durationSeconds: 4 }, ['video ', 'bytes ', 'and more bytes']);
	const voice = await published({ name: 'voice.mp3', mimeType: 'audio/mpeg', createdAt: NOW - DAY }, ['ogg']);
	await keep(m, report.part, UPLOADER);
	await keep(m, beach.part, BOHDAN);
	await keep(m, clip.part, UPLOADER);
	await keep(m, voice.part, BOHDAN);
	m = await load();
	return { m, report, beach, clip, voice };
};

const mountManager = async (m: Loaded) => {
	const wrapper = mount(m.Manager);
	await settle();
	return wrapper;
};

const rows = (w: VueWrapper) => w.findAll('[data-test="kept-row"]');
const names = (w: VueWrapper) => rows(w).map((r) => r.find('.kept-name').text());
const rowOf = (w: VueWrapper, name: string) => {
	const row = rows(w).find((r) => r.find('.kept-name').text() === name);
	if (!row) throw new Error(`no row for ${name}`);
	return row;
};

describe('Storage on this device: the files kept here', () => {
	it('lists each with its name, chat, sender, date, size and type', async () => {
		const { m, beach } = await world();
		const w = await mountManager(m);
		expect(names(w).sort()).toEqual(['Report Q3.pdf', 'beach.jpg', 'clip.mp4', 'voice.mp3'].sort());
		const row = rowOf(w, 'beach.jpg');
		expect(row.find('.kept-chat').text()).toBe('Bohdan');
		expect(row.find('.kept-sender').text()).toBe('Anna');
		expect(row.find('.kept-date').text()).toBe(new Date((NOW - 20 * DAY) * 1000).toLocaleDateString());
		expect(row.find('.kept-size').text()).toBe(m.formatBytes(beach.f.plain.length));
		expect(row.find('.kept-type').text()).toBe('Image');
	});

	it('searches by name, filters by chat, type and date, and sorts by date and size', async () => {
		const { m } = await world();
		const w = await mountManager(m);
		expect(names(w)).toEqual(['voice.mp3', 'Report Q3.pdf', 'beach.jpg', 'clip.mp4']);

		await w.find('[data-test="kept-search"]').setValue('report');
		expect(names(w)).toEqual(['Report Q3.pdf']);
		await w.find('[data-test="kept-search"]').setValue('');

		await w.find('[data-test="kept-chat"]').setValue(BOHDAN);
		expect(names(w)).toEqual(['voice.mp3', 'beach.jpg']);
		await w.find('[data-test="kept-chat"]').setValue('');

		await w.find('[data-test="kept-type"]').setValue('video');
		expect(names(w)).toEqual(['clip.mp4']);
		await w.find('[data-test="kept-type"]').setValue('');

		await w.find('[data-test="kept-period"]').setValue('week');
		expect(names(w)).toEqual(['voice.mp3', 'Report Q3.pdf']);
		await w.find('[data-test="kept-period"]').setValue('');

		await w.find('[data-test="kept-sort"]').setValue('largest');
		expect(names(w)[0]).toBe('clip.mp4');
		await w.find('[data-test="kept-sort"]').setValue('oldest');
		expect(names(w)).toEqual(['clip.mp4', 'beach.jpg', 'Report Q3.pdf', 'voice.mp3']);
	});

	it('opens a kept file from this device: a picture in place, a document in the browser', async () => {
		const { m, beach, report } = await world();
		const w = await mountManager(m);
		server.offline = true;

		await rowOf(w, 'beach.jpg').find('[data-test="kept-open"]').trigger('click');
		await settle();
		const img = w.find('[data-test="kept-preview"] img');
		expect(img.exists()).toBe(true);
		expect(await blobText(img.attributes('src')!)).toBe(beach.f.plain);

		await rowOf(w, 'Report Q3.pdf').find('[data-test="kept-open"]').trigger('click');
		await settle();
		expect(opened).toHaveLength(1);
		expect(await blobText(opened[0])).toBe(report.f.plain);
	});

	it('plays a kept video and audio in place', async () => {
		const { m, clip, voice } = await world();
		const w = await mountManager(m);
		server.offline = true;
		await rowOf(w, 'clip.mp4').find('[data-test="kept-open"]').trigger('click');
		await settle();
		expect(await blobText(w.find('[data-test="kept-preview"] video').attributes('src')!)).toBe(clip.f.plain);
		await rowOf(w, 'voice.mp3').find('[data-test="kept-open"]').trigger('click');
		await settle();
		expect(await blobText(w.find('[data-test="kept-preview"] audio').attributes('src')!)).toBe(voice.f.plain);
	});

	it('saves a kept file as an ordinary file under its name', async () => {
		const { m, report } = await world();
		const w = await mountManager(m);
		server.offline = true;
		await rowOf(w, 'Report Q3.pdf').find('[data-test="kept-save"]').trigger('click');
		await settle();
		expect(saved.map((s) => s.name)).toEqual(['Report Q3.pdf']);
		expect(await blobText(saved[0].url)).toBe(report.f.plain);
	});

	it('removes one file from this device', async () => {
		const { m, report } = await world();
		const w = await mountManager(m);
		await rowOf(w, 'Report Q3.pdf').find('[data-test="kept-remove"]').trigger('click');
		await settle();
		expect(names(w)).not.toContain('Report Q3.pdf');
		const index = await m.keptFiles.listKeptFiles(ALICE);
		expect(Object.values(index).map((f) => f.name)).not.toContain('Report Q3.pdf');
		expect(Object.keys(index)).toHaveLength(3);
		expect(Object.keys(index)).not.toContain(`${report.part.uploaderHash}/${report.part.fileId}`);
	});

	it('removes nothing when the removal is not confirmed', async () => {
		const { m } = await world();
		window.confirm = () => false;
		const w = await mountManager(m);
		await rowOf(w, 'Report Q3.pdf').find('[data-test="kept-remove"]').trigger('click');
		await settle();
		expect(Object.keys(await m.keptFiles.listKeptFiles(ALICE))).toHaveLength(4);
	});

	it('removes several selected files at once', async () => {
		const { m } = await world();
		const w = await mountManager(m);
		await rowOf(w, 'beach.jpg').find('[data-test="kept-select"]').setValue(true);
		await rowOf(w, 'clip.mp4').find('[data-test="kept-select"]').setValue(true);
		await w.find('[data-test="kept-remove-selected"]').trigger('click');
		await settle();
		expect(names(w).sort()).toEqual(['Report Q3.pdf', 'voice.mp3']);
		expect(Object.values(await m.keptFiles.listKeptFiles(ALICE)).map((f) => f.name).sort()).toEqual(['Report Q3.pdf', 'voice.mp3']);
	});

	it('removes every file kept from one chat', async () => {
		const { m } = await world();
		const w = await mountManager(m);
		await w.find('[data-test="kept-chat"]').setValue(BOHDAN);
		await w.find('[data-test="kept-remove-chat"]').trigger('click');
		await settle();
		expect(Object.values(await m.keptFiles.listKeptFiles(ALICE)).map((f) => f.name).sort()).toEqual(['Report Q3.pdf', 'clip.mp4']);
	});

	it('shows how much the kept files and the cache take, and the quota', async () => {
		const { m } = await world();
		const plain = await published({ name: 'not kept.pdf' }, ['cached ', 'only']);
		await m.keptFiles.openFile(ALICE, plain.part);
		await settle();
		const w = await mountManager(m);
		const kept = await m.chunkCache.pinnedBytesOf(ALICE);
		const cache = await m.chunkCache.cachedBytes();
		expect(kept).toBeGreaterThan(0);
		expect(cache).toBeGreaterThan(0);
		expect(w.find('[data-test="kept-bytes"]').text()).toContain(m.formatBytes(kept));
		expect(w.find('[data-test="cache-bytes"]').text()).toContain(m.formatBytes(cache));
		expect(w.find('[data-test="storage-quota"]').text()).toContain(m.formatBytes(5_000_000));
		expect(w.find('[data-test="storage-quota"]').text()).toContain(m.formatBytes(100_000_000));
	});

	it('clears the cache without touching the kept files', async () => {
		const { m, report } = await world();
		const plain = await published({ name: 'not kept.pdf' }, ['cached ', 'only']);
		await m.keptFiles.openFile(ALICE, plain.part);
		await settle();
		const w = await mountManager(m);
		await w.find('[data-test="clear-cache"]').trigger('click');
		await settle();
		expect(await m.chunkCache.cachedBytes()).toBe(0);
		expect(w.find('[data-test="cache-bytes"]').text()).toContain(m.formatBytes(0));
		server.offline = true;
		expect(text(await m.keptFiles.openFile(ALICE, report.part))).toBe(report.f.plain);
		await expect(m.keptFiles.openFile(ALICE, plain.part)).rejects.toThrow();
	});
});

describe('the kept index', () => {
	it('records the chat for the local files list', async () => {
		const m = await load();
		const { part } = await published({ kind: 'video', name: 'clip.mp4', mimeType: 'video/mp4' });
		await keep(m, part, BOHDAN);
		const [entry] = Object.values(await m.keptFiles.listKeptFiles(ALICE));
		expect(entry).toMatchObject({ peerHash: BOHDAN });
	});

	it('still lists and opens an entry kept before the index named its chat', async () => {
		let m = await load();
		const { f, part } = await published({ name: 'old.pdf' });
		await keep(m, part, BOHDAN);
		const { IndexedDbStore } = await import('@/lib/data/indexedDbStore');
		const { createSecureStore } = await import('@/lib/data/secureStore');
		const { getLocalStorageKeyFor } = await import('@/lib/data/localCrypto');
		const sealed = createSecureStore(new IndexedDbStore('buckitup-kept-files'), { getKey: () => getLocalStorageKeyFor(ALICE) });
		const index = JSON.parse((await sealed.get(`${ALICE}|kept`))!) as Record<string, Record<string, unknown>>;
		for (const e of Object.values(index)) delete e.peerHash;
		await sealed.set(`${ALICE}|kept`, JSON.stringify(index));

		m = await load();
		const w = await mountManager(m);
		expect(rowOf(w, 'old.pdf').find('.kept-chat').text()).toBe('Unknown chat');
		server.offline = true;
		await rowOf(w, 'old.pdf').find('[data-test="kept-save"]').trigger('click');
		await settle();
		expect(await blobText(saved[0].url)).toBe(f.plain);
	});
});

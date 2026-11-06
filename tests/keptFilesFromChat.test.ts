// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { installFakeServer, publishFile, serve, type FakeServer, type PublishedFile } from './helpers/fileServer';

const ALICE = 'u_' + '1'.repeat(128);
const BOB = 'u_' + '2'.repeat(128);
const session = vi.hoisted(() => ({ user: '' }));

vi.mock('@/lib/data/cardRegistry', async (importOriginal) => {
	const { cards } = await import('./helpers/fileServer');
	return { ...(await importOriginal<object>()), getVerifiedSignPkey: async (hash: string) => cards[hash] ?? null };
});
vi.mock('@/store/userPQ.store', () => ({ userPQStore: () => ({ get currentUserHash() { return session.user; } }) }));
vi.mock('@/libs/EncryptionManagerPQ', () => ({ EncryptionManagerPQ: { getInstance: () => ({}) } }));
vi.mock('@/lib/data/localCrypto', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getLocalStorageKeyFor: async (owner: string) => {
		if (session.user !== owner) throw Object.assign(new Error('No unlocked account'), { name: 'VaultLockedError' });
		const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`local key of ${owner}`));
		return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
	},
}));
vi.mock('vue-boring-avatars', () => ({ default: { template: '<span />' } }));

let server: FakeServer;
const blobs = new Map<string, Blob>();

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	server = installFakeServer();
	session.user = ALICE;
	blobs.clear();
	URL.createObjectURL = (b: Blob) => {
		const url = `blob:test/${blobs.size + 1}`;
		blobs.set(url, b);
		return url;
	};
	URL.revokeObjectURL = () => {};
	window.confirm = () => false;
});

afterEach(() => useWorker(false));

const settle = async () => {
	for (let i = 0; i < 20; i++) {
		await flushPromises();
		await new Promise((r) => setTimeout(r, 2));
	}
};

const boot = async () => {
	vi.resetModules();
	setActivePinia(createPinia());
	const { useDialogsStore } = await import('@/store/dialogs.store');
	return {
		dialogs: useDialogsStore(),
		useKeptFiles: (await import('@/composables/useKeptFiles')).useKeptFiles,
		fileKey: (await import('@/lib/data/fileKey')).fileKey,
		chunkCache: await import('@/lib/data/chunkCache'),
		keptFiles: await import('@/lib/data/keptFiles'),
		ChatWindow: (await import('@/components/chat/ChatWindow.vue')).default,
	};
};
type App = Awaited<ReturnType<typeof boot>>;

function useWorker(on: boolean) {
	if (!on) {
		delete (navigator as { serviceWorker?: unknown }).serviceWorker;
		return;
	}
	Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
	Object.defineProperty(navigator, 'serviceWorker', {
		configurable: true,
		value: {
			getRegistration: async () => ({}),
			ready: Promise.resolve({}),
			controller: { postMessage: vi.fn() },
			addEventListener: () => {},
		},
	});
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (blob: Blob) => new Promise<Uint8Array>((ok, fail) => {
	const reader = new FileReader();
	reader.onload = () => ok(new Uint8Array(reader.result as ArrayBuffer));
	reader.onerror = () => fail(reader.error);
	reader.readAsArrayBuffer(blob);
});

type Kind = 'file' | 'image' | 'audio' | 'video';
type Part = PublishedFile['part'] & Record<string, unknown>;

const partOf = (f: PublishedFile, kind: Kind): Part => {
	switch (kind) {
		case 'image': return { ...f.part, kind: 'image', name: 'photo.jpg', mimeType: 'image/jpeg', widthAspect: 4, heightAspect: 3 };
		case 'audio': return { ...f.part, kind: 'file', name: 'voice.mp3', mimeType: 'audio/mpeg' };
		case 'video': return { ...f.part, kind: 'video', name: 'clip.mp4', mimeType: 'video/mp4', widthAspect: 16, heightAspect: 9, durationSeconds: 3 };
		default: return f.part;
	}
};

let fileNo = 0;
const published = async (chunks = ['first chunk ', 'second chunk']) => {
	fileNo += 1;
	const f = await publishFile('f_' + fileNo.toString(16).padStart(32, '0'), chunks);
	serve(server, f);
	return f;
};

const keepFromChat = async (app: App, part: Part, messageId: string) => {
	const told: string[] = [];
	const k = app.useKeptFiles({ owner: () => session.user, onError: (m) => told.push(m) });
	await settle();
	await k.setKept(part, messageId, true);
	return { k, told };
};

const openFromChat = async (app: App, part: Part): Promise<string> => {
	if (part.kind !== 'video') return text(await app.dialogs.fetchFile(part));
	const source = await app.dialogs.openVideoSource(part, {});
	if (source.streaming) return 'streamed from the network';
	const blob = blobs.get(source.url);
	if (!blob) throw new Error(`the video source ${source.url} is not a local blob`);
	return text(await bytesOf(blob));
};

const variants: Array<[string, Kind, boolean]> = [
	['a file', 'file', false],
	['an image', 'image', false],
	['an audio file', 'audio', false],
	['a video, without a Service Worker', 'video', false],
	['a video, through the Service Worker', 'video', true],
];

describe.each(variants)('%s kept on this device', (_label, kind, worker) => {
	const messageId = `dmsg_${kind}`;

	const keptThenReloaded = async () => {
		const f = await published();
		const part = partOf(f, kind);
		const first = await boot();
		const { told } = await keepFromChat(first, part, messageId);
		expect(told).toEqual([]);
		useWorker(worker);
		return { f, part, app: await boot() };
	};

	it('opens after a reload', async () => {
		const { f, part, app } = await keptThenReloaded();
		const opened = await openFromChat(app, part);
		if (opened !== 'streamed from the network') expect(opened).toBe(f.plain);
	});

	it('opens offline, from this device alone', async () => {
		const { f, part, app } = await keptThenReloaded();
		server.offline = true;
		expect(await openFromChat(app, part)).toBe(f.plain);
	});

	it('opens after the sender deleted it from the server', async () => {
		const { f, part, app } = await keptThenReloaded();
		server.deleteFile(f);
		expect(await openFromChat(app, part)).toBe(f.plain);
	});
});

describe.each(['file', 'audio'] as Kind[])('%s kept from a deleted message', (kind) => {
	const messageId = `dmsg_${kind}`;

	it('opens from the kept copy\'s row after the message was deleted', async () => {
		const f = await published();
		const first = await boot();
		await keepFromChat(first, partOf(f, kind), messageId);
		const app = await boot();
		const k = app.useKeptFiles({ owner: () => session.user });
		await settle();
		const wrapper = mount(app.ChatWindow, {
			props: {
				title: 'Peer', myHash: ALICE, reactions: {},
				messages: [{
					id: messageId, text: '', parts: [], _deleted: true, authorName: 'Peer', isMine: false, timestamp: '10:00', _syncStatus: 'synced',
					_raw: { message_id: messageId, sign_hash: 'dms_' + '1'.repeat(128), sender_hash: f.part.uploaderHash, parent_sign_hash: null },
				}],
				kept: k.kept.value,
				keptByMessage: k.keptByMessage.value,
			},
			global: { stubs: { Avatar: true } },
		});
		const action = wrapper.find('.msg-file-action[title="Download and decrypt"]');
		expect(action.exists()).toBe(true);
		await action.trigger('click');
		server.offline = true;
		const [emitted] = wrapper.emitted('downloadFile')?.[0] as [Part];
		expect(text(await app.dialogs.fetchFile(emitted))).toBe(f.plain);
	});
});

describe.each(['file', 'image', 'audio', 'video'] as Kind[])('the chat offers the keep switch for %s', (kind) => {
	it('opens the file state screen, where the switch is, from the message', async () => {
		const f = await published();
		const part = partOf(f, kind);
		const app = await boot();
		const wrapper = mount(app.ChatWindow, {
			props: {
				title: 'Peer', myHash: ALICE, reactions: {},
				messages: [{
					id: 'dmsg_1', text: '', parts: [part], authorName: 'Peer', isMine: false, timestamp: '10:00', _syncStatus: 'synced',
					_raw: { message_id: 'dmsg_1', sign_hash: 'dms_' + '1'.repeat(128), sender_hash: part.uploaderHash, parent_sign_hash: null },
				}],
			},
			global: { stubs: { Avatar: true } },
		});
		for (const el of wrapper.findAll('.message-bubble *')) await el.trigger('click');
		const asked = (wrapper.emitted('showFileState') ?? []).map(([p]) => (p as Part).fileId);
		expect(asked).toContain(part.fileId);
	});
});

describe('kept chunks under cache pressure', () => {
	it('LRU eviction removes other files\' chunks, never the kept ones', async () => {
		const kept = await published(['kept one ', 'kept two']);
		const other = await published(['other one ', 'other two']);
		const third = await published(['third one ', 'third two']);
		let app = await boot();
		app.chunkCache.__setChunkBudgetForTests(60);
		await keepFromChat(app, kept.part, 'dmsg_k');
		await app.dialogs.fetchFile(other.part);
		await settle();
		await app.dialogs.fetchFile(third.part);
		await settle();

		app = await boot();
		server.offline = true;
		expect(text(await app.dialogs.fetchFile(kept.part))).toBe(kept.plain);
		await expect(app.dialogs.fetchFile(other.part)).rejects.toThrow();
	});
});

describe('two accounts on one device', () => {
	it('each keeps its own pins: one letting the file go or leaving the device leaves the other\'s copy', async () => {
		const f = await published();
		let app = await boot();
		const alice = await keepFromChat(app, f.part, 'dmsg_a');
		session.user = BOB;
		app = await boot();
		await keepFromChat(app, f.part, 'dmsg_b');

		session.user = ALICE;
		app = await boot();
		const aliceAgain = app.useKeptFiles({ owner: () => session.user });
		await settle();
		await aliceAgain.setKept(f.part, 'dmsg_a', false);
		expect(alice.told).toEqual([]);
		await app.keptFiles.forgetAccountKeptFiles(ALICE);

		session.user = BOB;
		app = await boot();
		server.offline = true;
		expect(text(await app.dialogs.fetchFile(f.part))).toBe(f.plain);
		expect(await app.chunkCache.pinnedBytesOf(BOB)).toBeGreaterThan(0);
	});
});

describe('an account leaving the device', () => {
	it('takes its kept copies: nothing of them opens, no index, no pins', async () => {
		const f = await published();
		let app = await boot();
		await keepFromChat(app, f.part, 'dmsg_a');
		await app.keptFiles.forgetAccountKeptFiles(ALICE);

		app = await boot();
		server.offline = true;
		expect(await app.keptFiles.listKeptFiles(ALICE)).toEqual({});
		expect(await app.chunkCache.pinnedBytesOf(ALICE)).toBe(0);
		await expect(app.dialogs.fetchFile(f.part)).rejects.toThrow();
	});
});

const dumpIndexedDb = async (): Promise<string> => {
	const out: string[] = [];
	const asText = (v: unknown): string => {
		if (v instanceof ArrayBuffer) return String.fromCharCode(...new Uint8Array(v));
		if (ArrayBuffer.isView(v)) return String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
		if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}=${asText(x)}`).join(';');
		return String(v);
	};
	for (const { name } of await indexedDB.databases()) {
		const db = await new Promise<IDBDatabase>((ok, fail) => {
			const r = indexedDB.open(name!);
			r.onsuccess = () => ok(r.result);
			r.onerror = () => fail(r.error);
		});
		for (const store of Array.from(db.objectStoreNames)) {
			const tx = db.transaction(store, 'readonly');
			const [keys, values] = await Promise.all(['getAllKeys', 'getAll'].map((m) => new Promise<unknown[]>((ok) => {
				const r = (tx.objectStore(store) as unknown as Record<string, () => IDBRequest>)[m]();
				r.onsuccess = () => ok(r.result as unknown[]);
			})));
			out.push(...keys.map(asText), ...values.map(asText));
		}
		db.close();
	}
	return out.join('\n');
};

describe('what a kept file leaves in IndexedDB', () => {
	it('holds neither the secret nor the name nor the contents in the clear', async () => {
		const f = await published(['the plaintext of a secret file']);
		const app = await boot();
		await keepFromChat(app, { ...f.part, name: 'salary-review.pdf' }, 'dmsg_a');
		const dump = await dumpIndexedDb();
		expect(dump).toContain(`${ALICE}|kept`);
		expect(dump).not.toContain(f.secretB64);
		expect(dump).not.toContain(f.secretB64.replace(/=+$/, ''));
		expect(dump).not.toContain(String.fromCharCode(...Uint8Array.from(atob(f.secretB64), (c) => c.charCodeAt(0))));
		expect(dump).not.toContain('salary-review.pdf');
		expect(dump).not.toContain('the plaintext of a secret file');
	});
});

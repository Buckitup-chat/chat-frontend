// "Wipe all": the deletes are awaited until each one ends, a connection held by
// another tab is reported rather than outlived by the page, the wipe asked for
// on one load runs at the start of the next, before anything opens a database,
// and the other tabs of the app are told to go.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { wipeDevice, finishPendingWipe, requestWipe, wipePending, leaveOnWipe, APP_DATABASES, type WipeEnv } from '@/lib/wipeDevice';

const open = (factory: IDBFactory, name: string, version?: number) =>
	new Promise<IDBDatabase>((resolve, reject) => {
		const req = factory.open(name, version);
		req.onupgradeneeded = () => req.result.createObjectStore('s');
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

const names = async (factory: IDBFactory) => (await factory.databases()).map((db) => db.name).sort();

const memoryStorage = (): Storage => {
	const map = new Map<string, string>();
	return {
		get length() { return map.size; },
		key: (i: number) => [...map.keys()][i] ?? null,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, String(v)),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear(),
	};
};

type Entry = { removeError?: string };
const fileSystem = (entries: Record<string, Entry>) => {
	const left = new Map(Object.entries(entries));
	const root = {
		async *keys() { yield* [...left.keys()]; },
		async removeEntry(name: string) {
			const error = left.get(name)?.removeError;
			if (error) throw new DOMException('refused', error);
			left.delete(name);
		},
	};
	return { left, storage: { getDirectory: async () => root as unknown as FileSystemDirectoryHandle } };
};

let factory: IDBFactory;
let local: Storage;
const env = (over: Partial<WipeEnv> = {}): WipeEnv => ({ indexedDB: factory, localStorage: local, storage: fileSystem({}).storage, ...over });

beforeEach(() => {
	factory = new IDBFactory();
	local = memoryStorage();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('wiping the device', () => {
	// Promise.all over the IDBRequests resolved at once: they are not promises.
	it('resolves once every database is gone, and clears localStorage', async () => {
		for (const name of ['keyval-store', 'buckitup-outbox', 'buckitup-chunks']) (await open(factory, name)).close();
		local.setItem('buckitup_shape_persistence', '0');

		expect(await wipeDevice(env())).toBe('done');
		expect(await names(factory)).toEqual([]);
		expect(local.length).toBe(0);
	});

	it('lets a connection that closes on versionchange go', async () => {
		const db = await open(factory, 'buckitup-local-store');
		db.onversionchange = () => db.close();

		expect(await wipeDevice(env())).toBe('done');
		expect(await names(factory)).toEqual([]);
	});

	// idb-keyval in another tab keeps its connection and ignores versionchange.
	it('reports a database another tab holds open, and removes the rest', async () => {
		const held = await open(factory, 'keyval-store');
		(await open(factory, 'buckitup-outbox')).close();

		expect(await wipeDevice(env({ waitMs: 50 }))).toBe('blocked');
		expect(await names(factory)).toEqual(['keyval-store']);

		held.close();
		await vi.waitFor(async () => expect(await names(factory)).toEqual([]));
		expect(await wipeDevice(env())).toBe('done');
	});

	// A delete queued behind another pending request gets no event at all.
	it('stops waiting for a delete that stays silent', async () => {
		const held = await open(factory, 'keyval-store', 1);
		const upgrade = factory.open('keyval-store', 2);
		upgrade.onerror = () => {};
		await new Promise((resolve) => { upgrade.onblocked = resolve; });

		const started = Date.now();
		expect(await wipeDevice(env({ waitMs: 50 }))).toBe('blocked');
		expect(Date.now() - started).toBeLessThan(2000);
		held.close();
	});

	it('removes the Origin Private File System, and reports an entry another tab holds', async () => {
		const free = fileSystem({ 'buckitup-shapes': {}, other: {} });
		expect(await wipeDevice(env({ storage: free.storage }))).toBe('done');
		expect([...free.left.keys()]).toEqual([]);

		const held = fileSystem({ 'buckitup-shapes': { removeError: 'NoModificationAllowedError' }, other: {} });
		expect(await wipeDevice(env({ storage: held.storage }))).toBe('blocked');
		expect([...held.left.keys()]).toEqual(['buckitup-shapes']);

		const refused = fileSystem({ 'buckitup-shapes': { removeError: 'SecurityError' } });
		expect(await wipeDevice(env({ storage: refused.storage }))).toBe('failed');
	});

	// Starting the app then would hang on that database, so the failure must not offer it.
	it('reports a part held open over a part that failed', async () => {
		const held = await open(factory, 'keyval-store');
		const refused = fileSystem({ x: { removeError: 'SecurityError' } });
		expect(await wipeDevice(env({ storage: refused.storage, waitMs: 50 }))).toBe('blocked');
		held.close();
	});

	// A tab told to go closes the connections it holds as it unloads, a moment after the wipe began.
	it('waits for a connection that goes', async () => {
		const held = await open(factory, 'keyval-store');
		setTimeout(() => held.close(), 50);

		expect(await wipeDevice(env({ waitMs: 2000 }))).toBe('done');
		expect(await names(factory)).toEqual([]);
	});

	// indexedDB.databases() is missing in Firefox before 126.
	it('removes the app\'s databases by name where the browser cannot list them', async () => {
		for (const name of ['keyval-store', 'buckitup-outbox', 'dialog-synced-cache']) (await open(factory, name)).close();
		const unlisting = { deleteDatabase: (name: string) => factory.deleteDatabase(name) } as unknown as IDBFactory;

		expect(await wipeDevice(env({ indexedDB: unlisting }))).toBe('done');
		expect(await names(factory)).toEqual([]);
	});

	it('knows every database the app opens by name', () => {
		const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
			const path = join(dir, entry);
			return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|js|vue)$/.test(entry) ? [path] : [];
		});
		const opened = new Set<string>();
		for (const file of sourceFiles(join(process.cwd(), 'src'))) {
			const text = readFileSync(file, 'utf8');
			const opens = text.matchAll(/(?:\bopenDatabase|\bindexedDB\.open|new IndexedDbStore)\(\s*(?:'([^']+)'|([A-Z_]+)\b)/g);
			for (const [, literal, constant] of opens) {
				const name = literal ?? new RegExp(`const ${constant} = '([^']+)'`).exec(text)?.[1];
				expect(name, `${file}: ${constant}`).toBeTruthy();
				opened.add(name!);
			}
		}
		expect([...opened].sort()).toEqual([...APP_DATABASES].sort());
	});

	it('takes a delete the browser refuses outright for a failure, not for another tab', async () => {
		(await open(factory, 'keyval-store')).close();
		const refusing = Object.assign(Object.create(factory), { deleteDatabase: () => { throw new DOMException('no', 'SecurityError'); } });
		expect(await wipeDevice(env({ indexedDB: refusing }))).toBe('failed');
	});

	it('has nothing to remove where there is no file system (a private window)', async () => {
		const storage = { getDirectory: () => Promise.reject(new DOMException('no', 'SecurityError')) };
		expect(await wipeDevice(env({ storage }))).toBe('done');
	});

	it('fails, rather than reports done, when the databases cannot be listed', async () => {
		(await open(factory, 'keyval-store')).close();
		const unlisted = Object.assign(Object.create(factory), { databases: () => Promise.reject(new Error('no')) });
		expect(await wipeDevice(env({ indexedDB: unlisted }))).toBe('failed');
	});
});

describe('the wipe on the next load', () => {
	let tab: Storage;
	let prompt: ReturnType<typeof vi.fn>;
	let reload: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		tab = memoryStorage();
		prompt = vi.fn(async () => true);
		reload = vi.fn();
	});
	afterEach(() => vi.unstubAllGlobals());

	const inTab = (over: Partial<WipeEnv> = {}) => env({ sessionStorage: tab, ...over });
	const ask = () => requestWipe({ localStorage: local, sessionStorage: tab });
	const settled = (p: Promise<void>) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(r, 100, false))]);

	it('runs only when asked for, and without asking again in the tab that asked', async () => {
		(await open(factory, 'keyval-store')).close();
		await finishPendingWipe(prompt, inTab(), reload);
		expect(await names(factory)).toEqual(['keyval-store']);

		ask();
		expect(wipePending(local)).toBe(true);
		await finishPendingWipe(prompt, inTab(), reload);
		expect(await names(factory)).toEqual([]);
		expect(wipePending(local)).toBe(false);
		expect(local.length + tab.length).toBe(0);
		expect(prompt).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	// The delete stays queued, and the app's first open of the database would wait behind it.
	it('does not let the app start while a part is blocked: it reloads to try again', async () => {
		const held = await open(factory, 'keyval-store');
		ask();
		prompt.mockResolvedValue(false);

		const finishing = finishPendingWipe(prompt, inTab({ waitMs: 20 }), reload);
		await vi.waitFor(() => expect(reload).toHaveBeenCalled());
		expect(prompt).toHaveBeenCalledWith('blocked');
		expect(await settled(finishing)).toBe(false);
		held.close();
	});

	// Closing the tab at the prompt must not leave the vault behind for the next one to open,
	// nor may another tab wipe without asking.
	it('keeps the request until the wipe is done, and another tab asks before finishing it', async () => {
		const held = await open(factory, 'keyval-store');
		local.setItem('device-label', 'Laptop');
		ask();
		void finishPendingWipe(prompt, inTab({ waitMs: 20 }), reload);
		await vi.waitFor(() => expect(reload).toHaveBeenCalled());
		expect(local.getItem('device-label')).toBeNull();
		expect(wipePending(local)).toBe(true);

		held.close();
		await finishPendingWipe(prompt, env({ sessionStorage: memoryStorage() }), reload);
		expect(prompt).toHaveBeenLastCalledWith('unfinished');
		expect(await names(factory)).toEqual([]);
		expect(wipePending(local)).toBe(false);
	});

	it('lets another tab keep what is left', async () => {
		(await open(factory, 'keyval-store')).close();
		ask();
		prompt.mockResolvedValueOnce(false);
		await finishPendingWipe(prompt, env({ sessionStorage: memoryStorage() }), reload);
		expect(prompt).toHaveBeenCalledWith('unfinished');
		expect(await names(factory)).toEqual(['keyval-store']);
		expect(wipePending(local)).toBe(false);
	});

	it('lets the app start with what is left when the wipe failed and the person chooses so', async () => {
		ask();
		const refused = fileSystem({ x: { removeError: 'SecurityError' } });

		prompt.mockResolvedValueOnce(true);
		expect(await settled(finishPendingWipe(prompt, inTab({ storage: refused.storage }), reload))).toBe(false);
		expect(reload).toHaveBeenCalledTimes(1);
		expect(wipePending(local)).toBe(true);

		prompt.mockResolvedValueOnce(false);
		expect(await settled(finishPendingWipe(prompt, inTab({ storage: refused.storage }), reload))).toBe(true);
		expect(prompt).toHaveBeenLastCalledWith('failed');
		expect(reload).toHaveBeenCalledTimes(1);
		expect(wipePending(local)).toBe(false);
	});

	// Two tabs restored together: the one that finished and started must not be wiped under.
	it('runs in one tab at a time, and a tab that waited finds it done', async () => {
		let queue = Promise.resolve();
		const locks = { request: (_: string, run: () => Promise<unknown>) => { const p = queue.then(run); queue = p.then(() => {}, () => {}); return p; } } as unknown as LockManager;
		(await open(factory, 'keyval-store')).close();
		ask();
		const deletes = vi.spyOn(factory, 'deleteDatabase');

		const other = env({ sessionStorage: memoryStorage(), locks });
		await Promise.all([finishPendingWipe(prompt, inTab({ locks }), reload), finishPendingWipe(prompt, other, reload)]);
		expect(deletes).toHaveBeenCalledTimes(1);
		// the other tab found nothing left to ask about
		expect(prompt).not.toHaveBeenCalled();
		expect(wipePending(local)).toBe(false);
	});

	it('does not let a tab\'s mark outlive a wipe another tab finished', async () => {
		(await open(factory, 'keyval-store')).close();
		ask();
		await finishPendingWipe(prompt, env({ sessionStorage: memoryStorage() }), reload);
		expect(wipePending(local)).toBe(false);
		await finishPendingWipe(prompt, inTab(), reload);
		expect(tab.length).toBe(0);

		// A later request, asked for elsewhere and left unfinished, is not this tab's to run unasked.
		(await open(factory, 'keyval-store')).close();
		requestWipe({ localStorage: local, sessionStorage: memoryStorage() });
		prompt.mockClear().mockResolvedValueOnce(false);
		await finishPendingWipe(prompt, inTab(), reload);
		expect(prompt).toHaveBeenCalledWith('unfinished');
		expect(await names(factory)).toEqual(['keyval-store']);
	});

	it('refuses to be asked for where nothing would run it', () => {
		vi.stubGlobal('localStorage', undefined);
		expect(() => requestWipe()).toThrow(/cannot wipe itself/);
	});
});

describe('the other tabs', () => {
	let channels: BroadcastChannel[] = [];
	let channelName = '';
	// Each tab has its own end of one channel, as each page of the app does.
	const tabChannel = () => {
		const channel = new BroadcastChannel(channelName);
		channels.push(channel);
		return channel;
	};
	beforeEach(() => {
		channelName = `buckitup:wipe:test:${Math.random()}`;
	});
	afterEach(() => {
		for (const channel of channels) channel.close();
		channels = [];
	});

	it('end their sessions and reload when one tab asks, and finish the wipe without asking again', async () => {
		(await open(factory, 'keyval-store')).close();
		const asking = { sessionStorage: memoryStorage(), channel: tabChannel(), reload: vi.fn() };
		// A page the worker controls tells it too: the one that asked may not be controlled (a hard reload).
		const controller = { postMessage: vi.fn() };
		const other = { sessionStorage: memoryStorage(), channel: tabChannel(), serviceWorker: { controller } as unknown as ServiceWorkerContainer };
		const steps: string[] = [];
		leaveOnWipe(async () => {}, env(asking), asking.reload);
		leaveOnWipe(async () => { steps.push('session ended'); }, env(other), () => steps.push('reload'));

		requestWipe({ localStorage: local, ...asking });
		await vi.waitFor(() => expect(steps).toEqual(['session ended', 'reload']));
		expect(asking.reload).not.toHaveBeenCalled();
		expect(controller.postMessage).toHaveBeenCalledWith({ type: 'wipe' });

		// The next load of the tab that was told to go.
		const prompt = vi.fn(async () => true);
		await finishPendingWipe(prompt, env({ sessionStorage: other.sessionStorage }), vi.fn());
		expect(prompt).not.toHaveBeenCalled();
		expect(await names(factory)).toEqual([]);
		expect(wipePending(local)).toBe(false);
	});

	it('go even when the session does not end', async () => {
		const reload = vi.fn();
		leaveOnWipe(() => new Promise(() => {}), env({ sessionStorage: memoryStorage(), channel: tabChannel(), waitMs: 20 }), reload);
		requestWipe({ localStorage: local, sessionStorage: memoryStorage(), channel: tabChannel() });
		await vi.waitFor(() => expect(reload).toHaveBeenCalled());
	});
});

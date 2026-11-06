// "Keep on this device": a kept file is its ciphertext chunks, pinned, plus a
// sealed index entry per account — and it opens from those alone: offline,
// after the uploader deleted it, after the cache was under pressure.
// Real chunk cache over fake-indexeddb, real verification and AES-GCM; only
// the server is faked (helpers/fileServer.ts).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { cards, installFakeServer, publishFile, resolveSignPkey, serve, type FakeServer, type PublishedFile } from './helpers/fileServer';
import { failWritesWithQuota } from './helpers/idbQuota';

vi.mock('@/lib/data/cardRegistry', () => ({ getVerifiedSignPkey: async (hash: string) => cards[hash] ?? null }));

const { __resetChunkCacheForTests, __setChunkBudgetForTests, putCachedChunk, pinChunk, pinnedBytesOf } = await import('@/lib/data/chunkCache');
const {
	keepFile, releaseKeptFile, listKeptFiles, openFile, openKeptFile, forgetAccountKeptFiles, _setKeptFilesStoreForTests, _settleKeptFilesSweepsForTests,
} = await import('@/lib/data/keptFiles');
const { FileDeletedError, downloadFile } = await import('@/lib/data/fileTransfer');
const { fileKey } = await import('@/lib/data/fileKey');

const ALICE = 'u_' + '1'.repeat(128);
const BOB = 'u_' + '2'.repeat(128);
const messageId = 'dmsg_0192aaaa-0000-7000-8000-000000000001';
const fid = (n: number) => 'f_' + String(n).repeat(32);

let raw: Map<string, string>;
let locked: Set<string>;
let server: FakeServer;
const accountKeys = new Map<string, CryptoKey>();
const keyOf = async (owner: string) => {
	if (locked.has(owner)) throw new Error('No unlocked account');
	if (!accountKeys.has(owner)) accountKeys.set(owner, await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']));
	return accountKeys.get(owner)!;
};

beforeEach(async () => {
	await _settleKeptFilesSweepsForTests();
	globalThis.indexedDB = new IDBFactory();
	__resetChunkCacheForTests();
	raw = new Map();
	locked = new Set();
	_setKeptFilesStoreForTests(rawStore(), keyOf);
	server = installFakeServer();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function rawStore() {
	return {
		get: async (k: string) => raw.get(k) ?? null,
		set: async (k: string, v: string) => { raw.set(k, v); },
		delete: async (k: string) => { raw.delete(k); },
		keys: async () => [...raw.keys()],
		clear: async () => raw.clear(),
	};
}

/** Something a test holds a step at: `at` resolves once the step waits, `open` lets it go on. */
const gate = () => {
	let open!: () => void;
	const until = new Promise<void>((resolve) => { open = resolve; });
	let reached!: () => void;
	const at = new Promise<void>((resolve) => { reached = resolve; });
	return { until, open, at, reached };
};
type Gate = ReturnType<typeof gate>;

/** The raw store, its next write or delete held before it lands, or its next read held after it has read. */
const gatedStore = () => {
	const store = rawStore();
	const { get, set, delete: del } = store;
	const next: Record<'get' | 'set' | 'delete', Gate | null> = { get: null, set: null, delete: null };
	const wait = async (which: keyof typeof next) => {
		const g = next[which];
		next[which] = null;
		if (g) {
			g.reached();
			await g.until;
		}
	};
	store.set = async (k: string, v: string) => {
		await wait('set');
		return set(k, v);
	};
	store.delete = async (k: string) => {
		await wait('delete');
		return del(k);
	};
	store.get = async (k: string) => {
		const value = await get(k);
		await wait('get');
		return value;
	};
	return { store, holdGet: () => (next.get = gate()), holdSet: () => (next.set = gate()), holdDelete: () => (next.delete = gate()) };
};

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);
/** Chunks of `f` already on this device, as a download would have left them. */
const cacheChunks = async (f: PublishedFile, indexes: number[]) => {
	for (const i of indexes) await putCachedChunk(f.fileId, i, f.bytes[i], f.chunkRows[i].data_hash as string);
};

describe('keeping a file', () => {
	it('fetches the chunks the device lacks with progress, and pins them', async () => {
		const f = await publishFile(fid(1), ['alpha ', 'beta ', 'gamma']);
		serve(server, f);
		const progress: number[] = [];
		const tx = vi.spyOn(IDBDatabase.prototype, 'transaction');
		const entry = await keepFile(ALICE, f.part, messageId, { resolveSignPkey, onProgress: (p) => progress.push(p.done) });
		expect(tx.mock.calls.filter(([, mode]) => mode === 'readwrite')).toHaveLength(3); // one per chunk, none for those not on disk
		expect(progress).toEqual([1, 2, 3]);
		expect(server.chunkRequests).toEqual([`${f.fileId}:2`, `${f.fileId}:0`, `${f.fileId}:1`]); // the last first: it shows the secret opens the file
		expect(entry).toMatchObject({ fileKey: fileKey(f.part), name: 'report.pdf', messageId });
		expect(await pinnedBytesOf(ALICE)).toBe(f.bytes.reduce((n, b) => n + b.length, 0));
	});

	it('pins the chunks already on this device a batch per write, without fetching them', async () => {
		const f = await publishFile(fid(10), ['alpha ', 'beta ', 'gamma ', 'delta ', 'epsilon ', 'zeta ', 'eta']);
		serve(server, f);
		await cacheChunks(f, [0, 1, 2, 3, 4, 6]);
		const tx = vi.spyOn(IDBDatabase.prototype, 'transaction');
		const progress: number[] = [];
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey, onProgress: (p) => progress.push(p.done) });
		// The read of the last chunk touches it; then the six on disk in two batches, the fetched one alone.
		expect(tx.mock.calls.filter(([, mode]) => mode === 'readwrite')).toHaveLength(4);
		tx.mockRestore();
		expect(server.chunkRequests).toEqual([`${f.fileId}:5`]);
		expect(progress).toEqual([6, 7]);
		expect(await pinnedBytesOf(ALICE)).toBe(f.bytes.reduce((n, b) => n + b.length, 0));
		server.offline = true;
		expect(text(await openFile(ALICE, f.part))).toBe(f.plain);
	});

	it('fetches a chunk the device holds under another hash instead of pinning it', async () => {
		const f = await publishFile(fid(16), ['alpha ', 'beta']);
		serve(server, f);
		await cacheChunks(f, [0]);
		await putCachedChunk(f.fileId, 1, new Uint8Array(32).fill(9), 'fd_' + '09'.repeat(64));
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		expect(server.chunkRequests).toEqual([`${f.fileId}:1`]);
		server.offline = true;
		expect(text(await openFile(ALICE, f.part))).toBe(f.plain);
	});

	it('refuses a file the secret does not open before fetching more than its last chunk', async () => {
		const f = await publishFile(fid(17), ['one ', 'two ', 'three']);
		const other = await publishFile(fid(18), ['x']);
		serve(server, f);
		await expect(keepFile(ALICE, { ...f.part, encSecretB64: other.secretB64 }, messageId, { resolveSignPkey })).rejects.toThrow();
		expect(server.chunkRequests).toEqual([`${f.fileId}:2`]);
		expect(await listKeptFiles(ALICE)).toEqual({});
		expect(await pinnedBytesOf(ALICE)).toBe(0);
	});

	it('refuses a file with a chunk the secret does not open', async () => {
		const f = await publishFile(fid(20), ['one ', 'two ', 'three'], [1]);
		serve(server, f);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(keepFile(ALICE, f.part, messageId, { resolveSignPkey })).rejects.toThrow();
		warn.mockRestore();
		expect(await listKeptFiles(ALICE)).toEqual({});
		expect(await pinnedBytesOf(ALICE)).toBe(0);
	});

	it('refuses a copy held whole on this device that the secret does not open', async () => {
		const f = await publishFile(fid(11), ['sealed']);
		const other = await publishFile(fid(12), ['x']);
		serve(server, f);
		await cacheChunks(f, [0]);
		await expect(keepFile(ALICE, { ...f.part, encSecretB64: other.secretB64 }, messageId, { resolveSignPkey })).rejects.toThrow();
		expect(server.chunkRequests).toEqual([]);
		expect(await listKeptFiles(ALICE)).toEqual({});
		expect(await pinnedBytesOf(ALICE)).toBe(0);
	});

	it('seals the index under the account\'s key: no secret, file id or name readable on disk', async () => {
		const f = await publishFile(fid(2), ['secret contents']);
		serve(server, f);
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		expect([...raw.keys()]).toEqual([`${ALICE}|kept`]);
		const stored = [...raw.values()].join('');
		expect(stored).not.toContain(f.secretB64);
		expect(stored).not.toContain(f.fileId);
		expect(stored).not.toContain('report.pdf');
		expect(stored).not.toContain(messageId);
		// Another account neither lists it nor opens it.
		expect(await listKeptFiles(BOB)).toEqual({});
		expect(await openKeptFile(BOB, fileKey(f.part))).toBeNull();
	});

	it('opens offline from the kept copy alone', async () => {
		const f = await publishFile(fid(3), ['one ', 'two']);
		serve(server, f);
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		server.offline = true;
		expect(text(await openFile(ALICE, f.part))).toBe(f.plain);
		// Not kept by BOB: for him it is a download, and there is no network.
		await expect(openFile(BOB, f.part)).rejects.toThrow();
	});

	it('opens after the uploader deleted the file and the server reclaimed it', async () => {
		const f = await publishFile(fid(4), ['still ', 'here']);
		serve(server, f);
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		server.deleteFile(f);
		await expect(downloadFile({ fileId: f.fileId, uploaderHash: f.part.uploaderHash, encSecretB64: f.secretB64, resolveSignPkey }))
			.rejects.toBeInstanceOf(FileDeletedError);
		expect(text(await openFile(ALICE, f.part))).toBe(f.plain);
	});

	it('survives cache pressure: newer cache entries do not push it out', async () => {
		__setChunkBudgetForTests(1024);
		const f = await publishFile(fid(5), ['kept ', 'bytes']);
		serve(server, f);
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		for (let i = 0; i < 4; i++) await putCachedChunk(fid(6), i, new Uint8Array(1024).fill(i), 'fd_' + String(i).repeat(128));
		server.offline = true;
		expect(text(await openFile(ALICE, f.part))).toBe(f.plain);
	});

	it('cannot keep a file the uploader already deleted', async () => {
		const f = await publishFile(fid(7), ['gone']);
		server.deleteFile(f);
		await expect(keepFile(ALICE, f.part, messageId, { resolveSignPkey })).rejects.toBeInstanceOf(FileDeletedError);
		expect(await listKeptFiles(ALICE)).toEqual({});
	});

	it('refuses a copy that would not open: a secret the chunks do not decrypt under', async () => {
		const f = await publishFile(fid(8), ['sealed']);
		const other = await publishFile(fid(9), ['x']);
		serve(server, f);
		await expect(keepFile(ALICE, { ...f.part, encSecretB64: other.secretB64 }, messageId, { resolveSignPkey })).rejects.toThrow();
		expect(await listKeptFiles(ALICE)).toEqual({});
		expect(await pinnedBytesOf(ALICE)).toBe(0);
	});

	it('a write that does not fit fails the keep with QuotaExceededError and leaves nothing pinned', async () => {
		const f = await publishFile(fid(8), ['first ', 'second ', 'third']);
		serve(server, f);
		// The disk fills up at the second chunk; the first is already pinned.
		const restore = failWritesWithQuota((v) => (v as { key?: string }).key === `${f.fileId}:1`);
		let error: unknown;
		try {
			error = await keepFile(ALICE, f.part, messageId, { resolveSignPkey }).then(() => null, (e) => e);
		} finally {
			restore();
		}
		expect((error as Error)?.name).toBe('QuotaExceededError');
		expect(await listKeptFiles(ALICE)).toEqual({});
		expect(await pinnedBytesOf(ALICE)).toBe(0);
	});
});

describe('letting a kept file go', () => {
	it('releasing removes the entry and the account\'s pins, not another account\'s', async () => {
		const f = await publishFile(fid(9), ['shared']);
		serve(server, f);
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		await keepFile(BOB, f.part, messageId, { resolveSignPkey });
		await releaseKeptFile(ALICE, fileKey(f.part));
		expect(await listKeptFiles(ALICE)).toEqual({});
		expect(await pinnedBytesOf(ALICE)).toBe(0);
		server.offline = true;
		expect(text(await openFile(BOB, f.part))).toBe(f.plain);
	});

	const diskFailure = () => {
		throw new DOMException('The disk failed', 'UnknownError');
	};
	/** Makes the next transaction on the chunk store fail, as a failing disk does. */
	const failNextTransaction = () => vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(diskFailure);

	it('drops the pins a release whose unpin failed left behind', async () => {
		const f = await publishFile(fid(13), ['stray']);
		serve(server, f);
		await listKeptFiles(ALICE); // the page's first listing sweeps, done before the keep below
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		const tx = failNextTransaction();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await releaseKeptFile(ALICE, fileKey(f.part)); // released: the entry is gone
		tx.mockRestore();
		await vi.waitFor(async () => expect(await pinnedBytesOf(ALICE)).toBe(0));
		warn.mockRestore();
		expect(await listKeptFiles(ALICE)).toEqual({});
	});

	it('goes on past a stray file it cannot release, and tries it again at the next listing', async () => {
		const [a, b] = await Promise.all([publishFile(fid(21), ['a']), publishFile(fid(22), ['b'])]);
		for (const f of [a, b]) await pinChunk(f.fileId, 0, f.chunkRows[0].data_hash as string, ALICE, f.bytes[0]);
		const transaction = IDBDatabase.prototype.transaction;
		// The listing of the pins goes through; the unpin of a, the first stray, fails.
		const tx = vi.spyOn(IDBDatabase.prototype, 'transaction')
			.mockImplementationOnce(function (this: IDBDatabase, ...args) { return transaction.apply(this, args); })
			.mockImplementationOnce(diskFailure);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await listKeptFiles(ALICE);
		await vi.waitFor(() => expect(warn).toHaveBeenCalled());
		tx.mockRestore();
		warn.mockRestore();
		expect(await pinnedBytesOf(ALICE)).toBe(a.bytes[0].length);
		await listKeptFiles(ALICE);
		await vi.waitFor(async () => expect(await pinnedBytesOf(ALICE)).toBe(0));
	});

	it('drops, at the first listing, the pins a closed page left without an entry', async () => {
		const f = await publishFile(fid(19), ['half']);
		await pinChunk(f.fileId, 0, f.chunkRows[0].data_hash as string, ALICE, f.bytes[0]);
		expect(await listKeptFiles(ALICE)).toEqual({});
		await vi.waitFor(async () => expect(await pinnedBytesOf(ALICE)).toBe(0));
	});

	it('does not undo a keep still pinning its chunks', async () => {
		const a = await publishFile(fid(14), ['first']);
		const b = await publishFile(fid(15), ['one ', 'two ', 'three']);
		serve(server, a);
		serve(server, b);
		await listKeptFiles(ALICE);
		await keepFile(ALICE, a.part, messageId, { resolveSignPkey });
		let open!: () => void;
		const gate = new Promise<void>((resolve) => { open = resolve; });
		const fetchOf = globalThis.fetch;
		globalThis.fetch = (async (input: string, init?: RequestInit) => {
			if (String(input).endsWith(`/file_chunk/${b.fileId}/1`)) await gate;
			return fetchOf(input, init);
		}) as typeof fetch;
		const sizeOf = (...bytes: Uint8Array[]) => bytes.reduce((n, x) => n + x.length, 0);

		// b's last chunk is read first and pinned last, so b has chunk 0 pinned while chunk 1 waits.
		const keeping = keepFile(ALICE, b.part, messageId, { resolveSignPkey });
		await vi.waitFor(async () => expect(await pinnedBytesOf(ALICE)).toBe(sizeOf(a.bytes[0], b.bytes[0])));
		// a's unpin fails, and the sweep it starts finds b pinned but not listed yet.
		const tx = failNextTransaction();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await releaseKeptFile(ALICE, fileKey(a.part));
		tx.mockRestore();
		await vi.waitFor(async () => expect(await pinnedBytesOf(ALICE)).toBe(b.bytes[0].length));
		// Time for the sweep to queue on b's file lock; then the keep finishes, then the sweep's turn on b.
		await new Promise((resolve) => setTimeout(resolve, 50));
		open();
		await keeping;
		await new Promise((resolve) => setTimeout(resolve, 50));
		warn.mockRestore();
		expect(Object.keys(await listKeptFiles(ALICE))).toEqual([fileKey(b.part)]);
		expect(await pinnedBytesOf(ALICE)).toBe(sizeOf(...b.bytes));
	});

	it('an account leaving the device takes its index and pins, without its key', async () => {
		const f = await publishFile(fid(0), ['bye']);
		serve(server, f);
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		await keepFile(BOB, f.part, messageId, { resolveSignPkey });
		accountKeys.delete(ALICE);
		await forgetAccountKeptFiles(ALICE);
		expect(raw.has(`${ALICE}|kept`)).toBe(false);
		expect(await pinnedBytesOf(ALICE)).toBe(0);
		expect(Object.keys(await listKeptFiles(BOB))).toEqual([fileKey(f.part)]);
	});
});

describe('the index across tabs and sessions', () => {
	it('a keep in one tab does not drop what another tab kept meanwhile', async () => {
		const [f1, f2] = [await publishFile(fid(1), ['one']), await publishFile(fid(2), ['two'])];
		serve(server, f1);
		serve(server, f2);
		expect(await listKeptFiles(ALICE)).toEqual({});
		vi.resetModules();
		const otherTab = await import('@/lib/data/keptFiles');
		otherTab._setKeptFilesStoreForTests(rawStore(), keyOf);
		await otherTab.keepFile(ALICE, f1.part, messageId, { resolveSignPkey });
		await keepFile(ALICE, f2.part, messageId, { resolveSignPkey });
		expect(Object.keys(await listKeptFiles(ALICE)).sort()).toEqual([fileKey(f1.part), fileKey(f2.part)].sort());
	});

	it('lists nothing once the account is locked, cached or not', async () => {
		const f = await publishFile(fid(3), ['mine']);
		serve(server, f);
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		locked.add(ALICE);
		await expect(listKeptFiles(ALICE)).rejects.toThrow('No unlocked account');
		await expect(openKeptFile(ALICE, fileKey(f.part))).rejects.toThrow('No unlocked account');
	});
	it('keeps in its cached index a keep written while an earlier read was still unsealing', async () => {
		const f = await publishFile(fid(23), ['late']);
		serve(server, f);
		const disk = gatedStore();
		_setKeptFilesStoreForTests(disk.store, keyOf);
		const reading = disk.holdGet();
		const listing = listKeptFiles(ALICE);
		await reading.at; // has read the index as it is before the keep
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		reading.open();
		expect(await listing).toEqual({});
		expect(Object.keys(await listKeptFiles(ALICE))).toEqual([fileKey(f.part)]);
	});

	it('keeps in its cached index a keep whose write finished while a read begun during it was unsealing', async () => {
		const [a, b] = await Promise.all([publishFile(fid(24), ['a']), publishFile(fid(25), ['b'])]);
		serve(server, a);
		serve(server, b);
		const disk = gatedStore();
		_setKeptFilesStoreForTests(disk.store, keyOf);
		await keepFile(ALICE, b.part, messageId, { resolveSignPkey });
		const writing = disk.holdSet();
		const keepingA = keepFile(ALICE, a.part, messageId, { resolveSignPkey });
		await writing.at; // a's index write has begun
		const reading = disk.holdGet();
		const rereadB = keepFile(ALICE, b.part, messageId, { resolveSignPkey }); // kept already: only reads the index
		await reading.at; // and has read it without a
		writing.open();
		await keepingA;
		reading.open();
		await rereadB;
		expect(Object.keys(await listKeptFiles(ALICE)).sort()).toEqual([fileKey(a.part), fileKey(b.part)].sort());
	});

	it('lists nothing once the account left the device, though a read of its index was under way', async () => {
		const f = await publishFile(fid(26), ['gone']);
		serve(server, f);
		const disk = gatedStore();
		_setKeptFilesStoreForTests(disk.store, keyOf);
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		await listKeptFiles(BOB); // the tab's cache holds another account
		const reading = disk.holdGet();
		const reread = keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		await reading.at;
		await forgetAccountKeptFiles(ALICE);
		reading.open();
		await reread;
		expect(await listKeptFiles(ALICE)).toEqual({});
	});

	it('lists nothing once the account left the device, though its index was read while it was leaving', async () => {
		const f = await publishFile(fid(27), ['going']);
		serve(server, f);
		const disk = gatedStore();
		_setKeptFilesStoreForTests(disk.store, keyOf);
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey });
		const deleting = disk.holdDelete();
		const leaving = forgetAccountKeptFiles(ALICE);
		await deleting.at;
		await keepFile(ALICE, f.part, messageId, { resolveSignPkey }); // kept still: only reads the index, and caches it
		deleting.open();
		await leaving;
		expect(await listKeptFiles(ALICE)).toEqual({});
	});
});


// "Keep on this device": a kept file is its ciphertext chunks, pinned, plus a
// sealed index entry per account — and it opens from those alone: offline,
// after the uploader deleted it, after the cache was under pressure.
// Real chunk cache over fake-indexeddb, real verification and AES-GCM; only
// the server is faked (helpers/fileServer.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { cards, installFakeServer, publishFile, resolveSignPkey, serve, type FakeServer } from './helpers/fileServer';
import { failWritesWithQuota } from './helpers/idbQuota';

vi.mock('@/lib/data/cardRegistry', () => ({ getVerifiedSignPkey: async (hash: string) => cards[hash] ?? null }));

const { __resetChunkCacheForTests, __setChunkBudgetForTests, putCachedChunk, pinnedBytesOf } = await import('@/lib/data/chunkCache');
const {
	keepFile, releaseKeptFile, listKeptFiles, openFile, openKeptFile, forgetAccountKeptFiles, _setKeptFilesStoreForTests,
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

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	__resetChunkCacheForTests();
	raw = new Map();
	locked = new Set();
	_setKeptFilesStoreForTests(rawStore(), keyOf);
	server = installFakeServer();
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

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

describe('keeping a file', () => {
	it('fetches the chunks the device lacks with progress, and pins them', async () => {
		const f = await publishFile(fid(1), ['alpha ', 'beta ', 'gamma']);
		serve(server, f);
		const progress: number[] = [];
		const entry = await keepFile(ALICE, f.part, messageId, { resolveSignPkey, onProgress: (p) => progress.push(p.done) });
		expect(progress).toEqual([1, 2, 3]);
		expect(server.chunkRequests).toEqual([`${f.fileId}:0`, `${f.fileId}:1`, `${f.fileId}:2`]);
		expect(entry).toMatchObject({ fileKey: fileKey(f.part), name: 'report.pdf', messageId });
		expect(await pinnedBytesOf(ALICE)).toBe(f.bytes.reduce((n, b) => n + b.length, 0));
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
});

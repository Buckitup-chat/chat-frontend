// The persistent chunk cache stores CIPHERTEXT only — what the device already
// holds — so a reload reassembles attachments from disk with zero new secrets
// on the client.
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
	getCachedChunk, putCachedChunk, pinChunk, unpinFile, unpinAllOf, pinnedBytesOf, soleKeptBytesOf,
	__resetChunkCacheForTests, __setChunkBudgetForTests,
} from '@/lib/data/chunkCache';
import { failWritesWithQuota } from './helpers/idbQuota';

const H = 'fd_' + '01'.repeat(64);
const H2 = 'fd_' + '02'.repeat(64);
const ALICE = 'u_' + 'a'.repeat(128);
const BOB = 'u_' + 'b'.repeat(128);
const KB = (fill: number) => new Uint8Array(1024).fill(fill);
const tick = () => new Promise((r) => setTimeout(r, 5));
const present = async (fileId: string, index = 0, hash = H) => (await getCachedChunk(fileId, index, hash)) !== null;

describe('chunk cache', () => {
	beforeEach(() => {
		// a fresh database per test, like a fresh origin
		globalThis.indexedDB = new IDBFactory();
		__resetChunkCacheForTests();
	});

	it('round-trips encrypted bytes by (fileId, index)', async () => {
		const bytes = new Uint8Array([1, 2, 3, 255, 0]);
		await putCachedChunk('f_a', 0, bytes, H);
		expect(Array.from((await getCachedChunk('f_a', 0, H))!)).toEqual([1, 2, 3, 255, 0]);
		expect(await getCachedChunk('f_a', 1, H)).toBe(null);
		expect(await getCachedChunk('f_b', 0, H)).toBe(null);
	});

	it('stores a copy, not a view into the caller buffer', async () => {
		const bytes = new Uint8Array([7, 7, 7]);
		await putCachedChunk('f_c', 0, bytes, H);
		bytes.fill(0);
		expect(Array.from((await getCachedChunk('f_c', 0, H))!)).toEqual([7, 7, 7]);
	});

	it('survives a subarray with a non-zero offset', async () => {
		const backing = new Uint8Array([9, 9, 1, 2, 3]);
		await putCachedChunk('f_d', 0, backing.subarray(2), H);
		expect(Array.from((await getCachedChunk('f_d', 0, H))!)).toEqual([1, 2, 3]);
	});

	it('answers only for the hash a chunk was stored under', async () => {
		await putCachedChunk('f_h', 0, new Uint8Array([4, 5]), H);
		expect(await getCachedChunk('f_h', 0, 'fd_' + '02'.repeat(64))).toBe(null);
		expect(Array.from((await getCachedChunk('f_h', 0, H))!)).toEqual([4, 5]);
	});

	it('degrades to a silent no-op where IndexedDB is missing', async () => {
		// @ts-expect-error simulating an environment without IndexedDB
		delete globalThis.indexedDB;
		__resetChunkCacheForTests();
		await putCachedChunk('f_e', 0, new Uint8Array([1]), H);
		expect(await getCachedChunk('f_e', 0, H)).toBe(null);
	});
});

describe('kept chunks', () => {
	beforeEach(() => {
		globalThis.indexedDB = new IDBFactory();
		__resetChunkCacheForTests();
		// Room for three 1 KiB chunks of plain cache.
		__setChunkBudgetForTests(3 * 1024);
	});

	it('survive eviction under pressure while unpinned chunks go, oldest first', async () => {
		await pinChunk('f_kept', 0, H, ALICE, KB(1));
		await tick();
		await putCachedChunk('f_old', 0, KB(2), H);
		await tick();
		for (const id of ['f_n1', 'f_n2', 'f_n3']) {
			await putCachedChunk(id, 0, KB(3), H);
			await tick();
		}
		// The kept chunk is the oldest by use and does not count against the budget.
		expect(await present('f_kept')).toBe(true);
		expect(await present('f_old')).toBe(false);
		for (const id of ['f_n1', 'f_n2', 'f_n3']) expect(await present(id)).toBe(true);
	});

	it('stay pinned while any account pins them: one account letting go keeps the chunk', async () => {
		await pinChunk('f_shared', 0, H, ALICE, KB(1));
		await pinChunk('f_shared', 0, H, BOB, KB(1));
		await unpinFile('f_shared', ALICE);
		for (const id of ['f_a', 'f_b', 'f_c', 'f_d']) { await tick(); await putCachedChunk(id, 0, KB(2), H); }
		expect(await present('f_shared')).toBe(true);
		expect(await pinnedBytesOf(BOB)).toBe(1024);
		expect(await pinnedBytesOf(ALICE)).toBe(0);

		// The last account letting go makes it plain cache again: enough newer
		// chunks push it out like any other.
		await unpinFile('f_shared', BOB);
		for (const id of ['f_e', 'f_f', 'f_g']) { await tick(); await putCachedChunk(id, 0, KB(2), H); }
		expect(await present('f_shared')).toBe(false);
	});

	it('counts as freed by an account leaving only the chunks no other account keeps', async () => {
		await pinChunk('f_shared', 0, H, ALICE, KB(1));
		await pinChunk('f_shared', 0, H, BOB, KB(1));
		await pinChunk('f_own', 0, H, ALICE, new Uint8Array(2048));
		expect(await pinnedBytesOf(ALICE)).toBe(3 * 1024);
		expect(await soleKeptBytesOf(ALICE)).toBe(2 * 1024);
		await unpinFile('f_shared', BOB);
		expect(await soleKeptBytesOf(ALICE)).toBe(3 * 1024);
	});

	it('an account leaving drops its pins on every file, not another account\'s', async () => {
		await pinChunk('f_x', 0, H, ALICE, KB(1));
		await pinChunk('f_x', 1, H, ALICE, KB(1));
		await pinChunk('f_y', 0, H, BOB, KB(1));
		await unpinAllOf(ALICE);
		expect(await pinnedBytesOf(ALICE)).toBe(0);
		expect(await pinnedBytesOf(BOB)).toBe(1024);
	});

	it('a cache write and a read of a kept chunk keep its pin', async () => {
		await pinChunk('f_p', 0, H, ALICE, KB(1));
		await putCachedChunk('f_p', 0, KB(1), H);
		await getCachedChunk('f_p', 0, H);
		await tick();
		expect(await pinnedBytesOf(ALICE)).toBe(1024);
	});

	it('is not replaced by other bytes under the same key', async () => {
		await pinChunk('f_q', 0, H, ALICE, KB(1));
		await putCachedChunk('f_q', 0, KB(9), H2);
		expect(await present('f_q', 0, H)).toBe(true);
		await expect(pinChunk('f_q', 0, H2, BOB, KB(9))).rejects.toThrow(/other contents/);
	});

	it('a pin that does not fit rejects with the browser\'s QuotaExceededError and pins nothing', async () => {
		const restore = failWritesWithQuota((v) => !!(v as { pins?: string[] }).pins?.length);
		try {
			const e = await pinChunk('f_full', 0, H, ALICE, KB(1)).then(() => null, (err) => err);
			expect(e?.name).toBe('QuotaExceededError');
		} finally {
			restore();
		}
		expect(await present('f_full')).toBe(false);
		expect(await pinnedBytesOf(ALICE)).toBe(0);
	});

	it('a cache write that does not fit is still swallowed', async () => {
		const restore = failWritesWithQuota(() => true);
		try {
			await expect(putCachedChunk('f_c', 0, KB(1), H)).resolves.toBeUndefined();
		} finally {
			restore();
		}
	});

	it('another tab holding an older version open does not hang this one, and the cache opens once it closes', async () => {
		const old = await new Promise<IDBDatabase>((resolve) => {
			const req = indexedDB.open('buckitup-chunks', 1);
			req.onsuccess = () => resolve(req.result);
		});
		expect(await getCachedChunk('f_a', 0, H)).toBeNull();
		await expect(pinChunk('f_a', 0, H, ALICE, KB(1))).rejects.toThrow('The local database is not available');
		old.close();
		await tick();
		await pinChunk('f_a', 0, H, ALICE, KB(1));
		expect(await pinnedBytesOf(ALICE)).toBe(1024);
	});

	it('closes for another tab\'s upgrade instead of blocking it', async () => {
		await putCachedChunk('f_a', 0, KB(1), H);
		const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open('buckitup-chunks', 3);
			req.onsuccess = () => resolve(req.result);
			req.onblocked = () => reject(new Error('blocked'));
		});
		upgraded.close();
	});
});

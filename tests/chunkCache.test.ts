// The persistent chunk cache stores CIPHERTEXT only — what the device already
// holds — so a reload reassembles attachments from disk with zero new secrets
// on the client.
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { getCachedChunk, putCachedChunk, __resetChunkCacheForTests } from '@/lib/data/chunkCache';

describe('chunk cache', () => {
	beforeEach(() => {
		// a fresh database per test, like a fresh origin
		globalThis.indexedDB = new IDBFactory();
		__resetChunkCacheForTests();
	});

	it('round-trips encrypted bytes by (fileId, index)', async () => {
		const bytes = new Uint8Array([1, 2, 3, 255, 0]);
		await putCachedChunk('f_a', 0, bytes);
		expect(Array.from((await getCachedChunk('f_a', 0))!)).toEqual([1, 2, 3, 255, 0]);
		expect(await getCachedChunk('f_a', 1)).toBe(null);
		expect(await getCachedChunk('f_b', 0)).toBe(null);
	});

	it('stores a copy, not a view into the caller buffer', async () => {
		const bytes = new Uint8Array([7, 7, 7]);
		await putCachedChunk('f_c', 0, bytes);
		bytes.fill(0);
		expect(Array.from((await getCachedChunk('f_c', 0))!)).toEqual([7, 7, 7]);
	});

	it('survives a subarray with a non-zero offset', async () => {
		const backing = new Uint8Array([9, 9, 1, 2, 3]);
		await putCachedChunk('f_d', 0, backing.subarray(2));
		expect(Array.from((await getCachedChunk('f_d', 0))!)).toEqual([1, 2, 3]);
	});

	it('degrades to a silent no-op where IndexedDB is missing', async () => {
		// @ts-expect-error simulating an environment without IndexedDB
		delete globalThis.indexedDB;
		__resetChunkCacheForTests();
		await putCachedChunk('f_e', 0, new Uint8Array([1]));
		expect(await getCachedChunk('f_e', 0)).toBe(null);
	});
});

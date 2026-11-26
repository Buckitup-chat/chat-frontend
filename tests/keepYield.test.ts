// Keeping a file checks one signed row per chunk before anything is pinned,
// and each check holds the main thread for milliseconds: the page gets its
// turn between batches of rows, not only once every row is checked.
// Real verification, chunk cache over fake-indexeddb; only the server is
// faked (helpers/fileServer.ts), and the row check is counted, not changed.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { cards, installFakeServer, publishFile, resolveSignPkey, serve, type FakeServer } from './helpers/fileServer';

const rows = vi.hoisted(() => ({ checked: 0, onCheck: null as null | (() => void) }));

vi.mock('@/lib/data/cardRegistry', () => ({ getVerifiedSignPkey: async (hash: string) => cards[hash] ?? null }));
vi.mock('@/lib/data/rowVerification', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/data/rowVerification')>();
	return {
		...actual,
		verifyRowWithKey: (...args: Parameters<typeof actual.verifyRowWithKey>) => {
			rows.checked += 1;
			rows.onCheck?.();
			return actual.verifyRowWithKey(...args);
		},
	};
});

const { __resetChunkCacheForTests, pinnedBytesOf } = await import('@/lib/data/chunkCache');
const { pinFileChunks } = await import('@/lib/data/fileTransfer');

const OWNER = 'u_' + '1'.repeat(128);
const CHUNKS = 24;
let server: FakeServer;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	__resetChunkCacheForTests();
	server = installFakeServer();
	rows.checked = 0;
	rows.onCheck = null;
});

describe('keeping a file of many chunks', () => {
	it('lets a task queued when the first chunk row is checked run before the last one is', async () => {
		const f = await publishFile('f_' + '7'.repeat(32), Array.from({ length: CHUNKS }, (_, i) => `chunk ${i} `));
		serve(server, f);
		let checkedWhenTaskRan = -1;
		rows.onCheck = () => {
			rows.onCheck = null;
			setTimeout(() => { checkedWhenTaskRan = rows.checked; }, 0);
		};
		await pinFileChunks({ fileId: f.fileId, uploaderHash: f.part.uploaderHash, encSecretB64: f.secretB64, owner: OWNER, resolveSignPkey });
		expect(rows.checked).toBe(CHUNKS);
		expect(checkedWhenTaskRan).toBeGreaterThan(0);
		expect(checkedWhenTaskRan).toBeLessThan(CHUNKS);
		expect(await pinnedBytesOf(OWNER)).toBe(f.bytes.reduce((n, b) => n + b.length, 0));
	});
});

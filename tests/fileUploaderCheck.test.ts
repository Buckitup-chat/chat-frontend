import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { encryptChunk, generateEncSecret } from '@/lib/pq/fileCrypto';
import { toBase64 } from '@/lib/pq/signature';

// pq_avatars § The photo: a reader takes a profile photo only as its sender's
// own upload. The manifest names the uploader; downloadFile holds a caller's
// expected uploader against it before a byte is fetched.

const FILE_ID = 'f_' + '7'.repeat(32);
const PEER = 'u_' + 'b'.repeat(128);
const OTHER = 'u_' + 'c'.repeat(128);

vi.mock('@/lib/data/shapeRead', () => ({
	readShapeOnce: async () => [{ file_id: FILE_ID, uploader_hash: PEER, chunk_count: 1, deleted_flag: false }],
}));
vi.mock('@/lib/data/chunkCache', () => ({
	getCachedChunk: async () => null,
	putCachedChunk: async () => {},
	requestPersistentStorage: () => {},
}));
vi.mock('@/lib/data/readSession', () => ({ bearerFor: () => null, openSession: async () => {} }));

const secret = generateEncSecret();
const plain = new TextEncoder().encode('a photo');
const encrypted = await encryptChunk(secret, plain);
const originalFetch = globalThis.fetch;
const fetchMock = vi.fn(async () => new Response(encrypted as unknown as BodyInit, { status: 200 }));
beforeEach(() => {
	fetchMock.mockClear();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; });

const { downloadFile } = await import('@/lib/data/fileTransfer');
const ref = { fileId: FILE_ID, encSecretB64: toBase64(secret) };

describe('downloadFile: expected uploader', () => {
	it('downloads a file its sender uploaded', async () => {
		expect(await downloadFile({ ...ref, uploaderHash: PEER })).toEqual(plain);
	});

	it('refuses a file someone else uploaded, before fetching it', async () => {
		await expect(downloadFile({ ...ref, uploaderHash: OTHER })).rejects.toThrow(/someone other than its sender/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('checks nothing when the caller names no uploader', async () => {
		expect(await downloadFile(ref)).toEqual(plain);
	});
});

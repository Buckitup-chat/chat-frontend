import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

vi.mock('@buckitup/pq-client/signature', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@buckitup/pq-client/signature')>();
	return { ...actual, signFields: () => 'AAAA' };
});

// The chunk rows the device holds for a file, as the file_chunks shape answers.
let storedRows = new Map<number, Record<string, unknown>>();
vi.mock('@/lib/data/fileIntegrity', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/data/fileIntegrity')>()),
	readChunkRows: async () => storedRows,
}));

const SKEY = new Uint8Array(32).fill(3);
const UPLOADER_HASH = 'u_' + 'a'.repeat(128);

let ingestOnline = false;
const ingestCalls: unknown[][] = [];

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: unknown[]) => {
			ingestCalls.push(mutations);
			if (!ingestOnline) throw new TypeError('Failed to fetch');
			return {
				status: 200,
				json: async () => ({
					results: mutations.map((_, index) => ({ index, status: 'ok', txid: 900 + index })),
				}),
			} as unknown as Response;
		},
	},
}));

const originalFetch = globalThis.fetch;
beforeEach(() => {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (url.includes('/file_chunk/')) return new Response(null, { status: 200 });
		return new Response(null, { status: 404 });
	}) as unknown as typeof fetch;
});
afterAll(() => {
	globalThis.fetch = originalFetch;
});

const { uploadFile, prepareUpload } = await import('@/lib/data/fileTransfer');
const { CHUNK_SIZE } = await import('@buckitup/pq-client/fileCrypto');
const { toBase64, fromBase64 } = await import('@buckitup/pq-client/signature');
const { sha3_512 } = await import('@noble/hashes/sha3');
const { pendingEntries, _setStorageForTests, _setLeaderForTests } = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

afterEach(() => {
	_setLeaderForTests(null);
});

beforeEach(() => {
	ingestOnline = false;
	ingestCalls.length = 0;
	storedRows = new Map();
	_setStorageForTests(makeStorage());
	_setLeaderForTests(true);
	_setAcceptedSnapshotStorageForTests(makeStorage());
});

describe('file manifest commit goes through the durable mutation lifecycle (§4.8)', () => {
	it('durably queues the manifest even when the commit fails outright', { timeout: 20_000 }, async () => {
		const { fileId, encSecretB64 } = prepareUpload('0192aaaa-0000-7000-8000-000000000001');
		const bytes = new TextEncoder().encode('hello file');

		const uploaded = uploadFile({ bytes, uploaderHash: UPLOADER_HASH, signSkey: SKEY, fileId, encSecretB64 });
		uploaded.catch(() => {});

		let pending: Awaited<ReturnType<typeof pendingEntries>> = [];
		for (let i = 0; i < 200 && pending.length === 0; i++) {
			pending = await pendingEntries(UPLOADER_HASH);
			if (pending.length === 0) await new Promise((r) => setTimeout(r, 10));
		}

		expect(pending).toHaveLength(1);
		expect(pending[0].relation).toBe('files');
		expect(pending[0].mutations[0]).toMatchObject({
			syncMetadata: { relation: 'files' },
			modified: expect.objectContaining({ file_id: fileId, uploader_hash: UPLOADER_HASH }),
		});

		await expect(uploaded).rejects.toThrow();
	});

	it('succeeds normally when the manifest commit lands on the first try', async () => {
		ingestOnline = true;
		const { fileId, encSecretB64 } = prepareUpload('0192aaaa-0000-7000-8000-000000000002');
		const bytes = new TextEncoder().encode('hello again');

		const result = await uploadFile({ bytes, uploaderHash: UPLOADER_HASH, signSkey: SKEY, fileId, encSecretB64 });

		expect(result.fileId).toBe(fileId);
		expect(await pendingEntries(UPLOADER_HASH)).toHaveLength(0);
		expect(ingestCalls).toHaveLength(1);
	});

	it('resumes by sending only the chunks the device lacks, and binds the ones it holds (§4.1)', async () => {
		ingestOnline = true;
		const { fileId, encSecretB64 } = prepareUpload('0192aaaa-0000-7000-8000-000000000003');
		const storedSign = toBase64(new Uint8Array([1, 2, 3]));
		storedRows = new Map([[0, { chunk_index: 0, sign_b64: storedSign }]]);

		await uploadFile({ bytes: new Uint8Array(CHUNK_SIZE + 10), uploaderHash: UPLOADER_HASH, signSkey: SKEY, fileId, encSecretB64, resuming: true });

		const puts = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/file_chunk/'));
		expect(puts).toEqual([expect.stringMatching(new RegExp(`/file_chunk/${fileId}/1$`))]);
		const manifest = (ingestCalls[0][0] as { modified: { chunk_count: number; chunk_sign_hashes: string[] } }).modified;
		expect(manifest.chunk_count).toBe(2);
		expect(manifest.chunk_sign_hashes[0]).toBe(toBase64(sha3_512(fromBase64(storedSign))));
	});
});

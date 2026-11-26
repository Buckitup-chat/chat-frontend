// The chunk PUT's refusals (chat pq_files §4): the device never replaces a
// stored chunk (409), keeps a file_id to the uploader of its first chunk
// (403 "uploader mismatch") and lets only vouched accounts write in a gated
// mode (403 "not_in_trust_chain"). The upload binds what the device holds,
// or stops with an error the caller can act on.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

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

const cached: number[] = [];
vi.mock('@/lib/data/chunkCache', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/data/chunkCache')>()),
	putCachedChunk: async (_fileId: string, index: number) => { cached.push(index); },
}));

const ingestCalls: unknown[][] = [];
vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: unknown[]) => {
			ingestCalls.push(mutations);
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 900 + index })) }),
			} as unknown as Response;
		},
	},
}));

const SKEY = new Uint8Array(32).fill(3);
const UPLOADER_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);

// Index → the device's answer to a PUT of that chunk; unlisted indexes store.
let answers = new Map<number, () => Response>();
const putIndexes = () => vi.mocked(globalThis.fetch).mock.calls
	.map(([url]) => String(url))
	.filter((url) => url.includes('/file_chunk/'))
	.map((url) => Number(url.split('/').pop()));

const originalFetch = globalThis.fetch;
afterAll(() => {
	globalThis.fetch = originalFetch;
});

const { uploadFile, prepareUpload, FileIdTakenError, NoWriteRightsError } = await import('@/lib/data/fileTransfer');
const { CHUNK_SIZE } = await import('@buckitup/pq-client/fileCrypto');
const { toBase64, fromBase64 } = await import('@buckitup/pq-client/signature');
const { sha3_512 } = await import('@noble/hashes/sha3');
const { _setStorageForTests, _setLeaderForTests } = await import('@/lib/data/outbox');
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

beforeEach(() => {
	ingestCalls.length = 0;
	cached.length = 0;
	storedRows = new Map();
	answers = new Map();
	_setStorageForTests(makeStorage());
	_setLeaderForTests(true);
	_setAcceptedSnapshotStorageForTests(makeStorage());
	globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (!url.includes('/file_chunk/')) return new Response(null, { status: 404 });
		const answer = answers.get(Number(url.split('/').pop()));
		return answer ? answer() : new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
	}) as unknown as typeof fetch;
});

const json = (status: number, body: Record<string, unknown>) => () => new Response(JSON.stringify(body), { status });
const twoChunks = () => new Uint8Array(CHUNK_SIZE + 10);
const upload = (fileId: string, encSecretB64: string) =>
	uploadFile({ bytes: twoChunks(), uploaderHash: UPLOADER_HASH, signSkey: SKEY, fileId, encSecretB64 });

describe('chunk PUT refusals', () => {
	it('binds the stored chunk when the device answers 409 for an index it holds from this uploader', async () => {
		const { fileId, encSecretB64 } = prepareUpload('0192bbbb-0000-7000-8000-000000000001');
		const storedSign = toBase64(new Uint8Array([4, 5, 6]));
		storedRows = new Map([[0, { chunk_index: 0, uploader_hash: UPLOADER_HASH, sign_b64: storedSign }]]);
		answers.set(0, json(409, { error: 'chunk exists' }));

		await upload(fileId, encSecretB64);

		expect(putIndexes()).toEqual([0, 1]);
		const manifest = (ingestCalls[0][0] as { modified: { chunk_sign_hashes: string[] } }).modified;
		expect(manifest.chunk_sign_hashes[0]).toBe(toBase64(sha3_512(fromBase64(storedSign))));
		expect(cached).toEqual([1]);
	});

	it('fails on 409 when the device holds no row of this uploader at that index', async () => {
		const { fileId, encSecretB64 } = prepareUpload('0192bbbb-0000-7000-8000-000000000002');
		storedRows = new Map([[0, { chunk_index: 0, uploader_hash: OTHER_HASH, sign_b64: 'AAAA' }]]);
		answers.set(0, json(409, { error: 'chunk exists' }));

		await expect(upload(fileId, encSecretB64)).rejects.toThrow(/held by another upload/);
		expect(ingestCalls).toHaveLength(0);
		expect(cached).toEqual([]);
	});

	it('reports a file_id another uploader holds as FileIdTakenError', async () => {
		const { fileId, encSecretB64 } = prepareUpload('0192bbbb-0000-7000-8000-000000000003');
		answers.set(0, json(403, { error: 'uploader mismatch' }));

		await expect(upload(fileId, encSecretB64)).rejects.toBeInstanceOf(FileIdTakenError);
		expect(putIndexes()).toEqual([0]);
	});

	it('stops at once, without retrying, when the account has no write rights', async () => {
		const { fileId, encSecretB64 } = prepareUpload('0192bbbb-0000-7000-8000-000000000004');
		answers.set(0, json(403, { error: 'not_in_trust_chain', max_depth: 3 }));

		const failure = upload(fileId, encSecretB64);
		await expect(failure).rejects.toBeInstanceOf(NoWriteRightsError);
		await expect(failure).rejects.toThrow(/no write rights/);
		expect(putIndexes()).toEqual([0]);
		expect(cached).toEqual([]);
	});
});

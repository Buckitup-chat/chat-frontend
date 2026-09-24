import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

vi.mock('@/lib/pq/signature', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/pq/signature')>();
	return { ...actual, signFields: () => 'AAAA' };
});

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
	_setStorageForTests(makeStorage());
	_setLeaderForTests(true);
	_setAcceptedSnapshotStorageForTests(makeStorage());
});

describe('file manifest commit goes through the durable mutation lifecycle (§4.8)', () => {
	it('durably queues the manifest even when the commit fails outright', { timeout: 20_000 }, async () => {
		const { fileId, encSecretB64 } = prepareUpload('0192aaaa-0000-7000-8000-000000000001');
		const bytes = new TextEncoder().encode('hello file');

		const uploaded = uploadFile({ bytes, uploaderHash: UPLOADER_HASH, signSkey: SKEY, fileId, encSecretB64 });

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
});

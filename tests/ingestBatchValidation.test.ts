import { describe, it, expect, vi } from 'vitest';
import type { IngestRowResult } from '@/lib/data/types';

let mockResults: unknown = null;
let mockStatus = 200;

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async () => ({
			status: mockStatus,
			json: async () => ({ results: mockResults }),
		}),
	},
}));

const { sendMutations } = await import('@/lib/data/ingest');

const SKEY = new Uint8Array(32);
const mutation = (tag: string) => ({
	type: 'insert',
	syncMetadata: { relation: 'dialog_messages' },
	modified: { message_id: tag },
});

describe('strict batch validation', () => {
	it('a correctly correlated response succeeds regardless of result order', async () => {
		mockStatus = 200;
		mockResults = [
			{ index: 1, status: 'ok', txid: 2 },
			{ index: 0, status: 'ok', txid: 1 },
		];
		const result = await sendMutations([mutation('a'), mutation('b')], SKEY);
		expect(result.txids.sort()).toEqual([1, 2]);
	});

	it('rejects a sparse response (fewer results than mutations sent)', async () => {
		mockStatus = 200;
		mockResults = [{ index: 0, status: 'ok', txid: 1 }];
		await expect(sendMutations([mutation('a'), mutation('b')], SKEY))
			.rejects.toMatchObject({ name: 'IngestError', permanent: false });
	});

	it('rejects an empty results array for non-empty mutations, not treats it as success', async () => {
		mockStatus = 200;
		mockResults = [];
		await expect(sendMutations([mutation('a')], SKEY))
			.rejects.toMatchObject({ name: 'IngestError', permanent: false });
	});

	it('rejects extra results beyond what was sent', async () => {
		mockStatus = 200;
		mockResults = [
			{ index: 0, status: 'ok', txid: 1 },
			{ index: 1, status: 'ok', txid: 2 },
		];
		await expect(sendMutations([mutation('a')], SKEY))
			.rejects.toMatchObject({ name: 'IngestError', permanent: false });
	});

	it('rejects a duplicate index, never applying either result by position', async () => {
		mockStatus = 200;
		mockResults = [
			{ index: 0, status: 'ok', txid: 1 },
			{ index: 0, status: 'ok', txid: 2 },
		];
		await expect(sendMutations([mutation('a'), mutation('b')], SKEY))
			.rejects.toMatchObject({ name: 'IngestError', permanent: false });
	});

	it('rejects an out-of-range index', async () => {
		mockStatus = 200;
		mockResults = [{ index: 5, status: 'ok', txid: 1 }];
		await expect(sendMutations([mutation('a')], SKEY))
			.rejects.toMatchObject({ name: 'IngestError', permanent: false });
	});

	it('rejects a non-integer index rather than coercing it', async () => {
		mockStatus = 200;
		mockResults = [{ index: '0', status: 'ok', txid: 1 } as unknown as IngestRowResult];
		await expect(sendMutations([mutation('a')], SKEY))
			.rejects.toMatchObject({ name: 'IngestError', permanent: false });
	});

	it('rejects an unrecognized result status rather than passing it through as a generic failure', async () => {
		mockStatus = 200;
		mockResults = [{ index: 0, status: 'superseded' } as unknown as IngestRowResult];
		await expect(sendMutations([mutation('a')], SKEY))
			.rejects.toMatchObject({ name: 'IngestError', permanent: false, message: expect.stringContaining('unknown result status') });
	});
});

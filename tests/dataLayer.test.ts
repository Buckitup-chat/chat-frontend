import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sendMutations, sendMutationsWithRetry, IngestError } from '../src/lib/data/ingest';
import { getDialogCollections, _dialogRegistrySize } from '../src/lib/data/collections';

const { secretKey: signSkey } = ml_dsa87.keygen();

const challengeResponse = { challenge: 'test-challenge', challenge_id: 'ch_1' };

const mockFetchSequence = (ingestStatus: number, ingestBody: unknown) => {
	const fetchMock = vi.fn(async (url: string) => {
		if (String(url).includes('/challenge')) {
			return new Response(JSON.stringify(challengeResponse), { status: 200 });
		}
		return new Response(JSON.stringify(ingestBody), { status: ingestStatus });
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
};

beforeEach(() => {
	vi.stubGlobal('btoa', (s: string) => Buffer.from(s, 'binary').toString('base64'));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('sendMutations', () => {
	const mutation = { type: 'insert', modified: { message_id: 'dmsg_1' }, syncMetadata: { relation: 'dialog_messages' } };

	it('returns txids when all rows succeed', async () => {
		mockFetchSequence(200, { results: [{ index: 0, status: 'ok', txid: 42 }] });
		const res = await sendMutations([mutation], signSkey);
		expect(res.txids).toEqual([42]);
	});

	it('treats "has already been taken" as success', async () => {
		mockFetchSequence(422, {
			results: [
				{ index: 0, status: 'ok', txid: 7 },
				{ index: 1, status: 'error', error: 'validation_failed', details: { user_hash: ['has already been taken'] } },
			],
		});
		const res = await sendMutations([mutation, mutation], signSkey);
		expect(res.txids).toEqual([7]);
	});

	it('throws permanent IngestError on validation failure', async () => {
		mockFetchSequence(422, {
			results: [{ index: 0, status: 'error', error: 'validation_failed', details: { sign_hash: ["can't be blank"] } }],
		});
		const err = await sendMutations([mutation], signSkey).catch((e) => e);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.permanent).toBe(true);
	});

	it('throws transient IngestError when body has no per-row results', async () => {
		mockFetchSequence(500, 'Internal Server Error');
		const err = await sendMutations([mutation], signSkey).catch((e) => e);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.permanent).toBe(false);
	});
});

describe('sendMutationsWithRetry', () => {
	const mutation = { type: 'insert', modified: {}, syncMetadata: { relation: 'dialog_messages' } };

	it('does not retry permanent failures', async () => {
		const fetchMock = mockFetchSequence(422, {
			results: [{ index: 0, status: 'error', error: 'validation_failed', details: { uuid: ['is invalid'] } }],
		});
		await expect(sendMutationsWithRetry([mutation], signSkey, { retries: 3, baseDelayMs: 1 })).rejects.toMatchObject({
			permanent: true,
		});
		// one challenge + one ingest, no retries
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('retries transient failures then succeeds', async () => {
		let ingestCalls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (String(url).includes('/challenge')) {
					return new Response(JSON.stringify(challengeResponse), { status: 200 });
				}
				ingestCalls++;
				if (ingestCalls < 3) return new Response('oops', { status: 500 });
				return new Response(JSON.stringify({ results: [{ index: 0, status: 'ok', txid: 1 }] }), { status: 200 });
			})
		);
		const res = await sendMutationsWithRetry([mutation], signSkey, { retries: 4, baseDelayMs: 1 });
		expect(res.txids).toEqual([1]);
		expect(ingestCalls).toBe(3);
	});
});

describe('dialog collection registry', () => {
	it('reuses collections per dialog hash', () => {
		const a1 = getDialogCollections('di_aaa');
		const a2 = getDialogCollections('di_aaa');
		const b = getDialogCollections('di_bbb');
		expect(a1.messages).toBe(a2.messages);
		expect(b.messages).not.toBe(a1.messages);
		expect(_dialogRegistrySize()).toBeGreaterThanOrEqual(2);
	});

	it('exposes all five dialog tables', () => {
		const c = getDialogCollections('di_ccc');
		for (const key of ['keys', 'messages', 'versions', 'reactions', 'receipts'] as const) {
			expect(c[key]).toBeTruthy();
			expect(typeof c[key].preload).toBe('function');
		}
	});
});

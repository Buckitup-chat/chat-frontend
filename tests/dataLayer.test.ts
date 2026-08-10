import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { api } from '../src/api/client';
import { sendMutations, sendMutationsWithRetry, IngestError } from '../src/lib/data/ingest';
import { nextOwnerTimestamp } from '../src/lib/data/time';
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

	// A unique-key conflict is NOT success by itself: the server row may be a
	// different revision (review finding 3 — masked conflicts silently lost
	// edits). sendMutations reports it; the retry wrapper resolves it via the
	// signature identity check.
	it('classifies "has already been taken" as a unique conflict, not success', async () => {
		mockFetchSequence(422, {
			results: [
				{ index: 0, status: 'ok', txid: 7 },
				{ index: 1, status: 'error', error: 'validation_failed', details: { user_hash: ['has already been taken'] } },
			],
		});
		const err = await sendMutations([mutation, mutation], signSkey).catch((e) => e);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.uniqueConflictOnly).toBe(true);
		expect(err.permanent).toBe(true);
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

	// Business-rule rejections are not `validation_failed`, but a 422 verdict
	// is still final — treating it as transient produced endless retries of a
	// hopeless mutation (found live: "cannot react to own message").
	it('treats business-rule 422 rejections as permanent', async () => {
		mockFetchSequence(422, {
			results: [{ index: 0, status: 'error', error: 'cannot react to own message' }],
		});
		const err = await sendMutations([mutation], signSkey).catch((e) => e);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.permanent).toBe(true);
		expect(err.uniqueConflictOnly).toBe(false);
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

	// Idempotent retry: the conflict is success ONLY when the server row is
	// proven identical to ours (signature match) — e.g. the first attempt
	// landed but its response was lost to a network error.
	it('resolves a unique conflict as success when identity is confirmed', async () => {
		mockFetchSequence(422, {
			results: [{ index: 0, status: 'error', error: 'validation_failed', details: { message_id: ['has already been taken'] } }],
		});
		const confirmApplied = vi.fn(async () => true);
		const res = await sendMutationsWithRetry([mutation], signSkey, { retries: 2, baseDelayMs: 1, confirmApplied });
		expect(confirmApplied).toHaveBeenCalledTimes(1);
		expect(res.results.length).toBe(1);
	});

	it('turns a unique conflict into a permanent error when the server row differs', async () => {
		mockFetchSequence(422, {
			results: [{ index: 0, status: 'error', error: 'validation_failed', details: { message_id: ['has already been taken'] } }],
		});
		const confirmApplied = vi.fn(async () => false);
		const err = await sendMutationsWithRetry([mutation], signSkey, { retries: 2, baseDelayMs: 1, confirmApplied }).catch((e) => e);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.permanent).toBe(true);
		expect(err.uniqueConflictOnly).toBe(true);
	});
});

// Monotonic revision timestamps (review finding 7): the server orders
// revisions by owner_timestamp, so consecutive operations inside one
// wall-clock second must still strictly increase.
describe('nextOwnerTimestamp', () => {
	it('advances past a previous timestamp in the same second', () => {
		const now = Math.floor(Date.now() / 1000);
		expect(nextOwnerTimestamp(now)).toBe(now + 1);
		expect(nextOwnerTimestamp(now + 5)).toBe(now + 6);
	});

	it('uses wall clock when there is no previous value', () => {
		const now = Math.floor(Date.now() / 1000);
		expect(nextOwnerTimestamp(null)).toBeGreaterThanOrEqual(now);
		expect(nextOwnerTimestamp(0)).toBeGreaterThanOrEqual(now);
	});
});

describe('dialog collection registry', () => {
	it('reuses collections per dialog hash', () => {
		const dh = (c: string) => 'di_' + c.repeat(128);
		const a1 = getDialogCollections(dh('a'));
		const a2 = getDialogCollections(dh('a'));
		const b = getDialogCollections(dh('b'));
		expect(a1.messages).toBe(a2.messages);
		expect(b.messages).not.toBe(a1.messages);
		expect(_dialogRegistrySize()).toBeGreaterThanOrEqual(2);
	});

	it('exposes all five dialog tables', () => {
		const c = getDialogCollections('di_' + 'c'.repeat(128));
		for (const key of ['keys', 'messages', 'versions', 'reactions', 'receipts'] as const) {
			expect(c[key]).toBeTruthy();
			expect(typeof c[key].preload).toBe('function');
		}
	});

	// subscribeChanges returns a subscription object, NOT an unsubscribe
	// function. Treating it as callable threw inside beforeUnmount and broke
	// the whole chat component on navigation.
	it('returns a subscription object with unsubscribe()', () => {
		const sub = getDialogCollections('di_' + 'd'.repeat(128)).messages.subscribeChanges(() => {});
		expect(typeof sub).toBe('object');
		expect(typeof sub.unsubscribe).toBe('function');
		expect(() => sub.unsubscribe()).not.toThrow();
	});
});

// Update mutations must carry `original` with the row's identifying fields —
// the server routes them to update_changeset (edit/tombstone semantics),
// while inserts on an existing PK are rejected outright.
describe('createGenericMutation update shape', () => {
	const { secretKey } = ml_dsa87.keygen();

	it('builds an update with original identity fields', () => {
		const m = api.createGenericMutation('dialog_message_reactions', {
			reaction_hash: 'dmr_' + 'cd'.repeat(64),
			dialog_hash: 'di_' + 'ab'.repeat(64),
			message_id: 'dmsg_1',
			message_sign_hash: 'dms_' + 'ef'.repeat(64),
			reactor_hash: 'u_' + 'ab'.repeat(64),
			type_b64: '',
			deleted_flag: true,
			owner_timestamp: 1785000001,
		}, secretKey, 'update');

		expect(m.type).toBe('update');
		expect(m.original).toMatchObject({
			reaction_hash: expect.stringMatching(/^dmr_/),
			dialog_hash: expect.stringMatching(/^di_/),
			message_id: 'dmsg_1',
		});
		expect(m.changes.deleted_flag).toBe(true);
		expect(m.changes.sign_b64).toBeTruthy();
	});

	it('builds a dialog_messages edit as update with parent_sign_hash', () => {
		const m = api.createGenericMutation('dialog_messages', {
			message_id: 'dmsg_2',
			dialog_hash: 'di_' + 'ab'.repeat(64),
			sender_hash: 'u_' + 'ab'.repeat(64),
			content_b64: 'bmV3',
			deleted_flag: false,
			refs_map_b64: 'cmVmcw',
			parent_sign_hash: 'dms_' + '12'.repeat(64),
			owner_timestamp: 1785000002,
		}, secretKey, 'update');

		expect(m.type).toBe('update');
		expect(m.original.message_id).toBe('dmsg_2');
		expect(m.changes.parent_sign_hash).toMatch(/^dms_/);
	});
});

// --- user_storage mutation: must match the server's Signable/Integrity impl ---
// Reference: chat/lib/chat/data/schemas/user_storage.ex (signable_fields drops
// sign_b64 + sign_hash) and chat/lib/chat/data/integrity.ex (sorted keys,
// per-suffix encoding). Getting this wrong yields "invalid_signature".
describe('createStorageMutation signing', () => {
	const { publicKey, secretKey } = ml_dsa87.keygen();
	const userHash = 'u_' + 'ab'.repeat(64);
	const uuid = '00000000-0000-4000-8000-000000000001';
	const valueB64 = 'aGVsbG8gd29ybGQ=';
	const ownerTimestamp = 1785000000;

	const serverEncodeField = (key: string, value: unknown): string => {
		if (value === null || value === undefined) return 'null';
		if (key.endsWith('_b64') || key.endsWith('_cert') || key.endsWith('_pkey')) return String(value);
		if (value === true) return 'true';
		if (value === false) return 'false';
		return String(value);
	};

	// Exactly the fields the server keeps, in its sort order.
	const serverPayload = (fields: Record<string, unknown>) =>
		Object.keys(fields)
			.sort()
			.map((k) => serverEncodeField(k, fields[k]))
			.join('');

	const build = () =>
		api.createStorageMutation(
			userHash, uuid, valueB64, null, 0, ownerTimestamp,
			secretKey, false, false, null, null, null, 'insert'
		);

	it('derives sign_hash as "uss_" + SHA3-512 of the raw signature', () => {
		const m = build();
		const signBytes = Uint8Array.from(atob(m.modified.sign_b64), (c) => c.charCodeAt(0));
		expect(m.modified.sign_hash).toBe('uss_' + bytesToHex(sha3_512(signBytes)));
		expect(m.modified.sign_hash).toMatch(/^uss_[0-9a-f]{128}$/);
	});

	it('signs exactly the field set the server verifies', () => {
		const m = build();
		const payload = serverPayload({
			deleted_flag: false,
			owner_timestamp: ownerTimestamp,
			parent_sign_hash: null,
			user_hash: userHash,
			uuid,
			value_b64: valueB64,
		});
		const signBytes = Uint8Array.from(atob(m.modified.sign_b64), (c) => c.charCodeAt(0));
		const ok = ml_dsa87.verify(signBytes, new TextEncoder().encode(payload), publicKey);
		expect(ok).toBe(true);
	});
});

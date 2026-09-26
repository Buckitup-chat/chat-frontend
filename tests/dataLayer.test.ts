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

	it('classifies "timestamp not newer" as a conflict candidate, not an opaque permanent failure', async () => {
		mockFetchSequence(422, {
			results: [
				{ index: 0, status: 'error', error: 'validation_failed', details: { owner_timestamp: ['timestamp not newer'] } },
			],
		});
		const err = await sendMutations([mutation], signSkey).catch((e) => e);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.uniqueConflictOnly).toBe(true);
	});

	it('treats status "exists" with conflicted:false as success, not a failure to classify', async () => {
		mockFetchSequence(200, {
			results: [{ index: 0, status: 'exists', conflicted: false }],
		});
		const res = await sendMutations([mutation], signSkey);
		expect(res.txids).toEqual([]);
	});

	it('classifies status "exists" with conflicted:true as a unique conflict, not success', async () => {
		mockFetchSequence(200, {
			results: [{ index: 0, status: 'exists', conflicted: true }],
		});
		const err = await sendMutations([mutation], signSkey).catch((e) => e);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.uniqueConflictOnly).toBe(true);
		expect(err.permanent).toBe(false);
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

	// /ingest_each resolves a PK conflict itself when a Shape module is
	// registered for the relation: HTTP 200, status "exists", and its own
	// fingerprint verdict. `conflicted: false` is our own earlier write
	// arriving again (lost response, retried send) and must read as success —
	// treating every non-"ok" row as failure retried this identical row
	// forever, since the retry always lands on the same conflict.
	it('treats a same-signature "exists" row as success, not a failure to retry', async () => {
		mockFetchSequence(200, {
			results: [{ index: 0, status: 'exists', conflicted: false }],
		});
		const res = await sendMutations([mutation], signSkey);
		expect(res.txids).toEqual([]);
	});

	// `conflicted: true` is a different revision under the same key. It is
	// not retried blindly: sendMutations flags it for the identity check, and
	// the retry wrapper either confirms our row landed after all or raises
	// the permanent conflict (both outcomes pinned by the wrapper's tests).
	it('routes a different-signature "exists" row to the identity check', async () => {
		mockFetchSequence(200, {
			results: [{ index: 0, status: 'exists', conflicted: true }],
		});
		const err = await sendMutations([mutation], signSkey).catch((e) => e);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.permanent).toBe(false);
		expect(err.uniqueConflictOnly).toBe(true);
		expect(err.conflictIndexes).toEqual([0]);
	});

	it('an idempotent "exists" row does not block other rows in the same batch from returning ok', async () => {
		mockFetchSequence(200, {
			results: [
				{ index: 0, status: 'ok', txid: 9 },
				{ index: 1, status: 'exists', conflicted: false },
			],
		});
		const res = await sendMutations([mutation, mutation], signSkey);
		expect(res.txids).toEqual([9]);
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

	// Mixed batch: the server accepted row 0 and rejected row 1 as a conflict.
	// Only row 1 needs an identity check — making row 0 depend on shape
	// propagation could fail a batch the server already partly applied.
	it('confirms only the conflicting rows in a mixed batch', async () => {
		const m0 = { type: 'insert', modified: { message_id: 'a' }, syncMetadata: { relation: 'dialog_messages' } };
		const m1 = { type: 'insert', modified: { message_id: 'b' }, syncMetadata: { relation: 'dialog_messages' } };
		mockFetchSequence(422, {
			results: [
				{ index: 0, status: 'ok', txid: 99 },
				{ index: 1, status: 'error', error: 'validation_failed', details: { message_id: ['has already been taken'] } },
			],
		});
		const confirmApplied = vi.fn(async () => true);
		const res = await sendMutationsWithRetry([m0, m1], signSkey, { retries: 1, baseDelayMs: 1, confirmApplied });

		expect(confirmApplied).toHaveBeenCalledTimes(1);
		expect(confirmApplied).toHaveBeenCalledWith(m1);
		expect(res.txids).toEqual([99]);
	});

	it('resolves status "exists" with conflicted:false without calling confirmApplied', async () => {
		mockFetchSequence(200, {
			results: [{ index: 0, status: 'exists', conflicted: false }],
		});
		const confirmApplied = vi.fn(async () => true);
		const res = await sendMutationsWithRetry([mutation], signSkey, { retries: 2, baseDelayMs: 1, confirmApplied });
		expect(confirmApplied).not.toHaveBeenCalled();
		expect(res.results[0].status).toBe('exists');
	});

	it('resolves status "exists" with conflicted:true as success when identity is confirmed', async () => {
		mockFetchSequence(200, {
			results: [{ index: 0, status: 'exists', conflicted: true }],
		});
		const confirmApplied = vi.fn(async () => true);
		const res = await sendMutationsWithRetry([mutation], signSkey, { retries: 2, baseDelayMs: 1, confirmApplied });
		expect(confirmApplied).toHaveBeenCalledTimes(1);
		expect(res.results.length).toBe(1);
	});

	it('resolves "timestamp not newer" as success when identity is confirmed', async () => {
		mockFetchSequence(422, {
			results: [
				{ index: 0, status: 'error', error: 'validation_failed', details: { owner_timestamp: ['timestamp not newer'] } },
			],
		});
		const confirmApplied = vi.fn(async () => true);
		const res = await sendMutationsWithRetry([mutation], signSkey, { retries: 2, baseDelayMs: 1, confirmApplied });
		expect(confirmApplied).toHaveBeenCalledTimes(1);
		expect(res.results.length).toBe(1);
	});

	it('turns "timestamp not newer" into a permanent error when the server row differs', async () => {
		mockFetchSequence(422, {
			results: [
				{ index: 0, status: 'error', error: 'validation_failed', details: { owner_timestamp: ['timestamp not newer'] } },
			],
		});
		const confirmApplied = vi.fn(async () => false);
		const err = await sendMutationsWithRetry([mutation], signSkey, { retries: 2, baseDelayMs: 1, confirmApplied }).catch((e) => e);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.permanent).toBe(true);
		expect(err.uniqueConflictOnly).toBe(true);
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

	// The registry must not grow without bound across a session (finding 8):
	// keep a warm LRU set, evict the least recently used beyond it.
	it('evicts least-recently-used dialogs beyond the warm set', () => {
		const hash = (i: number) => 'di_' + i.toString(16).padStart(2, '0').repeat(64);
		const first = getDialogCollections(hash(1));
		for (let i = 2; i <= 12; i++) getDialogCollections(hash(i));

		// the oldest bundle was evicted: asking again builds a new one
		expect(getDialogCollections(hash(1))).not.toBe(first);
		// a recently used one is still warm
		const recent = getDialogCollections(hash(12));
		expect(getDialogCollections(hash(12))).toBe(recent);
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
interface UpdateMutationResult {
	type: string;
	original: Record<string, unknown>;
	changes: Record<string, unknown>;
}
const createGenericMutation = api.createGenericMutation as unknown as (...args: unknown[]) => UpdateMutationResult;

interface InsertStorageMutationResult {
	type: string;
	modified: Record<string, unknown> & { sign_b64: string; sign_hash: string };
}
const createStorageMutation = api.createStorageMutation as unknown as (...args: unknown[]) => InsertStorageMutationResult;

describe('createGenericMutation update shape', () => {
	const { secretKey } = ml_dsa87.keygen();

	it('builds an update with original identity fields', () => {
		const m = createGenericMutation('dialog_message_reactions', {
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
		const m = createGenericMutation('dialog_messages', {
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

	// Exactly the fields the server keeps, in its sort order, each
	// u32be(byte length) || UTF-8 value.
	const serverPayload = (fields: Record<string, unknown>): Uint8Array =>
		Uint8Array.from(
			Object.keys(fields)
				.sort()
				.flatMap((k) => {
					const bytes = Array.from(new TextEncoder().encode(serverEncodeField(k, fields[k])));
					const n = bytes.length;
					return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...bytes];
				}),
		);

	const build = () =>
		createStorageMutation(
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
		const ok = ml_dsa87.verify(signBytes, payload, publicKey);
		expect(ok).toBe(true);
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import type { DialogRecordFields, DialogTable } from '@/utils/db/tanstack/dialogQueue';
import type { ApiMutation } from '@/api/client';
import { modifiedOf, changesOf, clearDialogDatabases, readAllFromIndexedDB } from '../testHelpers';

type RecordWithExtras = DialogRecordFields & Record<string, unknown>;

interface MockIngestResult {
	index?: unknown;
	status?: string;
	error?: string;
}

let mockResultsFn: ((mutations: ApiMutation[]) => MockIngestResult[] | Promise<MockIngestResult[]>) | null = null;

vi.mock('@/api/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/api/client')>();
	return {
		api: {
			...actual.api,
			ingestWithAuthEach: vi.fn(async (mutations: ApiMutation[]) => ({
				json: async () => ({ results: mockResultsFn ? await mockResultsFn(mutations) : [] }),
			})),
		},
	};
});

beforeEach(async () => {
	await clearDialogDatabases();
	vi.clearAllMocks();
});

async function freshQueue() {
	vi.resetModules();
	mockResultsFn = null;
	const q = await import('@/utils/db/tanstack/dialogQueue');
	await q.ensureRehydrated();
	return q;
}

const signSkey = ml_dsa87.keygen(new Uint8Array(32).fill(11)).secretKey;

const dialogKeysRecord: DialogRecordFields = {
	dialog_hash: 'di_' + 'a'.repeat(128),
	sender_hash: 'u_a',
	peer_hash: 'u_b',
	peer_kem_wrap_key_b64: 'k1',
	peer_wrapped_msg_key_b64: 'w1',
	owner_timestamp: 100,
	deleted_flag: false,
};

describe('putPendingDialog — creates a pending entry with the correct shape', () => {
	it('creates one pending entry: table, key, ownerUserHash, record, patch, revision 1, status pending, timestamps set', async () => {
		const q = await freshQueue();
		const before = Date.now();

		const entry = await q.putPendingDialog('dialog_keys', dialogKeysRecord, 'u_a');

		expect(entry.table).toBe('dialog_keys');
		expect(entry.key).toBe(`${dialogKeysRecord.dialog_hash}:u_a`);
		expect(entry.ownerUserHash).toBe('u_a');
		expect(entry.record).toMatchObject(dialogKeysRecord);
		expect(entry.patch).toMatchObject(dialogKeysRecord);
		expect(entry.revision).toBe(1);
		expect(entry.status).toBe('pending');
		expect(entry.createdAt).toBeGreaterThanOrEqual(before);
		expect(entry.updatedAt).toBeGreaterThanOrEqual(before);
		expect(entry.sentAt).toBeNull();
		expect(entry.sentSnapshot).toBeNull();
		expect(entry.lastError).toBeNull();
	});

	it('the record appears in the matching pending TanStack collection, keyed the same way', async () => {
		const q = await freshQueue();
		await q.putPendingDialog('dialog_keys', dialogKeysRecord, 'u_a');

		const fromCollection = q.pendingDialogKeysCollection.get(`${dialogKeysRecord.dialog_hash}:u_a`);
		expect(fromCollection).toMatchObject(dialogKeysRecord);
	});

	it('throws if ownerUserHash is missing', async () => {
		const q = await freshQueue();
		await expect(q.putPendingDialog('dialog_keys', dialogKeysRecord, '')).rejects.toThrow();
	});
});

describe('putPendingDialog — repeated upsert of the same record merges into one entry', () => {
	it('increments revision, merges record/patch, and does not create a second independent entry', async () => {
		const q = await freshQueue();
		const record = { ...dialogKeysRecord, dialog_hash: 'di_' + 'r'.repeat(128) };
		const key = `${record.dialog_hash}:u_a`;

		const first = await q.putPendingDialog('dialog_keys', record, 'u_a');
		expect(first.revision).toBe(1);

		const second = await q.putPendingDialog('dialog_keys', { ...record, owner_timestamp: 200 }, 'u_a');
		expect(second.revision).toBe(2);
		expect(second.id).toBe(first.id);
		expect(second.record).toMatchObject({ ...record, owner_timestamp: 200 });
		expect(q.pendingDialogKeysCollection.get(key)).toMatchObject({ owner_timestamp: 200 });
	});
});

describe('durable persistence — survives a simulated reload', () => {
	it('a pending entry written before "reload" is restored (record + overlay) by ensureRehydrated after a fresh module import', async () => {
		const q1 = await freshQueue();
		await q1.putPendingDialog('dialog_keys', dialogKeysRecord, 'u_a');

		const q2 = await freshQueue();
		const key = `${dialogKeysRecord.dialog_hash}:u_a`;
		expect(q2.pendingDialogKeysCollection.get(key)).toMatchObject(dialogKeysRecord);
		expect(q2.queueStatus.value.pending).toBeGreaterThanOrEqual(1);
	});
});

describe('ensureRehydrated — status counts and idempotency', () => {
	it('counts pending entries correctly and is memoized (same promise, no double work)', async () => {
		const q = await freshQueue();
		await q.putPendingDialog('dialog_keys', dialogKeysRecord, 'u_a');
		await q.putPendingDialog('dialog_keys', { ...dialogKeysRecord, dialog_hash: 'di_' + 'b'.repeat(128) }, 'u_a');

		const q2 = await freshQueue();
		const base = q2.queueStatus.value.pending;
		const p1 = q2.ensureRehydrated();
		const p2 = q2.ensureRehydrated();
		expect(p1).toBe(p2);
		await p1;
		expect(base).toBeGreaterThanOrEqual(2);
	});
});

describe('markSynced — normal success path', () => {
	it('hands the local snapshot to the synced recorder, removes the entry from durable storage and the pending overlay, updates counters', async () => {
		const q = await freshQueue();
		const recorded: Array<{ table: DialogTable; key: string; record: DialogRecordFields }> = [];
		q.setSyncedRecorder((table, key, record) => {
			recorded.push({ table, key, record });
		});

		const entry = await q.putPendingDialog('dialog_keys', dialogKeysRecord, 'u_a');
		const baseline = { ...q.queueStatus.value };

		await q.markSynced(entry);

		expect(recorded).toHaveLength(1);
		expect(recorded[0].table).toBe('dialog_keys');
		expect(recorded[0].record).toMatchObject(dialogKeysRecord);

		expect(q.pendingDialogKeysCollection.get(entry.key)).toBeUndefined();
		expect(q.queueStatus.value.pending).toBe(baseline.pending - 1);

		q.setSyncedRecorder(null);
	});
});

describe('flushPendingDialogChanges — normal successful flush', () => {
	it('builds a valid mutation, calls ingestWithAuthEach, marks the entry synced on "ok", and resets backoff', async () => {
		const q = await freshQueue();
		const { api } = await import('@/api/client');
		q.setSyncedRecorder(() => {});

		await q.putPendingDialog('dialog_keys', dialogKeysRecord, 'u_a');

		mockResultsFn = (mutations) => {
			expect(mutations.length).toBeGreaterThan(0);
			expect(mutations[0].syncMetadata.relation).toBe('dialog_keys');
			return mutations.map((_, i) => ({ index: i, status: 'ok' }));
		};

		const result = await q.flushPendingDialogChanges(signSkey, 'u_a');

		expect(vi.mocked(api.ingestWithAuthEach)).toHaveBeenCalledTimes(1);
		expect(result).toBeUndefined();
		expect(q.pendingDialogKeysCollection.get(`${dialogKeysRecord.dialog_hash}:u_a`)).toBeUndefined();

		q.setSyncedRecorder(null);
	});

	it('does nothing when there are no pending entries', async () => {
		const q = await freshQueue();
		const { api } = await import('@/api/client');
		const ingestMock = vi.mocked(api.ingestWithAuthEach);

		expect(q.queueStatus.value.pending).toBe(0);
		await q.flushPendingDialogChanges(signSkey, 'u_a');
		expect(ingestMock).not.toHaveBeenCalled();
	});

	it('does nothing while offline', async () => {
		const q = await freshQueue();
		vi.stubGlobal('navigator', { onLine: false });
		const { api } = await import('@/api/client');
		const ingestMock = vi.mocked(api.ingestWithAuthEach);
		const before = ingestMock.mock.calls.length;

		await q.putPendingDialog('dialog_keys', dialogKeysRecord, 'u_a');
		await q.flushPendingDialogChanges(signSkey, 'u_a');

		expect(ingestMock.mock.calls.length).toBe(before);
		expect(q.pendingDialogKeysCollection.get(`${dialogKeysRecord.dialog_hash}:u_a`)).toBeTruthy();

		vi.unstubAllGlobals();
	});
});

describe('flushPendingDialogChanges — temporary network/server failure', () => {
	it('a transient per-row failure keeps the mutation pending and returns a retry delay; a later successful flush completes it', async () => {
		const q = await freshQueue();
		q.setSyncedRecorder(() => {});

		const targetDialogHash = 'di_' + 'c'.repeat(128);
		await q.putPendingDialog('dialog_keys', { ...dialogKeysRecord, dialog_hash: targetDialogHash }, 'u_a');
		const key = `${targetDialogHash}:u_a`;

		mockResultsFn = (mutations) => {
			const idx = mutations.findIndex((m) => modifiedOf(m).dialog_hash === targetDialogHash);
			return [{ index: idx, status: 'error', error: 'server_error' }];
		};
		const failResult = await q.flushPendingDialogChanges(signSkey, 'u_a');
		expect(failResult?.retryAfterMs).toBeGreaterThan(0);
		expect(q.pendingDialogKeysCollection.get(key)).toBeTruthy();

		mockResultsFn = (mutations) => {
			const idx = mutations.findIndex((m) => modifiedOf(m).dialog_hash === targetDialogHash);
			return [{ index: idx, status: 'ok' }];
		};
		const okResult = await q.flushPendingDialogChanges(signSkey, 'u_a');
		expect(okResult).toBeUndefined();
		expect(q.pendingDialogKeysCollection.get(key)).toBeUndefined();

		q.setSyncedRecorder(null);
	});
});

describe('flushPendingDialogChanges — owner isolation', () => {
	it('a flush for owner A never includes owner B\'s pending entry in the ingest batch, and B stays pending after A\'s successful flush', async () => {
		const q = await freshQueue();
		q.setSyncedRecorder(() => {});

		const dialogHashA = 'di_' + 'd'.repeat(128);
		const dialogHashB = 'di_' + 'e'.repeat(128);
		await q.putPendingDialog('dialog_keys', { ...dialogKeysRecord, dialog_hash: dialogHashA }, 'u_a');
		await q.putPendingDialog('dialog_keys', { ...dialogKeysRecord, dialog_hash: dialogHashB, sender_hash: 'u_b' }, 'u_b');

		mockResultsFn = (mutations) => {
			expect(mutations).toHaveLength(1);
			expect(modifiedOf(mutations[0]).dialog_hash).toBe(dialogHashA);
			return mutations.map((_, i) => ({ index: i, status: 'ok' }));
		};

		await q.flushPendingDialogChanges(signSkey, 'u_a');

		expect(q.pendingDialogKeysCollection.get(`${dialogHashA}:u_a`)).toBeUndefined();
		expect(q.pendingDialogKeysCollection.get(`${dialogHashB}:u_b`)).toBeTruthy();

		q.setSyncedRecorder(null);
	});

	it('switching to another owner does not touch a pending entry; returning to the original owner sends it via a single ingest call', async () => {
		const q = await freshQueue();
		const { api } = await import('@/api/client');
		const ingestMock = vi.mocked(api.ingestWithAuthEach);
		q.setSyncedRecorder(() => {});

		const dialogHashA = 'di_' + 'g'.repeat(128);
		await q.putPendingDialog('dialog_keys', { ...dialogKeysRecord, dialog_hash: dialogHashA }, 'u_a');
		const keyA = `${dialogHashA}:u_a`;

		await q.flushPendingDialogChanges(signSkey, 'u_b');
		expect(ingestMock).not.toHaveBeenCalled();
		expect(q.pendingDialogKeysCollection.get(keyA)).toBeTruthy();

		mockResultsFn = (mutations) => mutations.map((_, i) => ({ index: i, status: 'ok' }));
		await q.flushPendingDialogChanges(signSkey, 'u_a');
		expect(ingestMock).toHaveBeenCalledTimes(1);
		expect(ingestMock.mock.calls[0][0]).toHaveLength(1);
		expect(q.pendingDialogKeysCollection.get(keyA)).toBeUndefined();

		q.setSyncedRecorder(null);
	});
});

describe('flushPendingDialogChanges — edited message sourced from an Electric BigInt row does not get stuck pending (BUG 1 regression)', () => {
	it('builds a JSON-safe update mutation for a dialog_messages edit whose owner_timestamp is a real BigInt, and completes the flush on "ok"', async () => {
		const q = await freshQueue();
		q.setSyncedRecorder(() => {});

		const messageId = 'dmsg_bigint_flush';
		const bigintTimestamp = 1700000000n;
		const previousSignHash = 'dms_' + 'p'.repeat(128);

		// Mirrors what editMessage() queues when the original message was hydrated from Electric,
		// whose numeric columns (owner_timestamp) can arrive as native bigint.
		await q.putPendingDialog(
			'dialog_messages',
			{
				message_id: messageId,
				dialog_hash: 'di_' + 'a'.repeat(128),
				sender_hash: 'u_a',
				content_b64: 'cipher-edited',
				deleted_flag: false,
				refs_map_b64: 'refs',
				parent_sign_hash: previousSignHash,
				owner_timestamp: bigintTimestamp,
				sign_b64: null,
				sign_hash: null,
			},
			'u_a'
		);

		let capturedMutation: ApiMutation | undefined;
		mockResultsFn = (mutations) => {
			expect(() => JSON.stringify(mutations)).not.toThrow();
			const idx = mutations.findIndex((m) => m.type === 'update' && changesOf(m).message_id === messageId);
			capturedMutation = mutations[idx];
			return [{ index: idx, status: 'ok' }];
		};

		await q.flushPendingDialogChanges(signSkey, 'u_a');

		expect(capturedMutation).toBeTruthy();
		expect(capturedMutation!.type).toBe('update');
		const changes = changesOf(capturedMutation!);
		expect(changes.message_id).toBe(messageId);
		expect(changes.parent_sign_hash).toBe(previousSignHash);
		expect(typeof changes.owner_timestamp).toBe('number');
		expect(changes.owner_timestamp).toBe(1700000000);

		// The symptom this guards against: before the fix, JSON.stringify inside ingestWithAuthEach
		// threw on the BigInt, so the mutation was never sent and the entry stayed pending forever.
		expect(q.pendingDialogMessagesCollection.get(messageId)).toBeUndefined();

		q.setSyncedRecorder(null);
	});
});

describe('flushPendingDialogChanges — backend "timestamp not newer" 422 contract, and re-editing a quarantined message (Test J / PART 8)', () => {
	it('an edit whose owner_timestamp is not strictly greater than the previous version is quarantined by a mock backend contract; re-editing the same message with a monotonic timestamp moves it back to pending and completes the flush', async () => {
		const q = await freshQueue();
		q.setSyncedRecorder(() => {});

		const messageId = 'dmsg_422_regression';
		const dialogHash = 'di_' + 'a'.repeat(128);
		const previousTimestamp = 500;

		// Mirrors the real backend contract that produced the manual 422:
		// {"owner_timestamp":["timestamp not newer"]} whenever an update's owner_timestamp <= the previous version's.
		const mockBackendValidate = (mutations: ApiMutation[]) =>
			mutations.map((m, i) => {
				if (m.type !== 'update') return { index: i, status: 'ok' };
				const newTs = Number(changesOf(m).owner_timestamp);
				if (newTs <= previousTimestamp) {
					return { index: i, status: 'error', error: 'validation_failed', details: { owner_timestamp: ['timestamp not newer'] } };
				}
				return { index: i, status: 'ok' };
			});

		// Old (buggy) behavior: owner_timestamp unchanged from the previous version -> backend rejects it.
		await q.putPendingDialog(
			'dialog_messages',
			{
				message_id: messageId,
				dialog_hash: dialogHash,
				sender_hash: 'u_a',
				content_b64: 'cipher-edit-unchanged-ts',
				deleted_flag: false,
				parent_sign_hash: 'dms_' + 'p'.repeat(128),
				owner_timestamp: previousTimestamp, // same as previous version -> "not newer"
				sign_b64: null,
				sign_hash: null,
			},
			'u_a'
		);

		mockResultsFn = mockBackendValidate;
		await q.flushPendingDialogChanges(signSkey, 'u_a');

		// validation_failed -> quarantined, not left silently stuck pending.
		expect(q.pendingDialogMessagesCollection.get(messageId)).toBeUndefined();
		expect(q.queueStatus.value.quarantined).toBe(1);
		expect(q.queueStatus.value.pending).toBe(0);

		// PART 8: the user edits the SAME (quarantined) message again, this time with a monotonic timestamp.
		const correctedEntry = await q.putPendingDialog(
			'dialog_messages',
			{
				message_id: messageId,
				dialog_hash: dialogHash,
				sender_hash: 'u_a',
				content_b64: 'cipher-edit-corrected',
				deleted_flag: false,
				parent_sign_hash: 'dms_' + 'p'.repeat(128),
				owner_timestamp: previousTimestamp + 1, // strictly greater -> passes
				sign_b64: null,
				sign_hash: null,
			},
			'u_a'
		);

		// Same queue key moves back to pending with a new revision — not a second, parallel entry.
		expect(correctedEntry.id).toBe(`dialog_messages:${messageId}`);
		expect(correctedEntry.status).toBe('pending');
		expect(correctedEntry.revision).toBeGreaterThan(1);
		expect(q.pendingDialogMessagesCollection.get(messageId)).toBeTruthy();
		expect(q.queueStatus.value.quarantined).toBe(0);
		expect(q.queueStatus.value.pending).toBe(1);

		mockResultsFn = mockBackendValidate;
		await q.flushPendingDialogChanges(signSkey, 'u_a');

		expect(q.pendingDialogMessagesCollection.get(messageId)).toBeUndefined();
		expect(q.queueStatus.value.pending).toBe(0);
		expect(q.queueStatus.value.quarantined).toBe(0);

		q.setSyncedRecorder(null);
	});
});

describe('flushPendingDialogChanges / markSynced — an edit landing while its predecessor is HTTP in-flight is rebased onto the confirmed version after ACK (PART 6, Test G/H)', () => {
	it('the coalesced edit survives its predecessor\'s ACK (revision guard) and is rebased onto the just-confirmed parent_sign_hash/owner_timestamp so the next flush is backend-valid', async () => {
		const q = await freshQueue();
		q.setSyncedRecorder(() => {});

		const messageId = 'dmsg_inflight_rebase';
		const dialogHash = 'di_' + 'a'.repeat(128);
		const originalSignHash = 'dms_' + 'o'.repeat(128);

		// Edit B is queued (revision 1) and about to be flushed.
		await q.putPendingDialog(
			'dialog_messages',
			{
				message_id: messageId,
				dialog_hash: dialogHash,
				sender_hash: 'u_a',
				content_b64: 'cipher-edit-B',
				deleted_flag: false,
				parent_sign_hash: originalSignHash,
				owner_timestamp: 101,
				sign_b64: null,
				sign_hash: null,
			},
			'u_a'
		);

		let confirmedBSignHash: string | undefined;
		mockResultsFn = async (mutations) => {
			// Simulate: while B's request is in flight (server hasn't responded yet), the user
			// edits again (edit C). A real second editMessage() call would go through this exact
			// same atomic putPendingDialog path and coalesce onto B's still-live pending entry.
			const bIndex = mutations.findIndex((m) => m.type === 'update' && changesOf(m).message_id === messageId);
			confirmedBSignHash = changesOf(mutations[bIndex]).sign_hash as string;

			await q.putPendingDialog(
				'dialog_messages',
				{
					message_id: messageId,
					dialog_hash: dialogHash,
					sender_hash: 'u_a',
					content_b64: 'cipher-edit-C',
					deleted_flag: false,
					parent_sign_hash: originalSignHash,
					owner_timestamp: 101,
					sign_b64: null,
					sign_hash: null,
				},
				'u_a'
			);

			return [{ index: bIndex, status: 'ok' }];
		};

		await q.flushPendingDialogChanges(signSkey, 'u_a');
		expect(confirmedBSignHash).toBeTruthy();

		// Existing revision guard: B's ACK must not delete/discard the newer pending edit C.
		const survivingEntry = q.pendingDialogMessagesCollection.get(messageId);
		expect(survivingEntry).toBeTruthy();
		expect(q.queueStatus.value.pending).toBe(1);

		const raw = await readAllFromIndexedDB('dialog-pending-queue', 'pending');
		const rawEntry = (raw as Array<{ key: string; revision: number; record: DialogRecordFields }>).find((e) => e.key === messageId);
		expect(rawEntry?.revision).toBe(2); // rebase does not bump revision — still C's revision
		expect(rawEntry?.record.content_b64).toBe('cipher-edit-C');

		// Rebase: C's parent_sign_hash now points at B's CONFIRMED sign_hash, not the stale original.
		expect(survivingEntry!.parent_sign_hash).toBe(confirmedBSignHash);
		expect(survivingEntry!.parent_sign_hash).not.toBe(originalSignHash);
		expect(Number(survivingEntry!.owner_timestamp)).toBeGreaterThan(101);
		expect(q.resolvePendingDialogRecord('dialog_messages', survivingEntry!, null).mutationType).toBe('update');

		// PART 8-H: the next flush sends the rebased C correctly, and it completes normally.
		mockResultsFn = (mutations) => mutations.map((_, i) => ({ index: i, status: 'ok' }));
		await q.flushPendingDialogChanges(signSkey, 'u_a');
		expect(q.pendingDialogMessagesCollection.get(messageId)).toBeUndefined();
		expect(q.queueStatus.value.pending).toBe(0);

		q.setSyncedRecorder(null);
	});
});

describe('quarantine — a permanently rejected dialog_messages EDIT does not pollute the synced cache with unconfirmed content (PART 7, Test I/J)', () => {
	it('a 422-rejected edit is never handed to the synced recorder — display stays on the last real confirmed content, not the rejected one', async () => {
		const q = await freshQueue();
		const recordedCalls: Array<{ table: string; key: string; record: DialogRecordFields; awaitingEcho?: boolean }> = [];
		q.setSyncedRecorder((table, key, record, awaitingEcho) => {
			recordedCalls.push({ table, key, record, awaitingEcho });
		});

		const messageId = 'dmsg_422_no_cache_pollution';
		await q.putPendingDialog(
			'dialog_messages',
			{
				message_id: messageId,
				dialog_hash: 'di_' + 'a'.repeat(128),
				sender_hash: 'u_a',
				content_b64: 'cipher-rejected-edit',
				deleted_flag: false,
				parent_sign_hash: 'dms_' + 'p'.repeat(128),
				owner_timestamp: 100, // deliberately stale -> "timestamp not newer"
				sign_b64: null,
				sign_hash: null,
			},
			'u_a'
		);

		mockResultsFn = (mutations) =>
			mutations.map((_, i) => ({ index: i, status: 'error', error: 'validation_failed', details: { owner_timestamp: ['timestamp not newer'] } }));

		await q.flushPendingDialogChanges(signSkey, 'u_a');

		// The rejected content must never reach the synced recorder — that would make it show
		// up as "confirmed" (via __awaitingEcho, which would never actually clear, since no
		// echo is ever coming for content the server rejected).
		expect(recordedCalls).toHaveLength(0);
		// Removed from the pending overlay — display naturally falls back to the last real
		// confirmed cache/network row instead of showing the rejected content as synced.
		expect(q.pendingDialogMessagesCollection.get(messageId)).toBeUndefined();
		expect(q.queueStatus.value.quarantined).toBe(1);

		q.setSyncedRecorder(null);
	});

	it('a rejected dialog_messages INSERT (no parent_sign_hash) and other tables keep the previous behavior — the synced recorder is still called', async () => {
		const q = await freshQueue();
		const recordedCalls: Array<{ table: string; key: string }> = [];
		q.setSyncedRecorder((table, key) => {
			recordedCalls.push({ table, key });
		});

		// A rejected brand-new message (insert, no parent_sign_hash) — not the edit-specific case.
		await q.putPendingDialog(
			'dialog_messages',
			{
				message_id: 'dmsg_rejected_insert',
				dialog_hash: 'di_' + 'a'.repeat(128),
				sender_hash: 'u_a',
				content_b64: 'cipher-new-message',
				deleted_flag: false,
				parent_sign_hash: null,
				owner_timestamp: 100,
				sign_b64: null,
				sign_hash: null,
			},
			'u_a'
		);
		// dialog_keys with required wrapped-key fields missing -> fails local validation, quarantined
		// directly (never reaches the mock backend) — exercises quarantine()'s other call site.
		await q.putPendingDialog('dialog_keys', { dialog_hash: 'di_' + 'z'.repeat(128), sender_hash: 'u_a', owner_timestamp: 100 }, 'u_a');

		mockResultsFn = (mutations) => mutations.map((_, i) => ({ index: i, status: 'error', error: 'validation_failed', details: {} }));
		await q.flushPendingDialogChanges(signSkey, 'u_a');

		expect(recordedCalls.some((c) => c.table === 'dialog_messages' && c.key === 'dmsg_rejected_insert')).toBe(true);
		expect(recordedCalls.some((c) => c.table === 'dialog_keys')).toBe(true);

		q.setSyncedRecorder(null);
	});
});

describe('resolvePendingDialogRecord — mutationType', () => {
	it('dialog_messages keys off parent_sign_hash (editing keeps deleted_flag false); other tables keep the deleted_flag rule', async () => {
		const q = await freshQueue();
		expect(q.resolvePendingDialogRecord('dialog_messages', { message_id: 'm', parent_sign_hash: null }, null).mutationType).toBe('insert');
		expect(q.resolvePendingDialogRecord('dialog_messages', { message_id: 'm', parent_sign_hash: 'dms_x' }, null).mutationType).toBe('update');
		expect(q.resolvePendingDialogRecord('dialog_message_reactions', { deleted_flag: true }, null).mutationType).toBe('update');
	});
});

describe('validateDialogRecord — per-table normal validators', () => {
	it('dialog_keys requires both wrapped-key fields', async () => {
		const q = await freshQueue();
		expect(q.validateDialogRecord('dialog_keys', dialogKeysRecord).ok).toBe(true);
		expect(q.validateDialogRecord('dialog_keys', { ...dialogKeysRecord, peer_kem_wrap_key_b64: null }).ok).toBe(false);
		expect(q.validateDialogRecord('dialog_keys', { ...dialogKeysRecord, peer_wrapped_msg_key_b64: null }).ok).toBe(false);
	});

	it('dialog_messages requires content_b64 unless deleted_flag is set', async () => {
		const q = await freshQueue();
		expect(q.validateDialogRecord('dialog_messages', { message_id: 'dmsg_1', content_b64: 'c', deleted_flag: false }).ok).toBe(true);
		expect(q.validateDialogRecord('dialog_messages', { message_id: 'dmsg_1', content_b64: null, deleted_flag: false }).ok).toBe(false);
		expect(q.validateDialogRecord('dialog_messages', { message_id: 'dmsg_1', content_b64: null, deleted_flag: true }).ok).toBe(true);
	});

	it('reactions and receipts require message_sign_hash', async () => {
		const q = await freshQueue();
		expect(q.validateDialogRecord('dialog_message_reactions', { message_sign_hash: 'dms_x' }).ok).toBe(true);
		expect(q.validateDialogRecord('dialog_message_reactions', { message_sign_hash: '' }).ok).toBe(false);
		expect(q.validateDialogRecord('dialog_message_receipts', { message_sign_hash: 'dms_x' }).ok).toBe(true);
		expect(q.validateDialogRecord('dialog_message_receipts', {}).ok).toBe(false);
	});
});

describe('toProtocolRecord — per-table allowlist', () => {
	it('dialog_keys: only protocol fields survive, local metadata is dropped', async () => {
		const q = await freshQueue();
		const contaminated: RecordWithExtras = { ...dialogKeysRecord, __awaitingEcho: true, ownerUserHash: 'u_a' };
		const clean = q.toProtocolRecord('dialog_keys', contaminated);
		expect(clean).toMatchObject({ dialog_hash: dialogKeysRecord.dialog_hash, sender_hash: 'u_a', peer_hash: 'u_b' });
		expect('__awaitingEcho' in clean).toBe(false);
		expect('ownerUserHash' in clean).toBe(false);
	});

	it('dialog_messages: content_b64/sign_hash survive, unrelated injected fields do not', async () => {
		const q = await freshQueue();
		const contaminated: RecordWithExtras = { message_id: 'dmsg_1', content_b64: 'c', __ignoreEchoSignHash: 'x' };
		const clean = q.toProtocolRecord('dialog_messages', contaminated);
		expect(clean).toMatchObject({ message_id: 'dmsg_1', content_b64: 'c' });
		expect('__ignoreEchoSignHash' in clean).toBe(false);
	});

	it('dialog_message_reactions/receipts: only their own declared fields pass through', async () => {
		const q = await freshQueue();
		const contaminatedReaction: RecordWithExtras = { reaction_hash: 'dmr_1', type_b64: 't', bogus: 'x' };
		const reactionClean = q.toProtocolRecord('dialog_message_reactions', contaminatedReaction);
		expect(reactionClean).toMatchObject({ reaction_hash: 'dmr_1', type_b64: 't' });
		expect('bogus' in reactionClean).toBe(false);

		const contaminatedReceipt: RecordWithExtras = { receipt_hash: 'dmrc_1', type: 'read', bogus: 'x' };
		const receiptClean = q.toProtocolRecord('dialog_message_receipts', contaminatedReceipt);
		expect(receiptClean).toMatchObject({ receipt_hash: 'dmrc_1', type: 'read' });
		expect('bogus' in receiptClean).toBe(false);
	});
});

describe('toProtocolRecord / buildDialogMutation — BigInt owner_timestamp from Electric rows (BUG 1 regression)', () => {
	it('normalizes a real BigInt owner_timestamp to a JSON-safe number before signing, preserving the numeric value and update semantics', async () => {
		const q = await freshQueue();
		const bigintTimestamp = 1700000000n;
		const editedMessageRecord: RecordWithExtras = {
			message_id: 'dmsg_bigint_edit',
			dialog_hash: 'di_' + 'a'.repeat(128),
			sender_hash: 'u_a',
			content_b64: 'cipher-edited',
			deleted_flag: false,
			refs_map_b64: 'refs',
			parent_sign_hash: 'dms_' + 'p'.repeat(128),
			owner_timestamp: bigintTimestamp,
			sign_b64: null,
			sign_hash: null,
		};

		const protocolRecord = q.toProtocolRecord('dialog_messages', editedMessageRecord);
		expect(typeof protocolRecord.owner_timestamp).toBe('number');
		expect(protocolRecord.owner_timestamp).toBe(Number(bigintTimestamp));

		const { mutation } = q.buildDialogMutation('dialog_messages', editedMessageRecord, 'update', signSkey);
		const changes = changesOf(mutation);

		expect(mutation.type).toBe('update');
		expect(changes.message_id).toBe('dmsg_bigint_edit');
		expect(changes.parent_sign_hash).toBe(editedMessageRecord.parent_sign_hash);
		expect(typeof changes.owner_timestamp).toBe('number');
		expect(changes.owner_timestamp).toBe(1700000000);

		expect(() => JSON.stringify(mutation)).not.toThrow();
		expect(() => JSON.stringify({ auth: { challenge_id: 'x', signature: 'y' }, mutations: [mutation] })).not.toThrow();
	});

	it('throws a clear error instead of silently truncating when the BigInt is outside the JSON-safe integer range', async () => {
		const q = await freshQueue();
		const unsafeTimestamp = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
		expect(() => q.toProtocolRecord('dialog_messages', { message_id: 'dmsg_x', owner_timestamp: unsafeTimestamp })).toThrow(/JSON-safe integer range/);
	});
});

describe('keyFor behavior — exercised through putPendingDialog, per table', () => {
	it('dialog_keys: dialog_hash:sender_hash', async () => {
		const q = await freshQueue();
		const entry = await q.putPendingDialog('dialog_keys', dialogKeysRecord, 'u_a');
		expect(entry.key).toBe(`${dialogKeysRecord.dialog_hash}:u_a`);
	});

	it('dialog_messages: message_id', async () => {
		const q = await freshQueue();
		const entry = await q.putPendingDialog('dialog_messages', { message_id: 'dmsg_x', content_b64: 'c' }, 'u_a');
		expect(entry.key).toBe('dmsg_x');
	});

	it('dialog_messages_versions: message_id:sign_hash', async () => {
		const q = await freshQueue();
		const entry = await q.putPendingDialog('dialog_messages_versions', { message_id: 'dmsg_x', sign_hash: 'dms_y' }, 'u_a');
		expect(entry.key).toBe('dmsg_x:dms_y');
	});

	it('dialog_message_reactions: reaction_hash', async () => {
		const q = await freshQueue();
		const entry = await q.putPendingDialog('dialog_message_reactions', { reaction_hash: 'dmr_x', message_id: 'dmsg_x' }, 'u_a');
		expect(entry.key).toBe('dmr_x');
	});

	it('dialog_message_receipts: receipt_hash', async () => {
		const q = await freshQueue();
		const entry = await q.putPendingDialog('dialog_message_receipts', { receipt_hash: 'dmrc_x', message_id: 'dmsg_x' }, 'u_a');
		expect(entry.key).toBe('dmrc_x');
	});
});

describe('computeLocalSignHash', () => {
	it('returns the existing sign_hash unchanged when present', async () => {
		const q = await freshQueue();
		expect(q.computeLocalSignHash({ sign_hash: 'dms_existing', sign_b64: null })).toBe('dms_existing');
	});

	it('returns null when neither sign_hash nor sign_b64 is present', async () => {
		const q = await freshQueue();
		expect(q.computeLocalSignHash({})).toBeNull();
	});

	it('is deterministic for the same sign_b64', async () => {
		const q = await freshQueue();
		const signB64 = btoa('some-signature-bytes');
		const a = q.computeLocalSignHash({ sign_b64: signB64 });
		const b = q.computeLocalSignHash({ sign_b64: signB64 });
		expect(a).toBe(b);
		expect(a).toMatch(/^dms_[0-9a-f]{128}$/);
	});
});

describe('anyColumnChanged', () => {
	it('no base -> always changed', async () => {
		const q = await freshQueue();
		expect(q.anyColumnChanged(['content_b64'], null, { content_b64: 'x' })).toBe(true);
	});

	it('identical tracked values -> not changed', async () => {
		const q = await freshQueue();
		expect(q.anyColumnChanged(['content_b64', 'deleted_flag'], { content_b64: 'x', deleted_flag: false }, { content_b64: 'x', deleted_flag: false })).toBe(false);
	});

	it('a genuinely different tracked value -> changed', async () => {
		const q = await freshQueue();
		expect(q.anyColumnChanged(['content_b64'], { content_b64: 'x' }, { content_b64: 'y' })).toBe(true);
	});

	it('null and undefined for the same column are treated as equivalent (not changed)', async () => {
		const q = await freshQueue();
		expect(q.anyColumnChanged(['parent_sign_hash'], { parent_sign_hash: null }, { parent_sign_hash: undefined })).toBe(false);
	});
});

describe('withLockedFields', () => {
	it('no base -> merged is returned unchanged', async () => {
		const q = await freshQueue();
		const merged = { dialog_hash: 'di_x', sender_hash: 'u_new' };
		expect(q.withLockedFields(null, merged, ['sender_hash'])).toEqual(merged);
	});

	it('locked fields are pinned back to base; unlocked fields keep the merged value', async () => {
		const q = await freshQueue();
		const base = { dialog_hash: 'di_original', sender_hash: 'u_original', content_b64: 'old' };
		const merged = { dialog_hash: 'di_attempted_change', sender_hash: 'u_attempted_change', content_b64: 'new' };
		const result = q.withLockedFields(base, merged, ['dialog_hash', 'sender_hash']);
		expect(result.dialog_hash).toBe('di_original');
		expect(result.sender_hash).toBe('u_original');
		expect(result.content_b64).toBe('new');
	});
});

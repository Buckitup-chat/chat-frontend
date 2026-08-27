import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import type { DialogRecordFields, DialogTable } from '@/utils/db/tanstack/dialogQueue';
import type { ApiMutation } from '@/api/client';
import { modifiedOf, clearDialogDatabases } from '../testHelpers';

type RecordWithExtras = DialogRecordFields & Record<string, unknown>;

interface MockIngestResult {
	index?: unknown;
	status?: string;
	error?: string;
}

let mockResultsFn: ((mutations: ApiMutation[]) => MockIngestResult[]) | null = null;

vi.mock('@/api/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/api/client')>();
	return {
		api: {
			...actual.api,
			ingestWithAuthEach: vi.fn(async (mutations: ApiMutation[]) => ({
				json: async () => ({ results: mockResultsFn ? mockResultsFn(mutations) : [] }),
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

import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

interface MockIngestResult {
	index?: unknown;
	status?: string;
	error?: string;
	details?: Record<string, unknown>;
}

let mockResultsFn: ((mutations: unknown) => MockIngestResult[]) | null = null;
vi.mock('@/api/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/api/client')>();
	return {
		api: {
			...actual.api,
			ingestWithAuthEach: vi.fn(async (mutations: unknown) => ({
				json: async () => ({ results: mockResultsFn ? mockResultsFn(mutations) : [] }),
			})),
		},
	};
});

const { secretKey: signSkey } = ml_dsa87.keygen();

async function freshQueue() {
	vi.resetModules();
	const queue = await import('@/utils/db/tanstack/userQueue');
	queue.setRemoteReaders({ user_storage: { get: () => undefined, isReady: () => true } });
	await queue.ensureRehydrated();
	return queue;
}

function storageRecord(userHash: string, uuid: string, value: string) {
	return {
		user_hash: userHash,
		uuid,
		value_b64: value,
		hash_b64: null,
		deleted_flag: false,
		owner_timestamp: 1700000000,
		parent_sign_hash: null,
		sign_hash: null,
		sign_b64: null,
	};
}

const UUID_A = 'aaaaaaaa-0000-8000-8000-000000000000';
const UUID_B = 'bbbbbbbb-0000-8000-8000-000000000000';

describe('flushPendingUserChanges — result correlation via r.index (confirmed bug fix)', () => {
	it('1: correlates correctly even when results arrive in REVERSED order relative to the request', async () => {
		const queue = await freshQueue();
		const base = { ...queue.queueStatus.value };
		const user = 'u_corr1';
		await queue.putPendingUserStorage(storageRecord(user, UUID_A, 'vA'));
		await queue.putPendingUserStorage(storageRecord(user, UUID_B, 'vB'));

		mockResultsFn = () => [
			{ index: 1, status: 'ok' },
			{ index: 0, status: 'error', error: 'validation_failed', details: {} },
		];

		await queue.flushPendingUserChanges(signSkey, user);

		const a = queue.pendingUserStorageCollection.get(`${user}:${UUID_A}`);
		const b = queue.pendingUserStorageCollection.get(`${user}:${UUID_B}`);
		expect(a).toBeTruthy();
		expect(b).toBeTruthy();
		expect(queue.queueStatus.value.quarantined - base.quarantined).toBe(1);
		expect(queue.queueStatus.value.awaitingRemote - base.awaitingRemote).toBe(1);
	});

	it('2: a mutation with NO corresponding result at all stays pending and is retried (sparse results)', async () => {
		const queue = await freshQueue();
		const base = { ...queue.queueStatus.value };
		const user = 'u_corr2';
		await queue.putPendingUserStorage(storageRecord(user, UUID_A, 'vA'));
		await queue.putPendingUserStorage(storageRecord(user, UUID_B, 'vB'));

		mockResultsFn = () => [{ index: 0, status: 'ok' }];

		const result = await queue.flushPendingUserChanges(signSkey, user);

		expect(queue.queueStatus.value.pending - base.pending).toBe(1);
		expect(queue.queueStatus.value.awaitingRemote - base.awaitingRemote).toBe(1);
		expect(queue.queueStatus.value.quarantined - base.quarantined).toBe(0);
		expect(result?.retryAfterMs).toBeGreaterThan(0);
	});

	it('3: a result with a missing index is treated as malformed/retryable, never applied by position', async () => {
		const queue = await freshQueue();
		const base = { ...queue.queueStatus.value };
		const user = 'u_corr3';
		await queue.putPendingUserStorage(storageRecord(user, UUID_A, 'vA'));

		mockResultsFn = () => [{ status: 'ok' }];

		const result = await queue.flushPendingUserChanges(signSkey, user);

		expect(queue.pendingUserStorageCollection.get(`${user}:${UUID_A}`)).toBeTruthy();
		expect(queue.queueStatus.value.pending - base.pending).toBe(1);
		expect(queue.queueStatus.value.awaitingRemote - base.awaitingRemote).toBe(0);
		expect(queue.queueStatus.value.quarantined - base.quarantined).toBe(0);
		expect(result?.retryAfterMs).toBeGreaterThan(0);
	});

	it('4: a result with a non-integer index is treated as malformed/retryable', async () => {
		const queue = await freshQueue();
		const base = { ...queue.queueStatus.value };
		const user = 'u_corr4';
		await queue.putPendingUserStorage(storageRecord(user, UUID_A, 'vA'));

		mockResultsFn = () => [{ index: '0', status: 'ok' }];

		await queue.flushPendingUserChanges(signSkey, user);

		expect(queue.queueStatus.value.pending - base.pending).toBe(1);
		expect(queue.queueStatus.value.awaitingRemote - base.awaitingRemote).toBe(0);
	});

	it('5: a result with an out-of-range index (>= mutations sent) is dropped, not misapplied', async () => {
		const queue = await freshQueue();
		const base = { ...queue.queueStatus.value };
		const user = 'u_corr5';
		await queue.putPendingUserStorage(storageRecord(user, UUID_A, 'vA'));

		mockResultsFn = () => [{ index: 5, status: 'ok' }];

		const result = await queue.flushPendingUserChanges(signSkey, user);

		expect(queue.pendingUserStorageCollection.get(`${user}:${UUID_A}`)).toBeTruthy();
		expect(queue.queueStatus.value.pending - base.pending).toBe(1);
		expect(queue.queueStatus.value.awaitingRemote - base.awaitingRemote).toBe(0);
		expect(result?.retryAfterMs).toBeGreaterThan(0);
	});

	it('6: a negative index is treated as malformed/retryable', async () => {
		const queue = await freshQueue();
		const base = { ...queue.queueStatus.value };
		const user = 'u_corr6';
		await queue.putPendingUserStorage(storageRecord(user, UUID_A, 'vA'));

		mockResultsFn = () => [{ index: -1, status: 'ok' }];

		await queue.flushPendingUserChanges(signSkey, user);

		expect(queue.queueStatus.value.pending - base.pending).toBe(1);
		expect(queue.queueStatus.value.awaitingRemote - base.awaitingRemote).toBe(0);
	});

	it('7: two results claiming the SAME index are both discarded — neither is trusted', async () => {
		const queue = await freshQueue();
		const base = { ...queue.queueStatus.value };
		const user = 'u_corr7';
		await queue.putPendingUserStorage(storageRecord(user, UUID_A, 'vA'));
		await queue.putPendingUserStorage(storageRecord(user, UUID_B, 'vB'));

		mockResultsFn = () => [
			{ index: 0, status: 'ok' },
			{ index: 0, status: 'error', error: 'validation_failed', details: {} },
		];

		const result = await queue.flushPendingUserChanges(signSkey, user);

		expect(queue.pendingUserStorageCollection.get(`${user}:${UUID_A}`)).toBeTruthy();
		expect(queue.queueStatus.value.quarantined - base.quarantined).toBe(0);
		expect(queue.queueStatus.value.pending - base.pending).toBe(2);
		expect(queue.queueStatus.value.awaitingRemote - base.awaitingRemote).toBe(0);
		expect(result?.retryAfterMs).toBeGreaterThan(0);
	});

	it('9: does not fall back to positional index — a valid-looking but wrong index must not match by accident', async () => {
		const queue = await freshQueue();
		const base = { ...queue.queueStatus.value };
		const user = 'u_corr9';
		await queue.putPendingUserStorage(storageRecord(user, UUID_A, 'vA'));
		await queue.putPendingUserStorage(storageRecord(user, UUID_B, 'vB'));

		mockResultsFn = () => [{ index: 1, status: 'ok' }];

		await queue.flushPendingUserChanges(signSkey, user);

		expect(queue.pendingUserStorageCollection.get(`${user}:${UUID_A}`)).toBeTruthy();
		expect(queue.queueStatus.value.pending - base.pending).toBe(1);
		expect(queue.queueStatus.value.awaitingRemote - base.awaitingRemote).toBe(1);
	});
});

import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

globalThis.ELECTRIC_API_URL = 'http://localhost/api';

vi.mock('@/api/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/api/client')>();
	return {
		api: {
			...actual.api,
			ingestWithAuthEach: vi.fn(async () => ({
				json: async () => ({
					results: [{ index: 0, status: 'error', error: 'validation_failed', details: { uuid: ['is invalid'] } }],
				}),
			})),
		},
	};
});

const { secretKey: signSkey } = ml_dsa87.keygen();

async function freshModules() {
	vi.resetModules();
	const user = await import('@/utils/db/tanstack/user');
	const queue = await import('@/utils/db/tanstack/userQueue');

	queue.setRemoteReaders({ user_storage: { get: () => undefined, isReady: () => true } });
	return { user, queue };
}

type UserModule = Awaited<ReturnType<typeof freshModules>>['user'];
type QueueModule = Awaited<ReturnType<typeof freshModules>>['queue'];
type StorageChangeInput = Parameters<UserModule['handleUserStorageChanges']>[0];

function storageChanges(user: UserModule, changes: unknown): Promise<unknown> {
	return user.handleUserStorageChanges(changes as StorageChangeInput);
}

async function makeLegacyQuarantinedEntry(queue: QueueModule, userHash: string, legacySlot: string) {
	await queue.putPendingUserStorage({
		user_hash: userHash,
		uuid: legacySlot,
		value_b64: 'ciphertext-v1',
		hash_b64: 'hash-v1',
		deleted_flag: false,
		owner_timestamp: 1700000000,
		parent_sign_hash: null,
		sign_hash: null,
		sign_b64: null,
	});
	await queue.flushPendingUserChanges(signSkey, userHash);
}

function legacyEntryStatus(queue: QueueModule, userHash: string, legacySlot: string) {
	return queue.pendingUserStorageCollection.get(`${userHash}:${legacySlot}`);
}

function authoritativeRowChange(user: UserModule, userHash: string, logicalUuid: string, overrides: Record<string, unknown> = {}) {
	const physicalUuid = user.deriveStorageUuid(logicalUuid);
	return {
		type: 'insert',
		key: `${userHash}:${physicalUuid}`,
		value: { user_hash: userHash, uuid: physicalUuid, value_b64: 'ciphertext-current', deleted_flag: false, ...overrides },
	};
}

describe('legacy user_storage orphan cleanup — real production wiring (handleUserStorageChanges)', () => {
	it('1: a legacy "profile" quarantined entry is removed once the current authoritative row for that slot arrives', async () => {
		const { user, queue } = await freshModules();
		const baseline = queue.queueStatus.value.quarantined;
		await makeLegacyQuarantinedEntry(queue, 'u_test1', 'profile');
		expect(queue.queueStatus.value.quarantined).toBe(baseline + 1);

		await storageChanges(user, [authoritativeRowChange(user, 'u_test1', 'profile')]);

		expect(queue.queueStatus.value.quarantined).toBe(baseline);
		expect(legacyEntryStatus(queue, 'u_test1', 'profile')).toBeUndefined();
	});

	it('2: a legacy "contacts" quarantined entry is removed once the current authoritative row for that slot arrives', async () => {
		const { user, queue } = await freshModules();
		const baseline = queue.queueStatus.value.quarantined;
		await makeLegacyQuarantinedEntry(queue, 'u_test2', 'contacts');
		expect(queue.queueStatus.value.quarantined).toBe(baseline + 1);

		await storageChanges(user, [authoritativeRowChange(user, 'u_test2', 'contacts')]);

		expect(queue.queueStatus.value.quarantined).toBe(baseline);
		expect(legacyEntryStatus(queue, 'u_test2', 'contacts')).toBeUndefined();
	});

	it('3: a legacy "profile" entry with NO current replacement row is left untouched', async () => {
		const { user, queue } = await freshModules();
		const baseline = queue.queueStatus.value.quarantined;
		await makeLegacyQuarantinedEntry(queue, 'u_test3', 'profile');

		await storageChanges(user, [authoritativeRowChange(user, 'u_test3_other', 'profile')]);

		expect(queue.queueStatus.value.quarantined).toBe(baseline + 1);
		expect(legacyEntryStatus(queue, 'u_test3', 'profile')).toBeTruthy();
	});

	it('4: the "profile" replacement arriving must never remove a legacy "contacts" entry for the same user', async () => {
		const { user, queue } = await freshModules();
		const baseline = queue.queueStatus.value.quarantined;
		await makeLegacyQuarantinedEntry(queue, 'u_test4', 'profile');
		await makeLegacyQuarantinedEntry(queue, 'u_test4', 'contacts');
		expect(queue.queueStatus.value.quarantined).toBe(baseline + 2);

		await storageChanges(user, [authoritativeRowChange(user, 'u_test4', 'profile')]);

		expect(legacyEntryStatus(queue, 'u_test4', 'profile')).toBeUndefined();
		expect(legacyEntryStatus(queue, 'u_test4', 'contacts')).toBeTruthy();
		expect(queue.queueStatus.value.quarantined).toBe(baseline + 1);
	});

	it('5: an ordinary (non-legacy) quarantined UUIDv8 entry is never touched, even when a "profile" replacement arrives for the same user', async () => {
		const { user, queue } = await freshModules();
		const avatarUuid = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
		const baseline = queue.queueStatus.value.quarantined;
		await makeLegacyQuarantinedEntry(queue, 'u_test5', avatarUuid);
		expect(queue.queueStatus.value.quarantined).toBe(baseline + 1);

		await storageChanges(user, [authoritativeRowChange(user, 'u_test5', 'profile')]);

		expect(queue.queueStatus.value.quarantined).toBe(baseline + 1);
		expect(legacyEntryStatus(queue, 'u_test5', avatarUuid)).toBeTruthy();
	});

	it('6: a "profile" entry that is still pending (never sent) is never removed, even if the derived key happens to match', async () => {
		const { user, queue } = await freshModules();
		const baseline = queue.queueStatus.value.pending;
		await queue.putPendingUserStorage({
			user_hash: 'u_test6',
			uuid: 'profile',
			value_b64: 'v',
			hash_b64: 'h',
			deleted_flag: false,
			owner_timestamp: 1700000000,
			parent_sign_hash: null,
			sign_hash: null,
			sign_b64: null,
		});
		expect(queue.queueStatus.value.pending).toBe(baseline + 1);

		await storageChanges(user, [authoritativeRowChange(user, 'u_test6', 'profile')]);

		expect(queue.queueStatus.value.pending).toBe(baseline + 1);
		expect(legacyEntryStatus(queue, 'u_test6', 'profile')).toBeTruthy();
	});

	it('7: a "profile" entry that is awaiting_remote (backend-accepted, not yet echoed) is never removed', async () => {
		const { user, queue } = await freshModules();
		const baseline = queue.queueStatus.value.awaitingRemote;
		const entry = await queue.putPendingUserStorage({
			user_hash: 'u_test7',
			uuid: 'profile',
			value_b64: 'v',
			hash_b64: 'h',
			deleted_flag: false,
			owner_timestamp: 1700000000,
			parent_sign_hash: null,
			sign_hash: null,
			sign_b64: null,
		});
		await queue.markAwaitingRemote(entry, entry.record);
		expect(queue.queueStatus.value.awaitingRemote).toBe(baseline + 1);

		await storageChanges(user, [authoritativeRowChange(user, 'u_test7', 'profile')]);

		expect(queue.queueStatus.value.awaitingRemote).toBe(baseline + 1);
		expect(legacyEntryStatus(queue, 'u_test7', 'profile')).toBeTruthy();
	});

	it('8: a quarantined "profile" entry with a lastError other than "validation_failed" is kept', async () => {
		const { user, queue } = await freshModules();
		const baseline = queue.queueStatus.value.quarantined;
		await queue.putPendingUserStorage({
			user_hash: 'u_test8',
			uuid: 'profile',
			value_b64: '',
			hash_b64: null,
			deleted_flag: false,
			owner_timestamp: 1700000000,
			parent_sign_hash: null,
			sign_hash: null,
			sign_b64: null,
		});
		await queue.flushPendingUserChanges(signSkey, 'u_test8');
		expect(queue.queueStatus.value.quarantined).toBe(baseline + 1);

		await storageChanges(user, [authoritativeRowChange(user, 'u_test8', 'profile')]);

		expect(queue.queueStatus.value.quarantined).toBe(baseline + 1);
		expect(legacyEntryStatus(queue, 'u_test8', 'profile')).toBeTruthy();
	});

	it('9: cleanup consistently updates the durable journal, the overlay, AND queueStatus.quarantined together', async () => {
		const { user, queue } = await freshModules();
		const baseline = queue.queueStatus.value.quarantined;
		await makeLegacyQuarantinedEntry(queue, 'u_test9', 'profile');

		await storageChanges(user, [authoritativeRowChange(user, 'u_test9', 'profile')]);

		expect(queue.pendingUserStorageCollection.has('u_test9:profile')).toBe(false);
		expect(queue.queueStatus.value.quarantined).toBe(baseline);
		vi.resetModules();
		const reloaded = await import('@/utils/db/tanstack/userQueue');
		await reloaded.ensureRehydrated();
		expect(reloaded.pendingUserStorageCollection.has('u_test9:profile')).toBe(false);
	});

	it('10: cleanup is idempotent — firing the same authoritative event twice never double-decrements or throws', async () => {
		const { user, queue } = await freshModules();
		const baseline = {
			quarantined: queue.queueStatus.value.quarantined,
			pending: queue.queueStatus.value.pending,
			awaitingRemote: queue.queueStatus.value.awaitingRemote,
		};
		await makeLegacyQuarantinedEntry(queue, 'u_test10', 'profile');

		await storageChanges(user, [authoritativeRowChange(user, 'u_test10', 'profile')]);
		expect(queue.queueStatus.value.quarantined).toBe(baseline.quarantined);

		await storageChanges(user, [authoritativeRowChange(user, 'u_test10', 'profile', { value_b64: 'ciphertext-v2' })]);

		expect(queue.queueStatus.value.quarantined).toBe(baseline.quarantined);
		expect(queue.queueStatus.value.pending).toBe(baseline.pending);
		expect(queue.queueStatus.value.awaitingRemote).toBe(baseline.awaitingRemote);
	});

	it('11: cleanup also runs on initial authoritative state after a reload (includeInitialState), automatically, without any new mutation', async () => {
		const { queue: queueBeforeReload } = await freshModules();
		const baseline = queueBeforeReload.queueStatus.value.quarantined;
		await makeLegacyQuarantinedEntry(queueBeforeReload, 'u_test11', 'profile');
		expect(queueBeforeReload.queueStatus.value.quarantined).toBe(baseline + 1);

		vi.resetModules();
		const user = await import('@/utils/db/tanstack/user');
		const queue = await import('@/utils/db/tanstack/userQueue');
		await queue.ensureRehydrated();
		expect(legacyEntryStatus(queue, 'u_test11', 'profile')).toBeTruthy();

		await storageChanges(user, [authoritativeRowChange(user, 'u_test11', 'profile')]);

		expect(legacyEntryStatus(queue, 'u_test11', 'profile')).toBeUndefined();
	});
});

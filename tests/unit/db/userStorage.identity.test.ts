import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { assertReady, modifiedOf } from '../testHelpers';

globalThis.ELECTRIC_API_URL = 'http://localhost/api';

const { secretKey: signSkey } = ml_dsa87.keygen();

async function freshUserModule() {
	vi.resetModules();
	const user = await import('@/utils/db/tanstack/user');
	const queue = await import('@/utils/db/tanstack/userQueue');
	return { user, queue };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('deriveStorageUuid — logical slot -> physical backend uuid (section P1)', () => {
	it('1: a non-uuid logical name ("profile") is never returned as-is — it is always a real uuid', async () => {
		const { user } = await freshUserModule();
		const physical = user.deriveStorageUuid('profile');
		expect(physical).not.toBe('profile');
		expect(physical).toMatch(UUID_RE);
	});

	it('2: the same logical slot always derives to the same physical uuid', async () => {
		const { user } = await freshUserModule();
		expect(user.deriveStorageUuid('profile')).toBe(user.deriveStorageUuid('profile'));
		expect(user.deriveStorageUuid('contacts')).toBe(user.deriveStorageUuid('contacts'));
		expect(user.deriveStorageUuid('profile')).not.toBe(user.deriveStorageUuid('contacts'));
	});

	it('a value that is already a real uuid (e.g. encryptAndStoreAvatar\'s crypto.randomUUID()) passes through unchanged', async () => {
		const { user } = await freshUserModule();
		const realUuid = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
		expect(user.deriveStorageUuid(realUuid)).toBe(realUuid);
	});

	it('3/8: the physical uuid is identical across a simulated reload (fresh module instance)', async () => {
		const { user: session1 } = await freshUserModule();
		const first = session1.deriveStorageUuid('profile');

		const { user: session2 } = await freshUserModule();
		const second = session2.deriveStorageUuid('profile');

		expect(second).toBe(first);
	});
});

describe('upsertUserStorage — never sends the logical slot name as the wire uuid (section P1)', () => {
	it('1: the queued mutation payload uuid is a real uuid, never the literal "profile"', async () => {
		const { user, queue } = await freshUserModule();

		const entry = await user.upsertUserStorage({
			userHash: 'u_alice',
			uuid: 'profile',
			valueB64: 'ciphertext-v1',
			hashB64: 'hash-v1',
		});

		expect(entry.patch.uuid).not.toBe('profile');
		expect(entry.patch.uuid).toMatch(UUID_RE);
		expect(entry.record.uuid).toMatch(UUID_RE);

		const resolved = assertReady(
			queue.resolvePendingRecord('user_storage', entry.patch, { known: true, value: undefined }, null)
		);
		const { mutation } = queue.buildMutation('user_storage', resolved.record, resolved.mutationType, signSkey);
		expect(modifiedOf(mutation).uuid).toBe(user.deriveStorageUuid('profile'));
		expect(modifiedOf(mutation).uuid).not.toBe('profile');
	});

	it('2: two saves to the same logical "profile" slot use the same physical uuid', async () => {
		const { user } = await freshUserModule();

		const first = await user.upsertUserStorage({
			userHash: 'u_alice', uuid: 'profile', valueB64: 'v1', hashB64: 'h1',
		});
		const second = await user.upsertUserStorage({
			userHash: 'u_alice', uuid: 'profile', valueB64: 'v2', hashB64: 'h2',
		});

		expect(second.record.uuid).toBe(first.record.uuid);
		expect(second.key).toBe(first.key);
	});

	it('getUserStorage("profile") still returns records with the logical uuid, hiding the physical mapping', async () => {
		const { user } = await freshUserModule();
		await user.upsertUserStorage({ userHash: 'u_alice', uuid: 'profile', valueB64: 'v1', hashB64: 'h1' });

		const storage = await user.getUserStorage('u_alice', 'profile');
		if (!storage) throw new Error('expected getUserStorage to return a record');
		expect(storage.uuid).toBe('profile');
		expect(storage.value_b64).toBe('v1');
	});
});

describe('second edit after a backend-accepted insert (section 6, ties into the section-7 race fix)', () => {
	it('uses the same physical uuid and resolves as update, not another insert', async () => {
		const { user, queue } = await freshUserModule();

		const inserted = await user.upsertUserStorage({
			userHash: 'u_alice', uuid: 'profile', valueB64: 'v1', hashB64: 'h1',
		});

		await queue.markAwaitingRemote(inserted, inserted.record);

		const edited = await user.upsertUserStorage({
			userHash: 'u_alice', uuid: 'profile', valueB64: 'v2', hashB64: 'h2',
		});

		expect(edited.record.uuid).toBe(inserted.record.uuid);
		expect(edited.sentSnapshot).toMatchObject({ uuid: inserted.record.uuid });

		const baseState = queue.resolveBaseState('user_storage', edited.key);
		const resolved = assertReady(queue.resolvePendingRecord('user_storage', edited.patch, baseState, edited.sentSnapshot));

		expect(resolved.mutationType).toBe('update');
		expect(resolved.record.uuid).toBe(inserted.record.uuid);
		expect(resolved.record.value_b64).toBe('v2');
	});
});

describe('quarantined user_storage entry + new edit reactivates it (section P4 / 7)', () => {
	it('an invalid mutation gets quarantined, and a subsequent valid edit to the same slot returns it to pending', async () => {
		const { user, queue } = await freshUserModule();

		await user.upsertUserStorage({ userHash: 'u_alice', uuid: 'profile', valueB64: '', hashB64: null });
		await queue.flushPendingUserChanges(signSkey, 'u_alice');

		expect(queue.queueStatus.value.quarantined).toBe(1);
		expect(queue.queueStatus.value.pending).toBe(0);

		await user.upsertUserStorage({ userHash: 'u_alice', uuid: 'profile', valueB64: 'real-value', hashB64: 'h' });

		expect(queue.queueStatus.value.quarantined).toBe(0);
		expect(queue.queueStatus.value.pending).toBe(1);
	});
});

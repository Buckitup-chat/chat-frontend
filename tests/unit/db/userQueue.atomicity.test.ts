import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';

async function freshQueue() {
	vi.resetModules();
	const queue = await import('@/utils/db/tanstack/userQueue');
	await queue.ensureRehydrated();
	return queue;
}

describe('userQueue atomicity — concurrent same-key writes must not lose either edit (confirmed bug fix)', () => {
	it('1: two genuinely concurrent putPendingUserStorage calls to a brand-new key both survive a simulated reload', async () => {
		const queue = await freshQueue();

		const p1 = queue.putPendingUserStorage(
			{ user_hash: 'u_atomic1', uuid: 'profile', value_b64: 'fieldA-value', hash_b64: 'hA' },
			{ user_hash: 'u_atomic1', uuid: 'profile', value_b64: 'fieldA-value' }
		);
		const p2 = queue.putPendingUserStorage(
			{ user_hash: 'u_atomic1', uuid: 'profile', parent_sign_hash: 'fieldB-value' },
			{ user_hash: 'u_atomic1', uuid: 'profile', parent_sign_hash: 'fieldB-value' }
		);
		await Promise.all([p1, p2]);

		vi.resetModules();
		const reloaded = await import('@/utils/db/tanstack/userQueue');
		await reloaded.ensureRehydrated();

		const after = reloaded.pendingUserStorageCollection.get('u_atomic1:profile');
		expect(after).toBeTruthy();
		expect(after!.value_b64).toBe('fieldA-value');
		expect(after!.hash_b64).toBe('hA');
		expect(after!.parent_sign_hash).toBe('fieldB-value');
	});

	it('2: three genuinely concurrent putPendingUserStorage calls to a brand-new key all survive a simulated reload', async () => {
		const queue = await freshQueue();

		const p1 = queue.putPendingUserStorage(
			{ user_hash: 'u_atomic2', uuid: 'profile', value_b64: 'v1' },
			{ user_hash: 'u_atomic2', uuid: 'profile', value_b64: 'v1' }
		);
		const p2 = queue.putPendingUserStorage(
			{ user_hash: 'u_atomic2', uuid: 'profile', hash_b64: 'h2' },
			{ user_hash: 'u_atomic2', uuid: 'profile', hash_b64: 'h2' }
		);
		const p3 = queue.putPendingUserStorage(
			{ user_hash: 'u_atomic2', uuid: 'profile', parent_sign_hash: 'p3' },
			{ user_hash: 'u_atomic2', uuid: 'profile', parent_sign_hash: 'p3' }
		);
		await Promise.all([p1, p2, p3]);

		vi.resetModules();
		const reloaded = await import('@/utils/db/tanstack/userQueue');
		await reloaded.ensureRehydrated();

		const after = reloaded.pendingUserStorageCollection.get('u_atomic2:profile');
		expect(after).toBeTruthy();
		expect(after!.value_b64).toBe('v1');
		expect(after!.hash_b64).toBe('h2');
		expect(after!.parent_sign_hash).toBe('p3');
	});

	it('3: a stale markAwaitingRemote call can never overwrite a newer edit that has already committed (write-then-confirm ordering)', async () => {
		const queue = await freshQueue();

		const inserted = await queue.putPendingUserStorage(
			{ user_hash: 'u_atomic3', uuid: 'profile', value_b64: 'v1' },
			{ user_hash: 'u_atomic3', uuid: 'profile', value_b64: 'v1' }
		);

		await queue.putPendingUserStorage(
			{ user_hash: 'u_atomic3', uuid: 'profile', value_b64: 'v2' },
			{ user_hash: 'u_atomic3', uuid: 'profile', value_b64: 'v2' }
		);

		await queue.markAwaitingRemote(inserted, inserted.record);

		const after = queue.pendingUserStorageCollection.get('u_atomic3:profile');
		expect(after).toBeTruthy();
		expect(after!.value_b64).toBe('v2');
	});

	it('4: markAwaitingRemote and a newer edit racing with NO await between them never lose the newer edit, regardless of which transaction wins', async () => {
		const queue = await freshQueue();

		const inserted = await queue.putPendingUserStorage(
			{ user_hash: 'u_atomic4', uuid: 'profile', value_b64: 'v1' },
			{ user_hash: 'u_atomic4', uuid: 'profile', value_b64: 'v1' }
		);

		const confirmPromise = queue.markAwaitingRemote(inserted, inserted.record);
		const newEditPromise = queue.putPendingUserStorage(
			{ user_hash: 'u_atomic4', uuid: 'profile', value_b64: 'v2' },
			{ user_hash: 'u_atomic4', uuid: 'profile', value_b64: 'v2' }
		);
		await Promise.all([confirmPromise, newEditPromise]);

		const after = queue.pendingUserStorageCollection.get('u_atomic4:profile');
		expect(after).toBeTruthy();
		expect(after!.value_b64).toBe('v2');
	});
});

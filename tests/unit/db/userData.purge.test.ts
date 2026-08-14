import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import type * as UserQueue from '@/utils/db/tanstack/userQueue';
import type * as UserCache from '@/utils/db/tanstack/userCache';

globalThis.ELECTRIC_API_URL = 'http://localhost/api';
const { secretKey: signSkey } = ml_dsa87.keygen();

async function freshModules() {
	vi.resetModules();
	const user = await import('@/utils/db/tanstack/user');
	const queue = await import('@/utils/db/tanstack/userQueue');
	const cache = await import('@/utils/db/tanstack/userCache');
	queue.setRemoteReaders({ user_storage: { get: () => undefined, isReady: () => true } });
	await queue.ensureRehydrated();
	await cache.ensureCacheHydrated();
	return { user, queue, cache };
}

async function seedFixturesFor(
	queue: typeof UserQueue,
	cache: typeof UserCache,
	userHash: string
) {
	await queue.putPendingUserCard(
		{ user_hash: userHash, sign_pkey: 'sp', contact_pkey: 'cp', crypt_pkey: 'kp', name: 'N', deleted_flag: false },
		{ user_hash: userHash, name: 'N' }
	);
	await queue.putPendingUserStorage({
		user_hash: userHash, uuid: 'profile', value_b64: '', hash_b64: null, deleted_flag: false,
		owner_timestamp: 1700000000, parent_sign_hash: null, sign_hash: null, sign_b64: null,
	});
	await queue.flushPendingUserChanges(signSkey, userHash);
	cache.recordSynced('user_cards', userHash, { user_hash: userHash, name: 'Cached' });
	cache.recordSynced('user_storage', `${userHash}:contacts`, { user_hash: userHash, uuid: 'contacts', value_b64: 'cv' });
}

describe('purgeUserData — deleteUserVault cleanup (confirmed new gap, fixed)', () => {
	it('1: purging user A removes all of A\'s queue entries (pending user_cards + quarantined user_storage)', async () => {
		const { user, queue, cache } = await freshModules();
		await seedFixturesFor(queue, cache, 'u_delA');

		await user.purgeUserData('u_delA');

		expect(queue.pendingUserCardsCollection.has('u_delA')).toBe(false);
		expect(queue.pendingUserStorageCollection.has('u_delA:profile')).toBe(false);
	});

	it('2: purging user A removes all of A\'s cache entries (both tables)', async () => {
		const { user, queue, cache } = await freshModules();
		await seedFixturesFor(queue, cache, 'u_delB');

		await user.purgeUserData('u_delB');

		expect(cache.cachedUserCardsCollection.has('u_delB')).toBe(false);
		expect(cache.cachedUserStorageCollection.has('u_delB:contacts')).toBe(false);
	});

	it('3: purging user A never touches user B\'s queue or cache entries', async () => {
		const { user, queue, cache } = await freshModules();
		await seedFixturesFor(queue, cache, 'u_delC');
		await seedFixturesFor(queue, cache, 'u_keepC');

		await user.purgeUserData('u_delC');

		expect(queue.pendingUserCardsCollection.has('u_delC')).toBe(false);
		expect(queue.pendingUserStorageCollection.has('u_delC:profile')).toBe(false);
		expect(cache.cachedUserCardsCollection.has('u_delC')).toBe(false);
		expect(cache.cachedUserStorageCollection.has('u_delC:contacts')).toBe(false);

		expect(queue.pendingUserCardsCollection.get('u_keepC')).toMatchObject({ name: 'N' });
		expect(queue.pendingUserStorageCollection.get('u_keepC:profile')).toBeTruthy();
		expect(cache.cachedUserCardsCollection.get('u_keepC')).toMatchObject({ name: 'Cached' });
		expect(cache.cachedUserStorageCollection.get('u_keepC:contacts')).toMatchObject({ value_b64: 'cv' });
	});

	it('4: queueStatus.quarantined/pending correctly decrement for the deleted user only', async () => {
		const { user, queue, cache } = await freshModules();
		const base = { ...queue.queueStatus.value };
		await seedFixturesFor(queue, cache, 'u_delD');
		await seedFixturesFor(queue, cache, 'u_keepD');

		expect(queue.queueStatus.value.pending - base.pending).toBe(2);
		expect(queue.queueStatus.value.quarantined - base.quarantined).toBe(2);

		await user.purgeUserData('u_delD');

		expect(queue.queueStatus.value.pending - base.pending).toBe(1);
		expect(queue.queueStatus.value.quarantined - base.quarantined).toBe(1);
	});

	it('5: durable removal survives a simulated reload — the deleted user\'s entries do not come back', async () => {
		const { user, queue, cache } = await freshModules();
		await seedFixturesFor(queue, cache, 'u_delE');

		await user.purgeUserData('u_delE');

		vi.resetModules();
		const reloadedQueue = await import('@/utils/db/tanstack/userQueue');
		const reloadedCache = await import('@/utils/db/tanstack/userCache');
		await reloadedQueue.ensureRehydrated();
		await reloadedCache.ensureCacheHydrated();

		expect(reloadedQueue.pendingUserCardsCollection.has('u_delE')).toBe(false);
		expect(reloadedQueue.pendingUserStorageCollection.has('u_delE:profile')).toBe(false);
		expect(reloadedCache.cachedUserCardsCollection.has('u_delE')).toBe(false);
		expect(reloadedCache.cachedUserStorageCollection.has('u_delE:contacts')).toBe(false);
	});

	it('6: is idempotent — purging an already-purged (or never-existing) user is a safe no-op', async () => {
		const { user, queue, cache } = await freshModules();
		await seedFixturesFor(queue, cache, 'u_delF');

		await user.purgeUserData('u_delF');
		const result = await user.purgeUserData('u_delF');
		const resultNeverExisted = await user.purgeUserData('u_never_existed');

		expect(result.queueRemoved).toBe(0);
		expect(result.cacheRemoved).toBe(0);
		expect(resultNeverExisted.queueRemoved).toBe(0);
		expect(resultNeverExisted.cacheRemoved).toBe(0);
	});
});

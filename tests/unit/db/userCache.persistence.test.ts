import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

describe('userCache — synced data survives reload while offline', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('a row recorded as synced in one session is available from a fresh module load, with no Electric involved', async () => {
		const session1 = await import('@/utils/db/tanstack/userCache');
		session1.recordSynced('user_cards', 'u_alice', {
			user_hash: 'u_alice',
			name: 'Alice',
			sign_pkey: 'sp',
			crypt_pkey: 'cp',
			contact_pkey: 'ctp',
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		vi.resetModules();
		const session2 = await import('@/utils/db/tanstack/userCache');
		await session2.ensureCacheHydrated();

		const row = session2.cachedUserCardsCollection.get('u_alice');
		expect(row).toMatchObject({ user_hash: 'u_alice', name: 'Alice' });
	});

	it('user_storage rows survive the same way', async () => {
		const session1 = await import('@/utils/db/tanstack/userCache');
		session1.recordSynced('user_storage', 'u_alice:profile', {
			user_hash: 'u_alice',
			uuid: 'profile',
			value_b64: 'ciphertext',
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		vi.resetModules();
		const session2 = await import('@/utils/db/tanstack/userCache');
		await session2.ensureCacheHydrated();

		const row = session2.cachedUserStorageCollection.get('u_alice:profile');
		expect(row).toMatchObject({ value_b64: 'ciphertext' });
	});

	it('forgetSynced removes a row durably — it does not come back after a reload', async () => {
		const session1 = await import('@/utils/db/tanstack/userCache');
		session1.recordSynced('user_cards', 'u_bob', { user_hash: 'u_bob', name: 'Bob' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		session1.forgetSynced('user_cards', 'u_bob');
		await new Promise((resolve) => setTimeout(resolve, 0));

		vi.resetModules();
		const session2 = await import('@/utils/db/tanstack/userCache');
		await session2.ensureCacheHydrated();

		expect(session2.cachedUserCardsCollection.get('u_bob')).toBeUndefined();
	});

	it('isCacheHydrated becomes true even with an empty cache (a brand-new device), so the UI never waits forever', async () => {
		const session = await import('@/utils/db/tanstack/userCache');
		expect(session.isCacheHydrated.value).toBe(false);
		await session.ensureCacheHydrated();
		expect(session.isCacheHydrated.value).toBe(true);
	});
});

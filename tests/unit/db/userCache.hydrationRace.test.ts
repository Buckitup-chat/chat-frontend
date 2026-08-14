import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';

async function freshCache() {
	vi.resetModules();
	return import('@/utils/db/tanstack/userCache');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('userCache hydration ↔ Electric subscription race (confirmed bug fix)', () => {
	it('1: an Electric DELETE arriving mid-hydration must not resurrect the row', async () => {
		const seed = await freshCache();
		seed.recordSynced('user_cards', 'u_x', { user_hash: 'u_x', name: 'Stale' });
		await tick();

		const fresh = await freshCache();
		const hydration = fresh.ensureCacheHydrated();

		fresh.forgetSynced('user_cards', 'u_x');
		expect(fresh.cachedUserCardsCollection.has('u_x')).toBe(false);

		await hydration;

		expect(fresh.cachedUserCardsCollection.has('u_x')).toBe(false);
	});

	it('2: an Electric UPDATE arriving mid-hydration must not be reverted by the stale snapshot', async () => {
		const seed = await freshCache();
		seed.recordSynced('user_cards', 'u_y', { user_hash: 'u_y', name: 'OldName' });
		await tick();

		const fresh = await freshCache();
		const hydration = fresh.ensureCacheHydrated();

		fresh.recordSynced('user_cards', 'u_y', { user_hash: 'u_y', name: 'NewName' });
		expect(fresh.cachedUserCardsCollection.get('u_y')!.name).toBe('NewName');

		await hydration;

		expect(fresh.cachedUserCardsCollection.get('u_y')!.name).toBe('NewName');
	});

	it('3: the same DELETE race for user_storage (a different table/store) is also closed', async () => {
		const seed = await freshCache();
		seed.recordSynced('user_storage', 'u_z:profile', { user_hash: 'u_z', uuid: 'profile', value_b64: 'stale' });
		await tick();

		const fresh = await freshCache();
		const hydration = fresh.ensureCacheHydrated();
		fresh.forgetSynced('user_storage', 'u_z:profile');

		await hydration;

		expect(fresh.cachedUserStorageCollection.has('u_z:profile')).toBe(false);
	});

	it('4: touching one key never affects hydration of an untouched key in the same table', async () => {
		const seed = await freshCache();
		seed.recordSynced('user_cards', 'u_a', { user_hash: 'u_a', name: 'A' });
		seed.recordSynced('user_cards', 'u_b', { user_hash: 'u_b', name: 'B' });
		await tick();

		const fresh = await freshCache();
		const hydration = fresh.ensureCacheHydrated();
		fresh.forgetSynced('user_cards', 'u_a');

		await hydration;

		expect(fresh.cachedUserCardsCollection.has('u_a')).toBe(false);
		expect(fresh.cachedUserCardsCollection.get('u_b')).toMatchObject({ name: 'B' });
	});

	it('5: with NO competing Electric event, hydration still applies the durable snapshot normally', async () => {
		const seed = await freshCache();
		seed.recordSynced('user_cards', 'u_normal', { user_hash: 'u_normal', name: 'Normal' });
		await tick();

		const fresh = await freshCache();
		await fresh.ensureCacheHydrated();

		expect(fresh.cachedUserCardsCollection.get('u_normal')).toMatchObject({ name: 'Normal' });
	});
});

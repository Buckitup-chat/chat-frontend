import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';

globalThis.ELECTRIC_API_URL = 'http://localhost/api';

async function freshModules() {
	vi.resetModules();
	const user = await import('@/utils/db/tanstack/user');
	return { user };
}

type UserModule = Awaited<ReturnType<typeof freshModules>>['user'];
type CardChangeInput = Parameters<UserModule['handleUserCardChanges']>[0];

function cardChanges(user: UserModule, changes: unknown): void {
	user.handleUserCardChanges(changes as CardChangeInput);
}

function mergedCards(user: UserModule) {
	const byHash = new Map<string, { user_hash: string; deleted_flag?: boolean }>();
	for (const u of user.cachedUserCardsCollection.toArray) byHash.set(u.user_hash, u);
	for (const u of user.previewUserCardsCollection.toArray) byHash.set(u.user_hash, u);
	return Array.from(byHash.values()).filter((u) => !u.deleted_flag);
}

describe('handleUserCardChanges — clears QR preview on the first authoritative Electric event', () => {
	it('insert/update clears preview and the authoritative/cache row remains', async () => {
		const { user } = await freshModules();

		user.previewUserCard({ user_hash: 'u_peer', name: 'Peer (preview)' });
		expect(user.previewUserCardsCollection.has('u_peer')).toBe(true);

		cardChanges(user, [{ type: 'update', key: 'u_peer', value: { user_hash: 'u_peer', name: 'Peer (real)' } }]);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(user.previewUserCardsCollection.has('u_peer')).toBe(false);
		expect(user.cachedUserCardsCollection.get('u_peer')).toMatchObject({ name: 'Peer (real)' });
	});

	it('delete cannot resurrect preview', async () => {
		const { user } = await freshModules();

		user.previewUserCard({ user_hash: 'u_peer', name: 'Peer (preview)' });

		cardChanges(user, [{ type: 'insert', key: 'u_peer', value: { user_hash: 'u_peer', name: 'Peer (real)' } }]);
		await new Promise((resolve) => setTimeout(resolve, 0));

		cardChanges(user, [{ type: 'delete', key: 'u_peer' }]);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(user.previewUserCardsCollection.has('u_peer')).toBe(false);
		expect(user.cachedUserCardsCollection.get('u_peer')).toBeUndefined();
		expect(mergedCards(user).find((u) => u.user_hash === 'u_peer')).toBeUndefined();
	});

	it('an event for one key never clears an unrelated preview', async () => {
		const { user } = await freshModules();

		user.previewUserCard({ user_hash: 'u_a', name: 'A' });
		user.previewUserCard({ user_hash: 'u_b', name: 'B' });

		cardChanges(user, [{ type: 'update', key: 'u_a', value: { user_hash: 'u_a', name: 'A (real)' } }]);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(user.previewUserCardsCollection.has('u_a')).toBe(false);
		expect(user.previewUserCardsCollection.has('u_b')).toBe(true);
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured: any[] = [];
vi.mock('@tanstack/electric-db-collection', () => ({
	electricCollectionOptions: (opts: any) => {
		captured.push(opts);
		return opts;
	},
}));
vi.mock('@tanstack/db', () => ({ createCollection: (o: any) => o }));
vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({ persistedCollectionOptions: (o: any) => o }));
vi.mock('../src/lib/data/persistence', () => ({ getPersistence: () => null }));

const MINE = 'u_' + 'a'.repeat(128);
const OTHER = 'u_' + 'b'.repeat(128);

describe('user_storage shape scope', () => {
	beforeEach(() => {
		captured.length = 0;
		vi.resetModules();
	});

	// user_storage reads are public, so an unfiltered shape streams every
	// account in the network to this client.
	it('filters the shape to the signed-in account', async () => {
		const { getUserStorageCollection } = await import('@/lib/data/collections');
		getUserStorageCollection(MINE);
		const opts = captured.find((o) => o.shapeOptions?.params?.table === 'user_storage');
		expect(opts).toBeTruthy();
		expect(opts.shapeOptions.params.where).toBe(`user_hash = '${MINE}'`);
	});

	// Falling back to an account-less collection would quietly restore the
	// network-wide sync this replaced.
	it('refuses to build a collection with no account rather than syncing everything', async () => {
		const { getUserStorageCollection } = await import('@/lib/data/collections');
		expect(() => getUserStorageCollection()).toThrow(/user_hash/);
		expect(captured.find((o) => o.shapeOptions?.params?.table === 'user_storage')).toBeFalsy();
	});

	it('rejects a malformed user_hash instead of building a broken filter', async () => {
		const { getUserStorageCollection } = await import('@/lib/data/collections');
		expect(() => getUserStorageCollection('not-a-hash')).toThrow(/Invalid user_hash/);
	});

	it('rebuilds for a different account and drops the old scope on reset', async () => {
		const { getUserStorageCollection, resetUserStorageCollection } = await import('@/lib/data/collections');
		getUserStorageCollection(MINE);
		getUserStorageCollection(OTHER);
		const wheres = captured
			.filter((o) => o.shapeOptions?.params?.table === 'user_storage')
			.map((o) => o.shapeOptions.params.where);
		expect(wheres).toEqual([`user_hash = '${MINE}'`, `user_hash = '${OTHER}'`]);
		resetUserStorageCollection();
		expect(() => getUserStorageCollection()).toThrow(/user_hash/);
	});
});

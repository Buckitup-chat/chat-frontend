import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _setReadCacheStorageForTests, _resetTouchedForTests, setCachedRow, getCachedRow } from '@/lib/data/readCache';
import { _setAcceptedSnapshotStorageForTests, recordAccepted, getAccepted } from '@/lib/data/acceptedSnapshot';

let vaults;
let rawStore;

const makeVault = (id) => {
	const data = new Map();
	return { id, async set(k, v) { data.set(k, v); }, async get(k) { return data.get(k); } };
};

const makeStorage = () => {
	const map = new Map();
	return {
		async get(k) { return map.get(k) ?? null; },
		async set(k, v) { map.set(k, v); },
		async delete(k) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

vi.mock('@lo-fi/local-vault', () => ({
	connect: async ({ vaultID, addNewVault }) => {
		if (addNewVault) {
			const id = `vault-${vaults.size + 1}`;
			vaults.set(id, makeVault(id));
			return vaults.get(id);
		}
		return vaults.get(vaultID);
	},
	rawStorage: () => rawStore,
}));
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));
vi.mock('@/lib/data/collections', () => ({
	resetUserStorageCollection: () => {},
	getUserCardsCollection: () => ({ async preload() {}, get: () => undefined, get toArray() { return []; } }),
}));
vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async () => ({ txids: [] }),
	drainPendingWrites: () => {},
	stopDrainLoop: () => {},
}));
vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	upsertStorageRow: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
}));

const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');

const freshManager = () => {
	EncryptionManagerPQ.instance = null;
	return EncryptionManagerPQ.getInstance();
};

beforeEach(() => {
	vaults = new Map();
	const store = new Map();
	rawStore = {
		async get(k) { return store.get(k); },
		async set(k, v) { store.set(k, v); },
		async remove(k) { store.delete(k); },
	};
	_setReadCacheStorageForTests(makeStorage());
	_resetTouchedForTests();
	_setAcceptedSnapshotStorageForTests(makeStorage());
});

describe('EncryptionManagerPQ.logout(): per-account disk caches (§8.4)', () => {
	it('wipes the read-cache but leaves the durable accepted-snapshot base intact', async () => {
		await recordAccepted('dialog_messages', 'dmsg_1', { message_id: 'dmsg_1', owner_timestamp: 1 });
		await setCachedRow('user_cards', 'u_' + '1'.repeat(128), { user_hash: 'u_' + '1'.repeat(128) });

		const em = freshManager();
		await em.logout();

		expect(await getAccepted('dialog_messages', 'dmsg_1')).not.toBeNull();
		expect(await getCachedRow('user_cards', 'u_' + '1'.repeat(128))).toBeNull();
	});
});

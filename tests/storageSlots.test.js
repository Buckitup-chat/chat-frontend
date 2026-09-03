// Slot addressing end to end through EncryptionManagerPQ: which uuid does a
// profile or contacts write actually land on?
import { describe, it, expect, beforeEach, vi } from 'vitest';

let rows;          // uuid -> value_b64  (stand-in for the server + local KV)
let vaults;
let rawStore;

const makeVault = (id) => {
	const data = new Map();
	return { id, async set(k, v) { data.set(k, v); }, async get(k) { return data.get(k); } };
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
	sendMutationsAndAwaitShape: async () => ({ ok: true }),
	drainPendingWrites: async () => {},
}));
vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async (_userHash, uuid) =>
		rows.has(uuid) ? { uuid, value_b64: rows.get(uuid), deleted_flag: false } : null,
	upsertStorageRow: async ({ uuid, valueB64 }) => {
		rows.set(uuid, valueB64);
		return { sync: Promise.resolve({ status: 'synced' }) };
	},
}));

const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');

const login = async () => {
	const em = new EncryptionManagerPQ();
	await em.createUserVault({ name: 'Tester' });
	return em;
};

describe('user_storage slot addressing', () => {
	beforeEach(() => {
		rows = new Map();
		vaults = new Map();
		const store = new Map();
		rawStore = {
			async get(k) { return store.get(k); },
			async set(k, v) { store.set(k, v); },
			async remove(k) { store.delete(k); },
		};
	});

	// The defect: every account used to write its profile to the same
	// hardcoded uuid, so anyone could probe a stranger's user_hash for it.
	it('never writes to the old fixed addresses', async () => {
		const em = await login();
		await em.updateUserStorage({ name: 'A', notes: '', avatarUuid: null });
		await em.updateContacts([{ hash: 'x' }]);
		expect([...rows.keys()]).not.toContain('00000000-0000-4000-8000-000000000001');
		expect([...rows.keys()]).not.toContain('00000000-0000-4000-8000-000000000002');
	});

	it('gives two accounts different addresses for the same logical slot', async () => {
		const a = await login();
		await a.updateUserStorage({ name: 'A', notes: '', avatarUuid: null });
		const addressesA = [...rows.keys()];

		rows = new Map();
		const b = await login();
		await b.updateUserStorage({ name: 'B', notes: '', avatarUuid: null });
		expect([...rows.keys()]).not.toEqual(addressesA);
	});

	// Contacts live at a random address recorded in the root record's map, so
	// the round trip only works if the map is what resolves it.
	it('round-trips contacts through the slot map', async () => {
		const em = await login();
		await em.updateContacts([{ hash: 'peer-1' }]);
		expect(await em.loadContacts()).toEqual([{ hash: 'peer-1' }]);
	});

	it('reports no contacts for an account that never saved any', async () => {
		const em = await login();
		expect(await em.loadContacts()).toEqual([]);
	});

	// The root record holds the profile AND the slot map. Saving a profile
	// used to overwrite the whole record, which would strand every slot.
	it('keeps the contacts slot reachable after the profile is saved', async () => {
		const em = await login();
		await em.updateContacts([{ hash: 'peer-1' }]);
		await em.updateUserStorage({ name: 'Renamed', notes: 'n', avatarUuid: null });

		expect(await em.loadContacts()).toEqual([{ hash: 'peer-1' }]);
		expect(await em.loadUserProfile()).toMatchObject({ name: 'Renamed', notes: 'n' });
	});

	// Fresh device: the account exists but nothing has been stored yet, so
	// the root record has to be materialized before any slot can be recorded.
	it('creates the root record on the first profile read', async () => {
		const em = await login();
		rows = new Map();
		expect(await em.loadUserProfile()).toBe(null);
		expect(rows.size).toBe(1);
		// and it is usable straight away
		await em.updateContacts([{ hash: 'peer' }]);
		expect(await em.loadContacts()).toEqual([{ hash: 'peer' }]);
	});

	it('writes contacts once and reuses that address on later saves', async () => {
		const em = await login();
		await em.updateContacts([{ hash: 'a' }]);
		const afterFirst = [...rows.keys()].sort();
		await em.updateContacts([{ hash: 'a' }, { hash: 'b' }]);
		expect([...rows.keys()].sort()).toEqual(afterFirst);
		expect(await em.loadContacts()).toHaveLength(2);
	});
});

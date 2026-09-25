// Slot addressing end to end through EncryptionManagerPQ: which uuid does a
// profile or contacts write actually land on?
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { deriveVaultLocator } from '@/lib/pq/vaultEnvelope';

let rows;          // uuid -> value_b64, null once tombstoned  (stand-in for the server + local KV)
let vaults;
let rawStore;
let refuseTombstones; // the server rejecting deletions, as it may any write
let onRowWritten;     // hook run after each write; a test switches accounts from it

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
const kv = new Map();
vi.mock('@/lib/data/localStore', () => ({
	kvGet: async (k) => kv.get(k),
	kvSet: async (k, v) => { kv.set(k, v); },
	kvDelete: async (k) => { kv.delete(k); },
}));
vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async () => ({ outboxId: 'test-outbox-id', phase: 'accepted', result: { ok: true }, acceptance: Promise.resolve({ kind: 'accepted' }) }),
	drainPendingWrites: async () => {},
	stopDrainLoop: () => {},
}));
vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async (_userHash, uuid) =>
		rows.has(uuid) ? { uuid, value_b64: rows.get(uuid), deleted_flag: rows.get(uuid) === null } : null,
	putStorageRow: async ({ uuid, valueB64, deletedFlag }) => {
		if (deletedFlag && refuseTombstones) throw new Error('rejected');
		rows.set(uuid, deletedFlag ? null : valueB64);
		await onRowWritten?.(uuid);
		return { uuid, value_b64: valueB64 };
	},
	// The real merge, so the fake lands a patch on its base the way the
	// materializer does (slot map and vault list included).
	putStorageJsonPatch: async ({ uuid, jsonPatch }) => {
		const { _getStorageJsonCodecForTests, mergeJsonPatch, stripPatchDirectives } = await import('@/lib/data/storageIntent');
		const codec = _getStorageJsonCodecForTests();
		const existing = rows.get(uuid) ? await codec.decrypt(rows.get(uuid)) : null;
		const { valueB64 } = await codec.encrypt(stripPatchDirectives(mergeJsonPatch(existing, jsonPatch)));
		rows.set(uuid, valueB64);
		await onRowWritten?.(uuid);
		return { uuid, value_b64: valueB64 };
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
		kv.clear();
		refuseTombstones = false;
		onRowWritten = null;
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

	// Reading must not write. On a second device the shape has not delivered
	// the existing row yet, so an empty root written here would carry a fresh
	// owner_timestamp and beat the real profile under last-write-wins —
	// silently destroying it.
	it('creates nothing when the profile is read on an account that has none', async () => {
		const em = await login();
		rows = new Map();
		expect(await em.loadUserProfile()).toBe(null);
		expect(rows.size).toBe(0);
	});

	it('creates the root record on the write path instead', async () => {
		const em = await login();
		rows = new Map();
		await em.updateContacts([{ hash: 'peer' }]);
		// the contacts row and the root record holding its address
		expect(rows.size).toBe(2);
		expect(await em.loadContacts()).toEqual([{ hash: 'peer' }]);
	});

	// EncryptionManagerPQ is a singleton, so the resolver cache outlives a
	// session. Signing in as someone else without logging out first must not
	// resolve this account's slot names against the previous account's
	// addresses — that would write contacts into a stranger's row.
	it('does not carry slot addresses across an account switch', async () => {
		const first = await login();
		await first.updateContacts([{ hash: 'first-peer' }]);
		const firstAddresses = new Set(rows.keys());

		rows = new Map();
		const second = await login();
		await second.updateContacts([{ hash: 'second-peer' }]);

		for (const uuid of rows.keys()) expect(firstAddresses.has(uuid)).toBe(false);
		expect(await second.loadContacts()).toEqual([{ hash: 'second-peer' }]);
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

describe('the recovery vault', () => {
	const key = () => crypto.getRandomValues(new Uint8Array(32));
	const at = (s) => rows.get(deriveVaultLocator(s));

	it('lands at the address the key derives, and the next backup retires it', async () => {
		const em = await login();
		const s1 = key();
		await em.publishRecoveryVault(s1, '{"v":1}');
		expect(at(s1)).toBeTruthy();
		expect(at(s1)).not.toContain('"v":1');

		const s2 = key();
		await em.publishRecoveryVault(s2, '{"v":2}');
		expect(at(s1)).toBeNull();
		expect(at(s2)).toBeTruthy();
	});

	it('keeps a vault it could not retire on the list and retries it next time', async () => {
		const em = await login();
		const s1 = key();
		await em.publishRecoveryVault(s1, '{}');

		refuseTombstones = true;
		await expect(em.publishRecoveryVault(key(), '{}')).rejects.toThrow(/could not be retired/);
		expect(at(s1)).toBeTruthy();

		refuseTombstones = false;
		await em.publishRecoveryVault(key(), '{}');
		expect(at(s1)).toBeNull();
	});

	it('does not patch a root record it cannot read', async () => {
		const em = await login();
		await em.updateUserStorage({ name: 'A', notes: '', avatarUuid: null });
		// Every row of the account, the root among them, replaced by bytes
		// that decrypt to nothing.
		const before = [...rows.keys()];
		for (const uuid of before) rows.set(uuid, 'bm90IGEgcmVjb3Jk');
		await expect(em.publishRecoveryVault(key(), '{}')).rejects.toThrow(/cannot be read/);
		for (const uuid of before) expect(rows.get(uuid)).toBe('bm90IGEgcmVjb3Jk');
	});

	it('refuses to finish under an account other than the one it started with', async () => {
		const em = await login();
		onRowWritten = async () => {
			onRowWritten = null;
			await em.logout();
			await em.createUserVault({ name: 'Other' });
		};
		await expect(em.publishRecoveryVault(key(), '{}')).rejects.toThrow(/account changed/);
	});
});

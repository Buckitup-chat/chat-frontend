import { describe, it, expect, beforeEach, vi } from 'vitest';

let rows;
let vaults;
let rawStore;
let upsertCalls;

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
	sendMutationsAndAwaitShape: async () => ({ outboxId: 'test-outbox-id', phase: 'accepted', result: { ok: true }, acceptance: Promise.resolve({ kind: 'accepted' }) }),
	drainPendingWrites: async () => {},
	stopDrainLoop: () => {},
}));
vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async (_userHash, uuid) =>
		rows.has(uuid) ? { uuid, value_b64: rows.get(uuid).valueB64, deleted_flag: rows.get(uuid).deletedFlag ?? false } : null,
	upsertStorageRow: async ({ uuid, valueB64, deletedFlag }) => {
		rows.set(uuid, { valueB64, deletedFlag: !!deletedFlag });
		upsertCalls.push({ uuid, valueB64, deletedFlag: !!deletedFlag });
		return { sync: Promise.resolve({ status: 'synced' }) };
	},
}));

const WINNER_UUID = 'uuid-from-the-device-that-won-the-race';
let resolvedUuid = null;

vi.mock('@/lib/data/slots', () => ({
	createSlotResolver: () => ({
		getSlotUuid: async (name) => (name === 'contacts' ? resolvedUuid : null),
		requireSlotUuid: async (name) => {
			if (name === 'contacts' && resolvedUuid) return resolvedUuid;
			throw new Error(`user_storage slot "${name}" is missing from the root record`);
		},
		ensureSlotUuid: async (_name, { mint, writeRow }) => {
			const mine = mint();
			await writeRow(mine);
			resolvedUuid = WINNER_UUID;
			return { uuid: WINNER_UUID, created: false, orphaned: mine };
		},
		reset: () => {},
	}),
}));

const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');

const login = async () => {
	const em = new EncryptionManagerPQ();
	await em.createUserVault({ name: 'Tester' });
	return em;
};

describe('slot creation race (§4.7): EncryptionManagerPQ acts on an orphaned slot', () => {
	beforeEach(() => {
		rows = new Map();
		vaults = new Map();
		upsertCalls = [];
		resolvedUuid = null;
		const store = new Map();
		rawStore = {
			async get(k) { return store.get(k); },
			async set(k, v) { store.set(k, v); },
			async remove(k) { store.delete(k); },
		};
	});

	it('tombstones its own minted row once the map race is lost', async () => {
		const em = await login();
		upsertCalls = [];

		await em.updateContacts([{ hash: 'mine' }]);

		const mineUuid = upsertCalls[0].uuid;
		expect(mineUuid).not.toBe(WINNER_UUID);

		const tombstone = upsertCalls.find((c) => c.uuid === mineUuid && c.deletedFlag);
		expect(tombstone).toBeTruthy();
		expect(rows.get(mineUuid).deletedFlag).toBe(true);
	});

	it('resolves later reads through the winner, not its own mint', async () => {
		const em = await login();
		upsertCalls = [];
		await em.updateContacts([{ hash: 'mine' }]);

		expect(await em.loadContacts()).toEqual([{ hash: 'mine' }]);
		expect(rows.has(WINNER_UUID)).toBe(true);
	});
});

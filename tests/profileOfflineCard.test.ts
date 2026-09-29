// Saving the profile with no connection, through the real manager: the save
// completes on this device, reports that the server does not have it yet,
// renames the account locally, and leaves the card publication in the outbox
// — which sends it once the connection is back.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _setStorageForTests as setOutboxStorage, _setLeaderForTests, pendingEntries, stopDrainLoop } from '@/lib/data/outbox';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';

const makeMemoryStore = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const makeVault = (id: string) => {
	const data = new Map<string, unknown>();
	return { id, async set(k: string, v: unknown) { data.set(k, v); }, async get(k: string) { return data.get(k); } };
};

let vaults: Map<string, ReturnType<typeof makeVault>>;
let rawStore: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void>; remove: (k: string) => Promise<void> };
let cardRows: Map<string, Record<string, unknown>>;
let serverCards: Set<string> | null;

vi.mock('@lo-fi/local-vault', () => ({
	connect: async ({ vaultID, addNewVault }: { vaultID?: string; addNewVault?: boolean }) => {
		if (addNewVault) {
			const id = `vault-${vaults.size + 1}`;
			vaults.set(id, makeVault(id));
			return vaults.get(id);
		}
		return vaults.get(vaultID as string);
	},
	rawStorage: () => rawStore,
}));
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));

vi.mock('@/lib/data/collections', () => ({
	resetUserStorageCollection: () => {},
	getUserCardsCollection: () => ({
		async preload() {},
		get: (k: string) => cardRows.get(k),
		get toArray() { return [...cardRows.values()]; },
	}),
}));

vi.mock('@/lib/data/shapeRead', () => ({
	readShapeOnce: async (table: string, where: string) => {
		if (table !== 'user_cards') return [];
		if (serverCards === null) throw new Error('offline');
		const hash = /user_hash='([^']+)'/.exec(where)![1];
		return serverCards.has(hash) ? [{ user_hash: hash }] : [];
	},
}));

// The root record's own offline behaviour is pinned in profileOfflineSave;
// here it answers as that module does with no connection.
let rootStatus: 'synced' | 'queued' = 'synced';
vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	putStorageRow: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	putStorageJsonPatch: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	saveStorageJsonPatch: async () => rootStatus,
}));

let online = true;
let sent: Array<{ type: string; syncMetadata: { relation: string } }>;
vi.mock('@/api/client', async () => {
	const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
	return {
		api: {
			...actual.api,
			ingestWithAuthEach: async (mutations: Array<{ type: string; syncMetadata: { relation: string }; modified?: { user_hash: string }; changes?: { user_hash: string } }>) => {
				if (!online) throw new TypeError('Failed to fetch');
				for (const m of mutations) {
					sent.push(m);
					if (m.syncMetadata.relation === 'user_cards') serverCards?.add((m.modified ?? m.changes)!.user_hash);
				}
				return {
					status: 200,
					json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
				} as unknown as Response;
			},
		},
	};
});

const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');
const { drainPendingWrites } = await import('@/lib/data/ingest');

interface TestManager {
	createUserVault(opts: { name: string }): Promise<unknown>;
	getLocalUserCards(): Promise<Array<{ name: string; user_hash: string }>>;
	updateUserStorage(p: { name?: string; notes?: string; avatarUuid?: string | null }): Promise<{ pending: boolean }>;
	pushCurrentUserCard(): Promise<string>;
}

const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
	vaults = new Map();
	cardRows = new Map();
	serverCards = new Set();
	sent = [];
	online = true;
	rootStatus = 'synced';
	const store = new Map<string, unknown>();
	rawStore = {
		async get(k) { return store.get(k); },
		async set(k, v) { store.set(k, v); },
		async remove(k) { store.delete(k); },
	};
	setOutboxStorage(makeMemoryStore());
	_setAcceptedSnapshotStorageForTests(makeMemoryStore());
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
});

const createAccount = async () => {
	EncryptionManagerPQ.instance = null;
	const em = EncryptionManagerPQ.getInstance() as unknown as TestManager;
	await em.createUserVault({ name: 'Tester' });
	await settle();
	const userHash = (await em.getLocalUserCards())[0].user_hash;
	sent = [];
	return { em, userHash };
};

describe('saving the profile with no connection', () => {
	it('completes on this device, renames the account here, and says the server does not have it yet', async () => {
		const { em, userHash } = await createAccount();
		online = false;
		serverCards = null;
		rootStatus = 'queued';

		const saved = await em.updateUserStorage({ name: 'Renamed', notes: '', avatarUuid: null });

		expect(saved.pending).toBe(true);
		// Published with the save: the store must not publish it a second time.
		expect((saved as { cardPublished?: boolean }).cardPublished).toBe(true);
		expect((await em.getLocalUserCards()).find((c) => c.user_hash === userHash)?.name).toBe('Renamed');
		expect((await pendingEntries(userHash)).map((e) => e.relation)).toContain('user_cards');
	});

	it('sends the queued card once the connection is back', async () => {
		const { em, userHash } = await createAccount();
		online = false;
		serverCards = null;
		rootStatus = 'queued';
		await em.updateUserStorage({ name: 'Renamed', notes: '', avatarUuid: null });

		online = true;
		serverCards = new Set([userHash]);
		// The signing key is the vault's; the manager hands it to the drain on login.
		const signSkey = (vaults.values().next().value as ReturnType<typeof makeVault>);
		drainPendingWrites(userHash, (await signSkey.get('sign_skey')) as Uint8Array);
		await vi.waitFor(() => expect(sent.filter((m) => m.syncMetadata.relation === 'user_cards')).toHaveLength(1));
		await vi.waitFor(async () => expect(await pendingEntries(userHash)).toHaveLength(0));
	});

	it('republishing the card with no connection is queued, not an error', async () => {
		const { em } = await createAccount();
		online = false;
		serverCards = null;

		await expect(em.pushCurrentUserCard()).resolves.toBe('queued');
	});

	it('online, a save is complete and not pending', async () => {
		const { em } = await createAccount();

		const saved = await em.updateUserStorage({ name: 'Renamed', notes: '', avatarUuid: null });

		expect(saved.pending).toBe(false);
	});
});

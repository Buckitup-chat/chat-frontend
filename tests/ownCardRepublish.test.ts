import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _setStorageForTests as setOutboxStorage, _setLeaderForTests, stopDrainLoop } from '@/lib/data/outbox';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setIntentStorageForTests } from '@/lib/data/intents';
import { withCardLock } from '@/lib/data/userCardIntent';

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
	return {
		id,
		async set(k: string, v: unknown) { data.set(k, v); },
		async get(k: string) { return data.get(k); },
	};
};

let vaults: Map<string, ReturnType<typeof makeVault>>;
let rawStore: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void>; remove: (k: string) => Promise<void> };
let cardRows: Map<string, Record<string, unknown>>;

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

vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	putStorageRow: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	putStorageJsonPatch: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	saveStorageJsonPatch: async () => 'synced',
}));

type Sent = { type: string; syncMetadata: { relation: string } };
let sent: Sent[];

vi.mock('@/api/client', async () => {
	const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
	return {
		api: {
			...actual.api,
			ingestWithAuthEach: async (mutations: Sent[]) => {
				sent.push(...mutations);
				return {
					status: 200,
					json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
				} as unknown as Response;
			},
		},
	};
});

const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');

interface TestManager {
	createUserVault(opts: { name: string }): Promise<unknown>;
	updateOwnUserCardName(name: string): Promise<unknown>;
	getLocalUserCards(): Promise<Array<{ name: string; user_hash: string }>>;
	login(userHash: string): Promise<unknown>;
}

const freshManager = (): TestManager => {
	EncryptionManagerPQ.instance = null;
	return EncryptionManagerPQ.getInstance() as unknown as TestManager;
};

const cardWrites = () => sent.filter((m) => m.syncMetadata.relation === 'user_cards').map((m) => m.type);

beforeEach(() => {
	vaults = new Map();
	cardRows = new Map();
	sent = [];
	const store = new Map<string, unknown>();
	rawStore = {
		async get(k) { return store.get(k); },
		async set(k, v) { store.set(k, v); },
		async remove(k) { store.delete(k); },
	};
	setOutboxStorage(makeMemoryStore());
	_setAcceptedSnapshotStorageForTests(makeMemoryStore());
	_setIntentStorageForTests(makeMemoryStore());
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
});

const createAccount = async () => {
	const em = freshManager();
	await em.createUserVault({ name: 'Tester' });
	const userHash = (await em.getLocalUserCards())[0].user_hash;
	return { em, userHash };
};

const cardWritesSettled = (userHash: string) => withCardLock(userHash, async () => {});

describe('the own card is published once per change', () => {
	it('registration inserts once, and the sign-in that follows publishes nothing more', async () => {
		const { em, userHash } = await createAccount();
		expect(cardWrites()).toEqual(['insert']);

		await em.login(userHash);
		await cardWritesSettled(userHash);

		expect(cardWrites()).toEqual(['insert']);
	});

	it('a sign-in does not republish, even when the card shape does not show the card', async () => {
		const { em, userHash } = await createAccount();
		cardRows.clear();
		sent = [];

		await em.login(userHash);
		await cardWritesSettled(userHash);

		expect(cardWrites()).toEqual([]);
	});

	it('a rename is one update: no shape read decides insert or update, and nothing is sent twice', async () => {
		const { em, userHash } = await createAccount();
		cardRows.clear();
		sent = [];

		await em.updateOwnUserCardName('Renamed');
		await cardWritesSettled(userHash);

		expect(cardWrites()).toEqual(['update']);
	});
});

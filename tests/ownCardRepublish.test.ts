import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _setStorageForTests as setOutboxStorage, _setLeaderForTests } from '@/lib/data/outbox';
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
	return {
		id,
		async set(k: string, v: unknown) { data.set(k, v); },
		async get(k: string) { return data.get(k); },
	};
};

let vaults: Map<string, ReturnType<typeof makeVault>>;
let rawStore: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void>; remove: (k: string) => Promise<void> };
let cardRows: Map<string, Record<string, unknown>>;
// What the server really holds, as readShapeOnce reports it. Independent of
// the local collection on purpose: the two disagree after a server wipe.
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

vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	putStorageRow: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	putStorageJsonPatch: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
}));

let ingestImpl: (mutations: unknown[]) => Promise<Response>;
vi.mock('@/api/client', async () => {
	const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
	return {
		api: {
			...actual.api,
			ingestWithAuthEach: async (mutations: unknown[]) => ingestImpl(mutations),
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

type Sent = { type: string; syncMetadata: { relation: string } };

const freshManager = (): TestManager => {
	EncryptionManagerPQ.instance = null;
	return EncryptionManagerPQ.getInstance() as unknown as TestManager;
};

let sent: Sent[];

// Accepts everything and, like the server, stores accepted cards.
const serverIngest = async (mutations: unknown[]) => {
	for (const m of mutations as Array<Sent & { modified?: { user_hash: string }; changes?: { user_hash: string } }>) {
		sent.push(m);
		if (m.syncMetadata.relation === 'user_cards') serverCards?.add((m.modified ?? m.changes)!.user_hash);
	}
	return {
		status: 200,
		json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
	} as unknown as Response;
};

const cardWrites = () => sent.filter((m) => m.syncMetadata.relation === 'user_cards').map((m) => m.type);

// login() republishes in the background; let it run to completion.
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
	vaults = new Map();
	cardRows = new Map();
	serverCards = new Set();
	sent = [];
	const store = new Map<string, unknown>();
	rawStore = {
		async get(k) { return store.get(k); },
		async set(k, v) { store.set(k, v); },
		async remove(k) { store.delete(k); },
	};
	setOutboxStorage(makeMemoryStore());
	_setAcceptedSnapshotStorageForTests(makeMemoryStore());
	ingestImpl = serverIngest;
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
});

const createAccount = async () => {
	const em = freshManager();
	await em.createUserVault({ name: 'Tester' });
	await settle();
	const userHash = (await em.getLocalUserCards())[0].user_hash;
	sent = [];
	return { em, userHash };
};

describe('own user card survives the server forgetting it', () => {
	it('registration inserts once; the login that follows sees the card and sends nothing more', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });
		await settle();

		expect(cardWrites()).toEqual(['insert']);
	});

	it('login republishes a card the server no longer has, as an insert', async () => {
		const { em, userHash } = await createAccount();
		serverCards!.clear();

		await em.login(userHash);
		await settle();

		expect(cardWrites()).toEqual(['insert']);
		expect(serverCards!.has(userHash)).toBe(true);
	});

	it('login leaves a card the server still has alone', async () => {
		const { em, userHash } = await createAccount();

		await em.login(userHash);
		await settle();

		expect(cardWrites()).toEqual([]);
	});

	it('login does not guess when the server cannot be asked', async () => {
		const { em, userHash } = await createAccount();
		serverCards = null;

		await em.login(userHash);
		await settle();

		expect(cardWrites()).toEqual([]);
	});

	it('a rename after the server lost the card inserts instead of sending a rejected update', async () => {
		const { em, userHash } = await createAccount();
		serverCards!.delete(userHash);

		await em.updateOwnUserCardName('Renamed');

		expect(cardWrites()).toEqual(['insert']);
	});

	it('a rename of a card the server has is an update', async () => {
		const { em } = await createAccount();

		await em.updateOwnUserCardName('Renamed');

		expect(cardWrites()).toEqual(['update']);
	});

	it('when the server cannot be asked, a rename falls back to an update', async () => {
		const { em } = await createAccount();
		serverCards = null;

		await em.updateOwnUserCardName('Renamed');

		expect(cardWrites()).toEqual(['update']);
	});
});

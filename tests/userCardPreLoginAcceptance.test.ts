import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _setStorageForTests as setOutboxStorage, currentSessionUserHash } from '@/lib/data/outbox';
import { getAccepted, _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';

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
	upsertStorageRow: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
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
}

const freshManager = (): TestManager => {
	EncryptionManagerPQ.instance = null;
	return EncryptionManagerPQ.getInstance() as unknown as TestManager;
};

const acceptEverything = async (mutations: unknown[]) => ({
	status: 200,
	json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
}) as unknown as Response;

beforeEach(() => {
	vaults = new Map();
	cardRows = new Map();
	const store = new Map<string, unknown>();
	rawStore = {
		async get(k) { return store.get(k); },
		async set(k, v) { store.set(k, v); },
		async remove(k) { store.delete(k); },
	};
	setOutboxStorage(makeMemoryStore());
	_setAcceptedSnapshotStorageForTests(makeMemoryStore());
	ingestImpl = acceptEverything;
});

describe('pre-login user_cards acceptance is recorded through the real coordinator (L17-01/R4)', () => {
	it('an account created before any session exists still gets its card accepted-snapshot recorded', async () => {
		const em = freshManager();
		expect(currentSessionUserHash()).toBeNull();

		await em.createUserVault({ name: 'Tester' });

		const userHash = (await em.getLocalUserCards())[0].user_hash;
		const accepted = await getAccepted('user_cards', userHash);

		expect(accepted).toBeTruthy();
		expect(accepted!.name).toBe('Tester');
		expect(cardRows.size).toBe(0);
	});

	it('an update issued right after creation gets a timestamp strictly greater than the accepted insert, even though the shape is still stale', async () => {
		const em = freshManager();
		await em.createUserVault({ name: 'Tester' });

		const userHash = (await em.getLocalUserCards())[0].user_hash;
		const insertAccepted = await getAccepted('user_cards', userHash);

		let updateTimestamp: number | null = null;
		const baseIngest = ingestImpl;
		ingestImpl = async (mutations) => {
			const m = mutations[0] as { changes?: { owner_timestamp: number } };
			updateTimestamp = m.changes!.owner_timestamp;
			return baseIngest(mutations);
		};

		await em.updateOwnUserCardName('Renamed');

		expect(updateTimestamp).not.toBeNull();
		expect(updateTimestamp as unknown as number).toBeGreaterThan(insertAccepted!.owner_timestamp as number);
		expect(cardRows.size).toBe(0);
	});

	it('a second account (B) cannot read or overwrite account A\'s accepted snapshot', async () => {
		const emA = freshManager();
		await emA.createUserVault({ name: 'Alice' });
		const hashA = (await emA.getLocalUserCards()).find((c: { name: string; user_hash: string }) => c.name === 'Alice')!.user_hash;

		const emB = freshManager();
		await emB.createUserVault({ name: 'Bob' });
		const hashB = (await emB.getLocalUserCards()).find((c: { name: string; user_hash: string }) => c.name === 'Bob')!.user_hash;

		expect(hashA).not.toBe(hashB);
		const acceptedA = await getAccepted('user_cards', hashA);
		const acceptedB = await getAccepted('user_cards', hashB);

		expect(acceptedA!.name).toBe('Alice');
		expect(acceptedB!.name).toBe('Bob');
		expect(acceptedA!.user_hash).toBe(hashA);
		expect(acceptedB!.user_hash).toBe(hashB);
	});

	it('a late acceptance for A, arriving after the session has switched to B, does not resurrect A into B\'s accepted snapshot', async () => {
		const emA = freshManager();
		let resolveA: (() => void) | null = null;
		const baseIngest = ingestImpl;
		ingestImpl = async (mutations) => {
			await new Promise<void>((r) => { resolveA = r; });
			return baseIngest(mutations);
		};

		const createA = emA.createUserVault({ name: 'Alice' });
		await vi.waitFor(() => expect(resolveA).not.toBeNull());

		ingestImpl = acceptEverything;
		const emB = freshManager();
		await emB.createUserVault({ name: 'Bob' });
		const hashB = (await emB.getLocalUserCards()).find((c: { name: string; user_hash: string }) => c.name === 'Bob')!.user_hash;
		expect(currentSessionUserHash()).toBe(hashB);
		const acceptedBBefore = await getAccepted('user_cards', hashB);
		expect(acceptedBBefore!.name).toBe('Bob');

		resolveA!();
		await createA;
		const hashA = (await emA.getLocalUserCards()).find((c: { name: string; user_hash: string }) => c.name === 'Alice')!.user_hash;

		const acceptedA = await getAccepted('user_cards', hashA);
		const acceptedBAfter = await getAccepted('user_cards', hashB);
		expect(acceptedA!.name).toBe('Alice');
		expect(acceptedBAfter!.name).toBe('Bob');
		expect(acceptedBAfter).toEqual(acceptedBBefore);
	});
});

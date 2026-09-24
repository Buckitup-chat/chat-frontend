import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);
const C = 'u_' + 'c'.repeat(128);

const keyMaterialFor = (userHash: string) =>
	(userHash === A ? '11' : userHash === B ? '22' : '33').repeat(16);

let ambientUserHash: string | null = null;
const postExportFlips: string[] = [];

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() { return ambientUserHash; },
			exportVaultKeys: async () => {
				const resultFor = ambientUserHash;
				const material = { sign_skey: 'AAAA', crypt_skey: btoa(keyMaterialFor(resultFor!)), evm_skey: 'cc' };
				if (postExportFlips.length) ambientUserHash = postExportFlips.shift()!;
				return material;
			},
		}),
	},
}));

const collection = {
	rows: new Map<string, unknown>(),
	preload: vi.fn(async () => {}),
	get: vi.fn((k: string) => collection.rows.get(k)),
};
vi.mock('@/lib/data/collections', () => ({
	getUserStorageCollection: () => collection,
}));

let sent: unknown[][] = [];
vi.mock('@/api/client', () => ({
	api: {
		createStorageMutation: (
			userHash: string, uuid: string, valueB64: string, _h: unknown, _v: unknown,
			ownerTimestamp: number, _sk: unknown, _d: unknown, deletedFlag: boolean,
			parentSignHash: string | null, _sh: unknown, _sb: unknown, mutationType: string
		) => ({
			type: mutationType,
			[mutationType === 'insert' ? 'modified' : 'changes']: {
				user_hash: userHash, uuid, value_b64: valueB64, deleted_flag: deletedFlag,
				owner_timestamp: ownerTimestamp, parent_sign_hash: parentSignHash,
				sign_hash: null, sign_b64: 'sig',
			},
			syncMetadata: { relation: 'user_storage' },
		}),
		ingestWithAuthEach: async (mutations: unknown[]) => {
			sent.push(mutations);
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		},
	},
}));

const { kvGet, kvSet, _setRawStoreForTests } = await import('@/lib/data/localStore');
const { clearLocalStorageKey } = await import('@/lib/data/localCrypto');
const { upsertStorageRow, getStorageSyncStatus } = await import('@/lib/data/userStorage');
const {
	_setStorageForTests, _setLeaderForTests, stopDrainLoop,
	startLeaderElection, stopLeaderElection,
} = await import('@/lib/data/outbox');
const { _setIntentStorageForTests, _clearIntentsForTests, intentsOf } = await import('@/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

let raw: ReturnType<typeof makeStorage>;

beforeEach(async () => {
	ambientUserHash = null;
	postExportFlips.length = 0;
	clearLocalStorageKey();
	raw = makeStorage();
	_setRawStoreForTests(raw);
	sent = [];
	collection.rows.clear();
	_setStorageForTests(makeStorage());
	_setIntentStorageForTests(makeStorage());
	await _clearIntentsForTests();
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
	stopLeaderElection();
});

describe('localStore.ts kvSet: owner-pinned write against a real encrypted store', () => {
	const KEY = `us|${A}|00000000-0000-4000-8000-000000000001`;
	const entry = { row: { user_hash: A, uuid: '00000000-0000-4000-8000-000000000001', value_b64: 'v', owner_timestamp: 1 }, hash_b64: null, syncStatus: 'syncing' };

	it('throws instead of silently encrypting under B, when the account switches strictly inside its own key derivation', async () => {
		ambientUserHash = A;
		postExportFlips.push(B);

		await expect(kvSet(KEY, entry, A)).rejects.toThrow(/no longer matches the pinned owner/);

		expect(raw.map.size).toBe(0);

		ambientUserHash = A;
		expect(await kvGet(KEY)).toBeUndefined();
		ambientUserHash = B;
		expect(await kvGet(KEY)).toBeUndefined();
	});

	it('a pinned write with no account switch at all behaves exactly like the unpinned path', async () => {
		ambientUserHash = A;
		await kvSet(KEY, entry, A);
		ambientUserHash = A;
		expect(await kvGet(KEY)).toEqual(entry);
	});
});

describe('upsertStorageRow: the owner-pinned kvSet closes the race end-to-end (§ cross-account race in kvSet)', () => {
	const SLOT = '85da8ea0-5bc8-856e-83e7-db7b542a1a58';
	const signSkey = new Uint8Array(32).fill(7);

	it('an account switch strictly inside the durable write\'s own key derivation blocks the projection, fails the call instead of resolving synced/failed, leaves the durable intent recoverable, and never breaks A\'s next write', async () => {
		startLeaderElection(A, () => {});
		ambientUserHash = B;
		postExportFlips.push(A, C);

		const call = upsertStorageRow({ userHash: A, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });

		await expect(call).rejects.toThrow(/no longer matches the pinned owner/);

		expect(await getStorageSyncStatus(A, SLOT)).toBeNull();
		expect(raw.map.size).toBe(0);

		expect(sent).toHaveLength(0);

		const afterFailure = await intentsOf(A);
		expect(afterFailure.entries).toHaveLength(1);
		expect((afterFailure.entries[0].intent as { kind: string }).kind).toBe('storage');

		ambientUserHash = A;
		postExportFlips.length = 0;
		const retry = await upsertStorageRow({ userHash: A, uuid: SLOT, valueB64: 'v2', hashB64: null, signSkey });
		const sync = await retry.sync;
		expect(sync.status).toBe('synced');
		expect(sent).toHaveLength(1);
		expect(await getStorageSyncStatus(A, SLOT)).toBe('synced');

		const afterRetry = await intentsOf(A);
		expect(afterRetry.entries).toHaveLength(0);
	});
});

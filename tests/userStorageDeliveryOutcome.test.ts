import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const USER = 'u_' + 'a'.repeat(128);
const SLOT = '85da8ea0-5bc8-856e-83e7-db7b542a1a58';
const signSkey = new Uint8Array(32).fill(7);

const kv = new Map<string, unknown>();
vi.mock('@/lib/data/localStore', () => ({
	kvGet: vi.fn(async (k: string) => kv.get(k)),
	kvSet: vi.fn(async (k: string, v: unknown) => { kv.set(k, v); }),
	kvDelete: vi.fn(async (k: string) => { kv.delete(k); }),
}));

const collection = {
	rows: new Map<string, unknown>(),
	preload: vi.fn(async () => {}),
	get: vi.fn((k: string) => collection.rows.get(k)),
};
vi.mock('@/lib/data/collections', () => ({
	getUserStorageCollection: () => collection,
}));

let sent: unknown[] = [];
vi.mock('@/api/client', () => ({
	api: {
		createStorageMutation: (userHash: string, uuid: string, valueB64: string, _h: unknown, _v: unknown, ownerTimestamp: number, _sk: unknown, _d: unknown, deletedFlag: boolean, parentSignHash: string | null, _sh: unknown, _sb: unknown, mutationType: string) => ({
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

const { upsertStorageRow, getStorageSyncStatus } = await import('@/lib/data/userStorage');
const { _setStorageForTests, _setLeaderForTests, stopDrainLoop, quarantinedEntries, discardEntry } = await import('@/lib/data/outbox');

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

beforeEach(() => {
	kv.clear();
	collection.rows.clear();
	sent = [];
	_setStorageForTests(makeStorage());
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
});

describe('userStorage: synced means exact acceptance, not durable queueing (L17-01)', () => {
	it('a follower-tab write stays syncing (not synced) while acceptance is unknown, and only flips once actually accepted', async () => {
		_setLeaderForTests(false);

		const resultPromise = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });

		await new Promise((r) => setTimeout(r, 30));
		expect(sent).toHaveLength(0);
		expect(await getStorageSyncStatus(USER, SLOT)).not.toBe('synced');

		_setLeaderForTests(true);
		const { drainPendingWrites } = await import('@/lib/data/ingest');
		drainPendingWrites(USER, signSkey);

		const res = await resultPromise;
		const sync = await res.sync;
		expect(sync.status).toBe('synced');
		expect(sent).toHaveLength(1); 
	});

	it('a leader-tab write with real HTTP acceptance sets synced', async () => {
		_setLeaderForTests(true);

		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });

		expect(sent).toHaveLength(1);
		const sync = await res.sync;
		expect(sync.status).toBe('synced');
		expect(await getStorageSyncStatus(USER, SLOT)).toBe('synced');
	});

	it('a permanent rejection never sets synced', async () => {
		_setLeaderForTests(true);
		const apiModule = await import('@/api/client');
		const spy = vi.spyOn(apiModule.api, 'ingestWithAuthEach').mockImplementationOnce(async (mutations: unknown[]) => ({
			status: 422,
			json: async () => ({
				results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed', details: {} })),
			}),
		}) as unknown as Response);

		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });

		const sync = await res.sync;
		expect(sync.status).toBe('failed');
		expect(await getStorageSyncStatus(USER, SLOT)).toBe('failed');
		expect(await quarantinedEntries(USER)).toHaveLength(1);
		spy.mockRestore();
	});

	it('a pending (not-yet-synced) local row never wins as the accepted trusted base for the next write', async () => {
		_setLeaderForTests(true);
		const apiModule = await import('@/api/client');
		const spy = vi.spyOn(apiModule.api, 'ingestWithAuthEach').mockImplementationOnce(async (mutations: unknown[]) => ({
			status: 422,
			json: async () => ({
				results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed', details: {} })),
			}),
		}) as unknown as Response);
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey }); // ends up 'failed', not 'synced'
		spy.mockRestore();
		expect(await getStorageSyncStatus(USER, SLOT)).toBe('failed');
		const [firstEntry] = await quarantinedEntries(USER);
		await discardEntry(firstEntry.id);

		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v2', hashB64: null, signSkey });

		const lastSent = sent.at(-1) as [{ type: string }];
		expect(lastSent[0].type).toBe('insert');
	});
});

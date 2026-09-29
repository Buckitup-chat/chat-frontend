// A profile edit made with no connection is saved on this device: it is
// queued, not failed, it is what the device shows after a reload, and the
// outbox delivers it once the connection is back. Only a refusal by the
// server is a failed save.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const USER = 'u_' + 'a'.repeat(128);
const ROOT = 'root-0000-0000-0000-000000000000';
const signSkey = new Uint8Array(32).fill(7);

const kv = new Map<string, unknown>();
vi.mock('@/lib/data/localStore', () => ({
	kvGet: vi.fn(async (k: string) => kv.get(k)),
	kvSet: vi.fn(async (k: string, v: unknown) => { kv.set(k, v); }),
	kvDelete: vi.fn(async (k: string) => { kv.delete(k); }),
}));

let online = true;
const collection = {
	rows: new Map<string, unknown>(),
	preload: vi.fn(async () => { if (!online) throw new Error('shape unreachable'); }),
	get: vi.fn((k: string) => collection.rows.get(k)),
};
vi.mock('@/lib/data/collections', () => ({
	getUserStorageCollection: () => collection,
}));

type Row = { uuid: string; value_b64: string; owner_timestamp: number; parent_sign_hash: string | null };
let sent: Row[] = [];
let refuse = false;
vi.mock('@/api/client', () => ({
	api: {
		createStorageMutation: (userHash: string, uuid: string, valueB64: string, _h: unknown, _v: unknown, ownerTimestamp: number, _sk: unknown, _d: unknown, deletedFlag: boolean, parentSignHash: string | null, _sh: unknown, _sb: unknown, mutationType: string) => ({
			type: mutationType,
			[mutationType === 'insert' ? 'modified' : 'changes']: {
				user_hash: userHash, uuid, value_b64: valueB64, deleted_flag: deletedFlag,
				owner_timestamp: ownerTimestamp, parent_sign_hash: parentSignHash,
				sign_hash: `uss_${ownerTimestamp}`, sign_b64: 'sig',
			},
			syncMetadata: { relation: 'user_storage' },
		}),
		ingestWithAuthEach: async (mutations: Array<{ modified?: Row; changes?: Row }>) => {
			if (!online) throw new TypeError('Failed to fetch');
			if (refuse) {
				return {
					status: 422,
					json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'error', error: 'invalid signature' })) }),
				} as unknown as Response;
			}
			for (const m of mutations) sent.push((m.modified ?? m.changes)!);
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		},
	},
}));

const { saveStorageJsonPatch, upsertStorageJsonPatch, getStorageRow, getStorageSyncStatus } = await import('@/lib/data/userStorage');
const { setStorageJsonCodec } = await import('@/lib/data/storageIntent');
const { drainPendingWrites } = await import('@/lib/data/ingest');
const {
	_setStorageForTests, _setLeaderForTests, stopDrainLoop, startLeaderElection, stopLeaderElection, pendingEntries,
} = await import('@/lib/data/outbox');
const { _setIntentStorageForTests, _clearIntentsForTests } = await import('@/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

const makeStorage = () => {
	const map = new Map<string, string>();
	return { async get(k: string) { return map.get(k) ?? null; }, async set(k: string, v: string) { map.set(k, v); }, async delete(k: string) { map.delete(k); }, async keys() { return [...map.keys()]; }, async clear() { map.clear(); } };
};

const shown = async () => {
	const row = await getStorageRow(USER, ROOT);
	return row?.value_b64 ? JSON.parse(row.value_b64) : null;
};

beforeEach(async () => {
	online = true;
	refuse = false;
	kv.clear();
	collection.rows.clear();
	sent = [];
	_setStorageForTests(makeStorage());
	_setIntentStorageForTests(makeStorage());
	await _clearIntentsForTests();
	_setAcceptedSnapshotStorageForTests(makeStorage());
	setStorageJsonCodec({
		decrypt: async (valueB64: string) => JSON.parse(valueB64),
		encrypt: async (value: Record<string, unknown>) => ({ valueB64: JSON.stringify(value), hashB64: null }),
	});
	startLeaderElection(USER, () => {});
	_setLeaderForTests(true);
	// The profile as this device saved it earlier, accepted by the server.
	expect(await saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'Old', notes: 'n' }, signSkey })).toBe('synced');
	sent = [];
});

afterEach(() => {
	setStorageJsonCodec(null);
	_setLeaderForTests(null);
	stopDrainLoop();
	stopLeaderElection();
});

describe('a profile edit with no connection', () => {
	it('is saved on this device: queued, not failed', async () => {
		online = false;
		await expect(saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'New' }, signSkey })).resolves.toBe('queued');
		expect(await getStorageSyncStatus(USER, ROOT)).toBe('queued');
		expect((await pendingEntries(USER)).map((e) => e.relation)).toEqual(['user_storage']);
	});

	it('is what the device shows after a reload, before the server has it', async () => {
		online = false;
		await upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'New' }, signSkey });
		// A reload reads the local copy: it carries the edit merged over the
		// rest of the record, not the old value under a newer timestamp.
		expect(await shown()).toEqual({ name: 'New', notes: 'n' });
	});

	it('reaches the server when the connection is back, and the local copy turns synced', async () => {
		online = false;
		await saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'New' }, signSkey });
		online = true;
		drainPendingWrites(USER, signSkey);
		await vi.waitFor(async () => expect(await getStorageSyncStatus(USER, ROOT)).toBe('synced'));
		expect(sent.map((r) => JSON.parse(r.value_b64))).toEqual([{ name: 'New', notes: 'n' }]);
	});

	it('is shown even before it can be signed, when no base for it is known', async () => {
		kv.clear();
		_setAcceptedSnapshotStorageForTests(makeStorage());
		online = false;
		await expect(saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'New' }, signSkey })).resolves.toBe('awaiting-recovery');
		expect(await shown()).toEqual({ name: 'New' });
	});
});

describe('a profile edit the server refuses', () => {
	it('is a failed save, not a saved one', async () => {
		refuse = true;
		await expect(saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'New' }, signSkey })).rejects.toThrow(/could not be saved/);
	});
});

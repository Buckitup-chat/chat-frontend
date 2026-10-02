// A profile edit made with no connection is saved on this device: it is
// queued, not failed, it is what the device shows after a reload, and the
// outbox delivers it once the connection is back. Only a refusal by the
// server is a failed save.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestIdentity, signedStorageRow } from './helpers/signedFixtures';

const ME = makeTestIdentity(31, 'me');
const USER = ME.userHash;
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
	getUserCardsCollection: () => ({ preload: async () => {}, get: (k: string) => (k === ME.userHash ? ME.card : undefined) }),
}));

type Row = { uuid: string; value_b64: string; owner_timestamp: number; parent_sign_hash: string | null };
let sent: Row[] = [];
let refuse = false;
vi.mock('@/api/client', () => ({
	api: {
		createStorageMutation: (userHash: string, uuid: string, valueB64: string, _h: unknown, _v: unknown, ownerTimestamp: number, _sk: unknown, _d: unknown, deletedFlag: boolean, parentSignHash: string | null, _sh: unknown, _sb: unknown, mutationType: string) => ({
			type: mutationType,
			...(mutationType === 'insert' ? {} : { original: { user_hash: userHash, uuid } }),
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
const { drainPendingWrites, resumePendingWrites } = await import('@/lib/data/ingest');
const {
	_setStorageForTests, _setLeaderForTests, stopDrainLoop, startLeaderElection, stopLeaderElection, pendingEntries,
} = await import('@/lib/data/outbox');
const { _setIntentStorageForTests, _clearIntentsForTests } = await import('@/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

const enc = (v: Record<string, unknown>) => Buffer.from(JSON.stringify(v)).toString('base64');
const dec = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString());

const makeStorage = () => {
	const map = new Map<string, string>();
	return { async get(k: string) { return map.get(k) ?? null; }, async set(k: string, v: string) { map.set(k, v); }, async delete(k: string) { map.delete(k); }, async keys() { return [...map.keys()]; }, async clear() { map.clear(); } };
};

const shown = async () => {
	const row = await getStorageRow(USER, ROOT);
	return row?.value_b64 ? dec(row.value_b64) : null;
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
		decrypt: async (valueB64: string) => dec(valueB64),
		encrypt: async (value: Record<string, unknown>) => ({ valueB64: enc(value), hashB64: null }),
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
		resumePendingWrites(USER, signSkey);
		await vi.waitFor(async () => expect(await getStorageSyncStatus(USER, ROOT)).toBe('synced'));
		expect(sent.map((r) => dec(r.value_b64))).toEqual([{ name: 'New', notes: 'n' }]);
	});

	it('on a device with no copy of its own, is merged over the version the server last accepted', async () => {
		kv.clear();
		online = false;
		await expect(saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'New' }, signSkey })).resolves.toBe('queued');
		expect(await shown()).toEqual({ name: 'New', notes: 'n' });
	});

	it('with no version known at all, is kept for recovery without passing the patch off as the whole record', async () => {
		kv.clear();
		_setAcceptedSnapshotStorageForTests(makeStorage());
		online = false;
		await expect(saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'New' }, signSkey })).resolves.toBe('awaiting-recovery');
		// A record of only { name } would hide the slot map and the vault.
		expect(await shown()).toBeNull();
	});

	it('with no version known at all, a second edit does not outrank the server record either', async () => {
		kv.clear();
		_setAcceptedSnapshotStorageForTests(makeStorage());
		online = false;
		await saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'New' }, signSkey });
		await saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { notes: 'm' }, signSkey });
		online = true;
		collection.rows.set(`${USER}|${ROOT}`, signedStorageRow(ME, {
			uuid: ROOT, value_b64: enc({ name: 'Old', notes: 'n', slots: { contacts: 's1' } }), owner_timestamp: 1,
		}));
		expect(await shown()).toEqual({ name: 'Old', notes: 'n', slots: { contacts: 's1' } });
	});
});

describe('a profile edit the server refuses', () => {
	it('is a failed save, not a saved one', async () => {
		refuse = true;
		await expect(saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'New' }, signSkey })).rejects.toThrow(/could not be saved/);
	});
});

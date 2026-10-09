import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestIdentity } from './helpers/signedFixtures';

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
let approved = true;
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
			if (!approved) {
				return {
					status: 403,
					json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'error', error: 'not_in_trust_chain', max_depth: 7 })) }),
				} as unknown as Response;
			}
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

const { saveStorageJsonPatch, putStorageJsonPatch, getStorageSyncStatus } = await import('@/lib/data/userStorage');
const { probeAllBlocked, resetGate, isWriteBlocked } = await import('@/lib/data/accessGate');
const { setStorageJsonCodec } = await import('@/lib/data/storageIntent');
const { drainPendingWrites } = await import('@/lib/data/ingest');
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

beforeEach(async () => {
	online = true;
	approved = true;
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
	expect(await saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'Old', notes: 'n' }, signSkey })).toBe('synced');
	sent = [];
	drainPendingWrites(USER, signSkey); // as session activation does: the sender, and the gate's view of it
});

afterEach(() => {
	resetGate();
	setStorageJsonCodec(null);
	_setLeaderForTests(null);
	stopDrainLoop();
	stopLeaderElection();
});

const within = <T>(promise: Promise<T>, ms = 2_000) => Promise.race([
	promise.then((value) => ({ value }), (error: Error) => ({ error: error.message })),
	new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms)),
]);

describe('a profile edit the trust chain refuses', () => {
	it('is saved on this device and awaits approval — the first refused write and a later one alike; approved, it is synced', async () => {
		approved = false;
		await expect(within(saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'First' }, signSkey }))).resolves.toEqual({ value: 'awaiting-approval' });
		expect(await getStorageSyncStatus(USER, ROOT)).toBe('awaiting-approval');
		await expect(within(saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'Second' }, signSkey }))).resolves.toEqual({ value: 'awaiting-approval' });
		expect((await pendingEntries(USER)).map((e) => e.relation)).toEqual(['user_storage', 'user_storage']);

		approved = true;
		await vi.waitFor(() => expect(isWriteBlocked('user_storage')).toBe(true));
		probeAllBlocked();

		await vi.waitFor(() => expect(sent.map((r) => dec(r.value_b64).name)).toEqual(['First', 'Second']));
		await vi.waitFor(async () => expect(await getStorageSyncStatus(USER, ROOT)).toBe('synced'));
	});

	it('a write that must be on the server says at once that it is not — it does not wait for the approval', async () => {
		approved = false;
		await saveStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { name: 'First' }, signSkey });

		const outcome = await within(putStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { notes: 'later' }, signSkey }));

		expect(outcome).toEqual({ error: 'Saved on this device, but the server did not take it' });
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestIdentity, signedStorageRow } from './helpers/signedFixtures';

const kv = new Map<string, unknown>();
vi.mock('../src/lib/data/localStore', () => ({
	kvGet: vi.fn(async (k: string) => kv.get(k)),
	kvSet: vi.fn(async (k: string, v: unknown) => { kv.set(k, v); }),
	kvDelete: vi.fn(async (k: string) => { kv.delete(k); }),
}));

const collection = {
	rows: new Map<string, unknown>(),
	preload: vi.fn(async () => {}),
	get: vi.fn((k: string) => collection.rows.get(k)),
};
const cards = new Map<string, unknown>();
vi.mock('../src/lib/data/collections', () => ({
	getUserStorageCollection: () => collection,
	getUserCardsCollection: () => ({ preload: async () => {}, get: (k: string) => cards.get(k) }),
}));

let sent: unknown[][] = [];
vi.mock('@/api/client', () => ({
	api: {
		createStorageMutation: vi.fn((userHash: string, uuid: string, valueB64: string, _h: unknown, _v: unknown, ownerTimestamp: number, _sk: unknown, _d: unknown, deletedFlag: boolean, parentSignHash: string | null, _sh: unknown, _sb: unknown, mutationType: string) => {
			const row = {
				user_hash: userHash, uuid, value_b64: valueB64, deleted_flag: deletedFlag,
				owner_timestamp: ownerTimestamp, parent_sign_hash: parentSignHash,
				sign_hash: 'uss_' + '1'.repeat(128), sign_b64: 'sig',
			};
			return {
				type: mutationType,
				[mutationType === 'insert' ? 'modified' : 'changes']: row,
				...(mutationType === 'insert' ? {} : { original: { user_hash: userHash, uuid } }),
				syncMetadata: { relation: 'user_storage' },
			};
		}),
		ingestWithAuthEach: vi.fn(async (mutations: unknown[]) => {
			sent.push(mutations);
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		}),
	},
}));

const { getStorageRow, upsertStorageRow, upsertStorageJsonPatch } = await import('../src/lib/data/userStorage');
const { verifyReplicatedRow } = await import('../src/lib/data/rowVerification');
const { getVerifiedSignPkey, resetCardRegistry } = await import('../src/lib/data/cardRegistry');
const { setStorageJsonCodec } = await import('../src/lib/data/storageIntent');
const { startLeaderElection, stopLeaderElection, stopDrainLoop, _setStorageForTests: setOutboxStorage, _setAtomicLeaseStoreForTests } = await import('../src/lib/data/outbox');
const { _setIntentStorageForTests, _clearIntentsForTests } = await import('../src/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests, recordAccepted } = await import('../src/lib/data/acceptedSnapshot');

const memoryStore = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};
const leaseStore = () => {
	const map = new Map<string, { instanceId: string; expiresAt: number }>();
	return {
		async claim(u: string, c: { instanceId: string; expiresAt: number }, now: number) {
			const cur = map.get(u);
			const winner = cur && cur.instanceId !== c.instanceId && cur.expiresAt > now ? cur : c;
			map.set(u, winner);
			return winner;
		},
		async release(u: string, id: string) { if (map.get(u)?.instanceId === id) map.delete(u); },
	};
};

const ME = makeTestIdentity(21, 'me');
const BOB = makeTestIdentity(22, 'bob');
const USER = ME.userHash;
const SLOT = '85da8ea0-5bc8-856e-83e7-db7b542a1a58';
const KEY = `${USER}|${SLOT}`;
const signSkey = new Uint8Array(32).fill(7);

const enc = (v: Record<string, unknown>) => Buffer.from(JSON.stringify(v)).toString('base64');
const dec = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString()) as Record<string, unknown>;

const OLD = signedStorageRow(ME, { uuid: SLOT, value_b64: enc({ name: 'old' }), owner_timestamp: 1_000 });
const CURRENT = signedStorageRow(ME, { uuid: SLOT, value_b64: enc({ name: 'current' }), owner_timestamp: 5_000 });
const REPLAYED = { ...OLD, owner_timestamp: 9_000 };
const FOREIGN = signedStorageRow(BOB, { uuid: SLOT, user_hash: USER, value_b64: enc({ name: 'bob' }), owner_timestamp: 9_000 });

const verdict = (row: Record<string, unknown>) => verifyReplicatedRow('user_storage', row, getVerifiedSignPkey);

beforeEach(async () => {
	kv.clear();
	collection.rows.clear();
	cards.clear();
	cards.set(ME.userHash, ME.card);
	cards.set(BOB.userHash, BOB.card);
	resetCardRegistry();
	sent = [];
	vi.clearAllMocks();
	_setIntentStorageForTests(memoryStore());
	await _clearIntentsForTests();
	setOutboxStorage(memoryStore());
	_setAcceptedSnapshotStorageForTests(memoryStore());
	_setAtomicLeaseStoreForTests(leaseStore());
	startLeaderElection(USER, () => {});
	setStorageJsonCodec({ decrypt: async (b) => dec(b), encrypt: async (v) => ({ valueB64: enc(v), hashB64: null }) });
	await recordAccepted('user_storage', KEY, CURRENT, USER);
	kv.set(`us|${KEY}`, { row: CURRENT, hash_b64: null, syncStatus: 'synced' });
});

afterEach(() => {
	stopLeaderElection();
	stopDrainLoop();
	_setAtomicLeaseStoreForTests(null);
	setStorageJsonCodec(null);
});

describe('fixtures: the gate itself tells these rows apart', () => {
	it('CURRENT verifies; REPLAYED and FOREIGN do not', async () => {
		expect(await verdict(CURRENT)).toEqual({ status: 'verified' });
		expect(await verdict(REPLAYED)).toEqual({ status: 'invalid', reason: 'bad_signature' });
		expect(await verdict(FOREIGN)).toEqual({ status: 'invalid', reason: 'bad_signature' });
	});
});

describe('construction path (resolveStorageBase): unverified newer row is no base', () => {
	it('a replayed row with a bigger owner_timestamp blocks the write — nothing signed or sent', async () => {
		collection.rows.set(KEY, REPLAYED);
		const write = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: enc({ name: 'next' }), hashB64: null, signSkey });
		expect((await write.sync).status).toBe('awaiting-recovery');
		expect(sent).toHaveLength(0);
	});
});

describe('read path (getStorageRow): same rows, no gate', () => {
	it('an invalid-signature row with a bigger owner_timestamp must not beat the valid local row', async () => {
		collection.rows.set(KEY, REPLAYED);
		const shown = await getStorageRow(USER, SLOT);
		expect(dec(shown!.value_b64)).toEqual({ name: 'current' });
	});

	it('a row signed by another account must not become canonical state', async () => {
		collection.rows.set(KEY, FOREIGN);
		const shown = await getStorageRow(USER, SLOT);
		expect(shown?.sign_hash).not.toBe(FOREIGN.sign_hash);
	});

	it('a verified tombstone newer than the local copy is the slot state, not the older local row', async () => {
		collection.rows.set(KEY, signedStorageRow(ME, { uuid: SLOT, value_b64: '', deleted_flag: true, owner_timestamp: 9_000 }));
		expect(await getStorageRow(USER, SLOT)).toBeNull();
	});
});

describe('local projection base (freshestKnownValue): an unverified row must not be merged into it', () => {
	it('a JSON patch is projected onto the trusted value, not onto the replayed one', async () => {
		collection.rows.set(KEY, REPLAYED);
		const write = await upsertStorageJsonPatch({ userHash: USER, uuid: SLOT, jsonPatch: { notes: 'x' }, signSkey });
		expect((await write.sync).status).toBe('awaiting-recovery');
		expect(sent).toHaveLength(0);
		const local = kv.get(`us|${KEY}`) as { row: { value_b64: string } };
		expect(dec(local.row.value_b64)).toEqual({ name: 'current', notes: 'x' });
		expect(dec((await getStorageRow(USER, SLOT))!.value_b64)).toEqual({ name: 'current', notes: 'x' });
	});
});

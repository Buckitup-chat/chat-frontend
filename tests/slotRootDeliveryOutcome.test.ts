import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSlotResolver } from '@/lib/data/slots';

const USER = 'u_' + 'a'.repeat(128);
const ROOT_UUID = 'root-0000-0000-0000-000000000000';
const SLOT_UUID = 'slot-1111-1111-1111-111111111111';
const signSkey = new Uint8Array(32).fill(7);

const kv = new Map<string, unknown>();
vi.mock('@/lib/data/localStore', () => ({
	kvGet: vi.fn(async (k: string) => kv.get(k)),
	kvSet: vi.fn(async (k: string, v: unknown) => { kv.set(k, v); }),
	kvDelete: vi.fn(async (k: string) => { kv.delete(k); }),
}));

const collection = { rows: new Map<string, unknown>(), preload: vi.fn(async () => {}), get: vi.fn((k: string) => collection.rows.get(k)) };
vi.mock('@/lib/data/collections', () => ({
	getUserStorageCollection: () => collection,
}));

let sent: Array<{ uuid: string; type: string }> = [];
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
		ingestWithAuthEach: async (mutations: Array<{ type: string; modified?: { uuid: string }; changes?: { uuid: string } }>) => {
			for (const m of mutations) sent.push({ uuid: (m.modified ?? m.changes)!.uuid, type: m.type });
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		},
	},
}));

const { upsertStorageRow } = await import('@/lib/data/userStorage');
const {
	_setStorageForTests, _setLeaderForTests, stopDrainLoop, startLeaderElection, stopLeaderElection,
} = await import('@/lib/data/outbox');
const { _setIntentStorageForTests, _clearIntentsForTests } = await import('@/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

const makeStorage = () => {
	const map = new Map<string, string>();
	return { async get(k: string) { return map.get(k) ?? null; }, async set(k: string, v: string) { map.set(k, v); }, async delete(k: string) { map.delete(k); }, async keys() { return [...map.keys()]; }, async clear() { map.clear(); } };
};

let rootRecord: { slots?: Record<string, string> } | null = null;

const writeRoot = async (next: { slots?: Record<string, string> }) => {
	const res = await upsertStorageRow({ userHash: USER, uuid: ROOT_UUID, valueB64: JSON.stringify(next), hashB64: null, signSkey });
	const sync = await res.sync;
	if (sync.status !== 'synced') throw new Error('root write not accepted');
	rootRecord = next;
};

const writeSlotRow = async (uuid: string, tag: string) => {
	const res = await upsertStorageRow({ userHash: USER, uuid, valueB64: tag, hashB64: null, signSkey });
	const sync = await res.sync;
	if (sync.status !== 'synced') throw new Error('slot write not accepted');
};

const rootWrites = () => sent.filter((m) => m.uuid === ROOT_UUID);
const slotWrites = () => sent.filter((m) => m.uuid === SLOT_UUID);

beforeEach(async () => {
	kv.clear();
	collection.rows.clear();
	sent = [];
	rootRecord = null;
	_setStorageForTests(makeStorage());
	_setIntentStorageForTests(makeStorage());
	await _clearIntentsForTests();
	_setAcceptedSnapshotStorageForTests(makeStorage());
	startLeaderElection(USER, () => {});
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
	stopLeaderElection();
});

describe('slot -> root mapping only builds on the slot\'s real acceptance (L17-01, slot creation ordering)', () => {
	it('11a. delayed slot acceptance (follower tab): root transport count stays 0', async () => {
		_setLeaderForTests(false);
		const resolver = createSlotResolver({ read: async () => rootRecord, write: writeRoot });

		const pending = resolver.ensureSlotUuid('contacts', {
			mint: () => SLOT_UUID,
			writeRow: (uuid) => writeSlotRow(uuid, 'v1'),
		});

		await new Promise((r) => setTimeout(r, 30));
		expect(slotWrites()).toHaveLength(0); // the slot itself never reached transport yet
		expect(rootWrites()).toHaveLength(0); // and root MUST NOT have been attempted ahead of it

		_setLeaderForTests(true);
		const { drainPendingWrites } = await import('@/lib/data/ingest');
		drainPendingWrites(USER, signSkey);
		await pending;

		expect(slotWrites()).toHaveLength(1);
		expect(rootWrites()).toHaveLength(1);
	});

	it('11b. once the slot is actually accepted, root writes without waiting for the slot\'s shape echo', async () => {
		_setLeaderForTests(true);
		const resolver = createSlotResolver({ read: async () => rootRecord, write: writeRoot });

		const { uuid } = await resolver.ensureSlotUuid('contacts', {
			mint: () => SLOT_UUID,
			writeRow: (u) => writeSlotRow(u, 'v1'),
		});

		expect(uuid).toBe(SLOT_UUID);
		expect(slotWrites()).toHaveLength(1); // slot accepted
		expect(rootWrites()).toHaveLength(1); // root followed immediately — no separate shape-visibility wait
		expect(rootRecord?.slots?.contacts).toBe(SLOT_UUID);
	});

	it('11c. a permanently rejected slot write never lets root transport run', async () => {
		_setLeaderForTests(true);
		const apiModule = await import('@/api/client');
		const spy = vi.spyOn(apiModule.api, 'ingestWithAuthEach').mockImplementationOnce(async (mutations: Array<{ type: string; modified?: { uuid: string }; changes?: { uuid: string } }>) => {
			for (const m of mutations) sent.push({ uuid: (m.modified ?? m.changes)!.uuid, type: m.type });
			return {
				status: 422,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed', details: {} })) }),
			} as unknown as Response;
		});
		const resolver = createSlotResolver({ read: async () => rootRecord, write: writeRoot });

		await expect(resolver.ensureSlotUuid('contacts', {
			mint: () => SLOT_UUID,
			writeRow: (uuid) => writeSlotRow(uuid, 'v1'),
		})).rejects.toThrow('slot write not accepted');

		spy.mockRestore();
		expect(slotWrites()).toHaveLength(1); // the slot attempt really happened and really failed
		expect(rootWrites()).toHaveLength(0); // root must never run when the slot step itself failed
	});
});

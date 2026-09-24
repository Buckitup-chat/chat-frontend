import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);
const signSkey = new Uint8Array(32).fill(7);

let ambientUserHash: string | null = null;
vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() { return ambientUserHash; },
			exportVaultKeys: async () => ({
				sign_skey: 'AAAA',
				crypt_skey: btoa((ambientUserHash === A ? '11' : '22').repeat(16)),
				evm_skey: 'cc',
			}),
		}),
	},
}));

const kv = new Map<string, unknown>();
let deferNextKvGet = false;
let releaseKvGet: (() => void) | null = null;
let kvGetStarted: (() => void) | null = null;

vi.mock('@/lib/data/localStore', () => ({
	kvGet: vi.fn(async (k: string) => {
		if (deferNextKvGet) {
			deferNextKvGet = false;
			kvGetStarted?.();
			await new Promise<void>((resolve) => { releaseKvGet = resolve; });
		}
		return kv.get(k);
	}),
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

let sent: unknown[][] = [];
let deferHttp = false;
let httpOutcome: 'accept' | 'reject' = 'accept';
let releaseHttp: (() => void) | null = null;
let httpStarted: (() => void) | null = null;

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
			if (deferHttp) {
				deferHttp = false;
				httpStarted?.();
				await new Promise<void>((resolve) => { releaseHttp = resolve; });
			}
			if (httpOutcome === 'reject') {
				return {
					status: 422,
					json: async () => ({
						results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed', details: {} })),
					}),
				} as unknown as Response;
			}
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		},
	},
}));

const { upsertStorageRow, getStorageSyncStatus } = await import('@/lib/data/userStorage');
const {
	_setStorageForTests, _setLeaderForTests, stopDrainLoop, pendingReconciliation, quarantinedEntries,
	startLeaderElection, stopLeaderElection, SessionFencedError,
} = await import('@/lib/data/outbox');
const { _setIntentStorageForTests, _clearIntentsForTests, intentsOf } = await import('@/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests, _setRawAcceptedSnapshotStorageForTests, getAccepted } = await import('@/lib/data/acceptedSnapshot');
const { entityKeyFor } = await import('@/lib/data/userStorageBase');

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

beforeEach(async () => {
	kv.clear();
	collection.rows.clear();
	sent = [];
	deferNextKvGet = false;
	releaseKvGet = null;
	kvGetStarted = null;
	deferHttp = false;
	httpOutcome = 'accept';
	releaseHttp = null;
	httpStarted = null;
	_setStorageForTests(makeStorage());
	_setIntentStorageForTests(makeStorage());
	await _clearIntentsForTests();
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setLeaderForTests(true);
	startLeaderElection(A, () => {});
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
	stopLeaderElection();
	ambientUserHash = null;
});

describe('upsertStorageEditLive: session-generation fencing across its await boundaries (§12)', () => {
	it('boundary 1 — a switch to B after the durable intent write, before the optimistic kvSet, blocks the projection and leaves the durable intent recoverable', async () => {
		const SLOT = 'slot-boundary-1';
		deferNextKvGet = true;
		const started = new Promise<void>((resolve) => { kvGetStarted = resolve; });

		const call = upsertStorageRow({ userHash: A, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });

		await started;
		const before = await intentsOf(A);
		expect(before.entries).toHaveLength(1);
		expect((before.entries[0].intent as { kind: string; uuid: string }).kind).toBe('storage');

		stopLeaderElection();
		startLeaderElection(B, () => {});

		releaseKvGet!();

		await expect(call).rejects.toThrow(SessionFencedError);

		expect(await getStorageSyncStatus(A, SLOT)).toBeNull();
		expect(sent).toHaveLength(0);

		const after = await intentsOf(A);
		expect(after.entries).toHaveLength(1);
		expect(after.entries[0].id).toBe(before.entries[0].id);
		expect((after.entries[0].intent as { kind: string }).kind).toBe('storage');
	});

	it('boundary 2 — a switch to B while a late ACCEPTANCE is in flight never writes "synced", and the durable outbox entry survives for A to reconcile later', async () => {
		const SLOT = 'slot-boundary-2';
		deferHttp = true;
		httpOutcome = 'accept';
		const started = new Promise<void>((resolve) => { httpStarted = resolve; });
		_setRawAcceptedSnapshotStorageForTests(makeStorage());
		ambientUserHash = A;

		const call = upsertStorageRow({ userHash: A, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });

		await started;
		expect(await getStorageSyncStatus(A, SLOT)).toBe('syncing');

		stopLeaderElection();
		startLeaderElection(B, () => {});
		ambientUserHash = B;
		releaseHttp!();

		await expect(call).rejects.toThrow(SessionFencedError);

		expect(await getStorageSyncStatus(A, SLOT)).toBe('syncing');
		expect(sent).toHaveLength(1);

		expect(await getAccepted('user_storage', entityKeyFor(A, SLOT), A)).toBeNull();

		const stuck = await pendingReconciliation(A);
		expect(stuck).toHaveLength(1);
		expect(stuck[0].reconciledAt).toBeUndefined();
	});

	it('boundary 3 — A logging out and back in (a fresh session generation) before a late REJECTION arrives never writes "failed"', async () => {
		const SLOT = 'slot-boundary-3';
		deferHttp = true;
		httpOutcome = 'reject';
		const started = new Promise<void>((resolve) => { httpStarted = resolve; });

		const call = upsertStorageRow({ userHash: A, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });

		await started;
		expect(await getStorageSyncStatus(A, SLOT)).toBe('syncing');

		stopLeaderElection();
		startLeaderElection(A, () => {});
		releaseHttp!();

		await expect(call).rejects.toThrow(SessionFencedError);

		expect(await getStorageSyncStatus(A, SLOT)).toBe('syncing');
		expect(sent).toHaveLength(1);

		const quarantined = await quarantinedEntries(A);
		expect(quarantined).toHaveLength(1);
	});
});

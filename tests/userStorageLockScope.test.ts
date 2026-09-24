import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const kv = new Map<string, unknown>();
vi.mock('../src/lib/data/localStore', () => ({
	kvGet: vi.fn(async (k: string) => kv.get(k)),
	kvSet: vi.fn(async (k: string, v: unknown) => { kv.set(k, v); }),
	kvDelete: vi.fn(async (k: string) => { kv.delete(k); }),
}));

const collection = {
	rows: new Map<string, unknown>(),
	preloadError: null as unknown,
	preload: vi.fn(async () => {
		if (collection.preloadError) throw collection.preloadError;
	}),
	get: vi.fn((k: string) => collection.rows.get(k)),
};
vi.mock('../src/lib/data/collections', () => ({
	getUserStorageCollection: () => collection,
}));

let signCallCount = 0;
vi.mock('@/api/client', () => ({
	api: {
		createStorageMutation: vi.fn((userHash: string, uuid: string, valueB64: string, _h: unknown, _v: unknown, ownerTimestamp: number, _sk: unknown, _d: unknown, deletedFlag: boolean, parentSignHash: string | null, _sh: unknown, _sb: unknown, mutationType: string) => {
			signCallCount += 1;
			const signHash = 'uss_' + String(signCallCount).padStart(128, '0');
			const row = {
				user_hash: userHash, uuid, value_b64: valueB64, deleted_flag: deletedFlag,
				owner_timestamp: ownerTimestamp, parent_sign_hash: parentSignHash,
				sign_hash: signHash, sign_b64: 'sig',
			};
			return {
				type: mutationType,
				[mutationType === 'insert' ? 'modified' : 'changes']: row,
				syncMetadata: { relation: 'user_storage' },
			};
		}),
		ingestWithAuthEach: vi.fn(async (mutations: unknown[]) => ({
			status: 200,
			json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
		})),
	},
}));

const { upsertStorageRow, getStorageSyncStatus } = await import('../src/lib/data/userStorage');
const { contractFor } = await import('../src/lib/data/writeContracts');
const {
	startLeaderElection, stopLeaderElection, stopDrainLoop, pendingEntries,
	quarantinedEntries, discardEntry, _setAtomicLeaseStoreForTests,
	_setStorageForTests: _setOutboxStorageForTests,
} = await import('../src/lib/data/outbox');
const { _setIntentStorageForTests, _clearIntentsForTests } = await import('../src/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests } = await import('../src/lib/data/acceptedSnapshot');
const { drainPendingWrites } = await import('../src/lib/data/ingest');
const { api } = await import('@/api/client');

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

const USER = 'u_' + 'ab'.repeat(64);
const SLOT = '85da8ea0-5bc8-856e-83e7-db7b542a1a58';
const signSkey = new Uint8Array(32).fill(7);

const makeLeaseStore = () => {
	const map = new Map<string, { instanceId: string; expiresAt: number }>();
	return {
		async claim(userHash: string, candidate: { instanceId: string; expiresAt: number }, now: number) {
			const current = map.get(userHash);
			const winner = current && current.instanceId !== candidate.instanceId && current.expiresAt > now ? current : candidate;
			map.set(userHash, winner);
			return winner;
		},
		async release(userHash: string, ownerId: string) {
			const current = map.get(userHash);
			if (!current || current.instanceId !== ownerId) return;
			map.delete(userHash);
		},
	};
};

const mutationCalls = () => (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls;
const mutationResult = (i: number) => (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.results[i].value;
const signHashOf = (mutation: { modified?: { sign_hash: string }; changes?: { sign_hash: string } }) =>
	(mutation.modified ?? mutation.changes)!.sign_hash;

beforeEach(async () => {
	kv.clear();
	collection.rows.clear();
	collection.preloadError = null;
	signCallCount = 0;
	vi.clearAllMocks();
	_setIntentStorageForTests(makeStorage());
	await _clearIntentsForTests();
	_setOutboxStorageForTests(makeStorage());
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setAtomicLeaseStoreForTests(makeLeaseStore());
	startLeaderElection(USER, () => {});
});

afterEach(() => {
	vi.clearAllMocks();
	stopLeaderElection();
	stopDrainLoop();
	_setAtomicLeaseStoreForTests(null);
});

describe('1. the slot lock releases before network I/O completes', () => {
	it('a second writer signs and durably enqueues while the first writer\'s HTTP request is still open', async () => {
		let releaseA: (() => void) | null = null;
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>).mockImplementationOnce(async (mutations: unknown[]) => {
			await new Promise<void>((r) => { releaseA = r; });
			return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }) };
		});

		const a = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'A', hashB64: null, signSkey });
		await vi.waitFor(() => expect(releaseA).toBeTruthy());

		const b = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'B', hashB64: null, signSkey });
		await vi.waitFor(() => expect(mutationCalls()).toHaveLength(2));
		await vi.waitFor(async () => expect(await pendingEntries(USER)).toHaveLength(2));

		releaseA!();
		await a;
		drainPendingWrites(USER, signSkey);
		await b;
	});
});

describe('2. the second writer stays revision-correct against the in-flight first writer', () => {
	it('B\'s parent_sign_hash is exactly A\'s sign_hash, known the moment A was signed — not a stale or duplicated base', async () => {
		let releaseA: (() => void) | null = null;
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				await new Promise<void>((r) => { releaseA = r; });
				return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }) };
			})
			.mockImplementationOnce(async (mutations: unknown[]) => ({
				status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 200 + index })) }),
			}));

		const a = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'A', hashB64: null, signSkey });
		await vi.waitFor(() => expect(releaseA).toBeTruthy());
		expect(mutationCalls()[0]?.at(-1)).toBe('insert');

		const b = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'B', hashB64: null, signSkey });
		await vi.waitFor(() => expect(mutationCalls()).toHaveLength(2));

		expect(mutationCalls()[1]?.at(-1)).toBe('update');
		expect(mutationCalls()[1]?.[9]).toBe(signHashOf(mutationResult(0)));

		releaseA!();
		await a;
		drainPendingWrites(USER, signSkey);
		await b;
	});
});

describe('3. accepted is sufficient — no shape-visibility wait for user_storage', () => {
	it('the write contract confirms on server acceptance alone', () => {
		expect(contractFor('user_storage', 'insert').confirmation).toBe('accepted');
		expect(contractFor('user_storage', 'update').confirmation).toBe('accepted');
	});

	it('a write resolves as synced purely from the ingest response, with no shape/collection barrier involved', async () => {
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });
		expect((await res.sync).status).toBe('synced');
	});
});

describe('4. no premature completion', () => {
	it('B is never reported as synced while merely durably queued behind A', async () => {
		let releaseA: (() => void) | null = null;
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				await new Promise<void>((r) => { releaseA = r; });
				return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }) };
			})
			.mockImplementationOnce(async (mutations: unknown[]) => ({
				status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 200 + index })) }),
			}));

		const a = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'A', hashB64: null, signSkey });
		await vi.waitFor(() => expect(releaseA).toBeTruthy());
		const b = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'B', hashB64: null, signSkey });
		await vi.waitFor(async () => expect(await pendingEntries(USER)).toHaveLength(2));

		expect(await getStorageSyncStatus(USER, SLOT)).not.toBe('synced');

		releaseA!();
		await a;
		drainPendingWrites(USER, signSkey);
		await b;
		expect(await getStorageSyncStatus(USER, SLOT)).toBe('synced');
	});

	it('a lost-response-style rejection settles as failed, never as a fabricated success', async () => {
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>).mockImplementationOnce(async (mutations: unknown[]) => ({
			status: 422,
			json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed', details: {} })) }),
		}));
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });
		expect((await res.sync).status).toBe('failed');
	});
});

describe('5. failure does not poison the slot lock', () => {
	it('an unavailable base leaves the lock usable for the very next write once the base is known', async () => {
		collection.preloadError = new Error('down');
		const res1 = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });
		expect((await res1.sync).status).toBe('awaiting-recovery');

		collection.preloadError = null;
		const res2 = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v2', hashB64: null, signSkey });
		expect((await res2.sync).status).toBe('synced');
	});

	it('a permanent server rejection leaves the lock usable once the failed predecessor is discarded', async () => {
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>).mockImplementationOnce(async (mutations: unknown[]) => ({
			status: 422,
			json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed', details: {} })) }),
		}));
		const res1 = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });
		expect((await res1.sync).status).toBe('failed');

		const [quarantined] = await quarantinedEntries(USER);
		expect(quarantined).toBeTruthy();
		await discardEntry(quarantined.id);

		const res2 = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v2', hashB64: null, signSkey });
		expect((await res2.sync).status).toBe('synced');
	});
});

describe('6. concurrent writers: construction serializes, HTTP does not', () => {
	it('two nearly-simultaneous writes to the same slot never fork — exactly one insert and one correctly-chained update', async () => {
		const [a, b] = await Promise.all([
			upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'A', hashB64: null, signSkey }),
			upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'B', hashB64: null, signSkey }),
		]);

		expect(mutationCalls()).toHaveLength(2);
		expect(mutationCalls()[0]?.at(-1)).toBe('insert');
		expect(mutationCalls()[1]?.at(-1)).toBe('update');
		expect(mutationCalls()[1]?.[9]).toBe(signHashOf(mutationResult(0)));
		expect((await a.sync).status).toBe('synced');
		expect((await b.sync).status).toBe('synced');
	});
});

describe('7. replay is unaffected by the narrower lock', () => {
	it('a crash between durable enqueue and intent resolution replays the same signed mutation once, without re-signing', async () => {
		const flakyIntents = makeStorage();
		let failResolve = false;
		const realSet = flakyIntents.set.bind(flakyIntents);
		flakyIntents.set = async (k: string, v: string) => {
			if (failResolve && v.includes('"resolved":true')) throw new Error('simulated crash before resolve');
			return realSet(k, v);
		};
		_setIntentStorageForTests(flakyIntents);

		failResolve = true;
		const res1 = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });
		expect((await res1.sync).status).toBe('synced'); // the send itself genuinely succeeded
		expect(mutationCalls()).toHaveLength(1);

		failResolve = false;
		const { recoverIntents } = await import('../src/lib/data/intentRecovery');
		const { materializeStorageIntent } = await import('../src/lib/data/storageIntent');
		await recoverIntents(USER, signSkey, { materializeStorage: materializeStorageIntent });

		expect(mutationCalls()).toHaveLength(1);
	});
});

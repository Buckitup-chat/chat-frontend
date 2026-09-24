import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory stand-ins for the IndexedDB KV and the Electric collection, so the
// module under test runs unchanged in Node.
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

// Real ingest.ts/coordinator.ts/outbox.ts run in these tests (only the HTTP
// transport and the signing helper are mocked) so that the accepted-snapshot
// recording a chained revision's base depends on (coordinator.ts's
// reconcileAccepted) actually happens, the same as in production.
let sent: unknown[][] = [];
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
		ingestWithAuthEach: vi.fn(async (mutations: unknown[]) => {
			sent.push(mutations);
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		}),
	},
}));

const { upsertStorageRow, getStorageRow } = await import('../src/lib/data/userStorage');
const {
	startLeaderElection, stopLeaderElection, stopDrainLoop, pendingEntries,
	_setStorageForTests: _setOutboxStorageForTests, _setAtomicLeaseStoreForTests,
} = await import('../src/lib/data/outbox');
const { _setIntentStorageForTests, _clearIntentsForTests } = await import('../src/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests, getAccepted } = await import('../src/lib/data/acceptedSnapshot');
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
// Slot addresses are per-account now, so any valid uuid stands in here.
const SLOT = '85da8ea0-5bc8-856e-83e7-db7b542a1a58';
const signSkey = new Uint8Array(32).fill(7);

/** A genuine AtomicLeaseStore double (see outbox.ts) — this file drives
 * leadership through the real startLeaderElection/fallback-election path
 * (not the _setLeaderForTests override), so it needs a real coordination
 * primitive standing in for IndexedDB for that election to actually
 * succeed. */
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

beforeEach(async () => {
	kv.clear();
	collection.rows.clear();
	collection.preloadError = null;
	sent = [];
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

const serverRow = (ts: number, signHash = 'uss_' + 'a'.repeat(128)) => ({
	user_hash: USER, uuid: SLOT, value_b64: 'server', deleted_flag: false,
	parent_sign_hash: null, sign_hash: signHash, owner_timestamp: ts, sign_b64: 'sig',
});

describe('upsertStorageRow: server base state', () => {
	it('signs an insert only when the server is reachable and the row is absent', async () => {
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });
		expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls[0]?.at(-1)).toBe('insert');
		expect((await res.sync).status).toBe('synced');
	});

	it('signs an update when a server row exists', async () => {
		collection.rows.set(`${USER}|${SLOT}`, serverRow(1000));
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v2', hashB64: null, signSkey });
		const call = (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call?.at(-1)).toBe('update');
		expect(call?.[9]).toBe('uss_' + 'a'.repeat(128)); // parent_sign_hash = server tip
	});

	// A tombstone still occupies the primary key — re-inserting it is rejected.
	it('signs an update when the server row is a tombstone', async () => {
		collection.rows.set(`${USER}|${SLOT}`, { ...serverRow(1000), deleted_flag: true });
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v2', hashB64: null, signSkey });
		expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls[0]?.at(-1)).toBe('update');
	});

	// "Unreachable" must never be read as "absent": signing an insert from an
	// unknown base guarantees a conflict once connectivity returns. This is
	// now a recoverable, durable wait (§2), not an outright failure — the
	// durable intent survives for the next recovery pass to retry.
	it('leaves a durable, recoverable intent when the server state is unavailable and no base is known', async () => {
		collection.preloadError = new Error('node unreachable');
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });

		expect(api.createStorageMutation).not.toHaveBeenCalled();
		expect(api.ingestWithAuthEach).not.toHaveBeenCalled();
		expect((await res.sync).status).toBe('awaiting-recovery');
		// the user's edit is still kept locally, visibly pending — not "failed"
		expect(kv.get(`us|${USER}|${SLOT}`)).toMatchObject({ syncStatus: 'awaiting-recovery', row: { value_b64: 'v1' } });
	});

	it('signs an update against the accepted local base when the server is unavailable after a prior synced write', async () => {
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });
		expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls[0]?.at(-1)).toBe('insert');
		const accepted = await getAccepted('user_storage', `${USER}|${SLOT}`);
		expect(accepted?.sign_hash).toBeTruthy();

		collection.preloadError = new Error('node unreachable');
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v2', hashB64: null, signSkey });

		const call = (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls[1];
		expect(call?.at(-1)).toBe('update');
		expect(call?.[9]).toBe(accepted?.sign_hash);
		expect((await res.sync).status).toBe('synced');
	});
});

// Precondition for avatar ordering (review finding 3): the caller publishes
// the avatar uuid inside the profile revision, so it must be able to tell that
// the avatar write was rejected. EncryptionManagerPQ turns this status into a
// throw before the profile is signed.
describe('upsertStorageRow: failure is reported to the caller', () => {
	it('reports failed sync when the server rejects the write', async () => {
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>).mockImplementationOnce(async (mutations: unknown[]) => ({
			status: 422,
			json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed', details: {} })) }),
		}));
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v', hashB64: null, signSkey });
		const sync = await res.sync;
		expect(sync.status).toBe('failed');
		expect(kv.get(`us|${USER}|${SLOT}`)).toMatchObject({ syncStatus: 'failed' });
	});

	it('resolves only after the server verdict is known', async () => {
		let settled = false;
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>).mockImplementationOnce(async (mutations: unknown[]) => {
			await new Promise((r) => setTimeout(r, 20));
			settled = true;
			return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }) };
		});
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v', hashB64: null, signSkey });
		// the write is already decided by the time the caller gets the result
		expect(settled).toBe(true);
		expect((await res.sync).status).toBe('synced');
	});
});

describe('upsertStorageRow: per-slot ordering', () => {
	it('A dispatches live while B, started after A is durably enqueued, chains behind it in the outbox and never sends before A settles', async () => {
		const order: string[] = [];
		let release: (() => void) | null = null;
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				order.push('A:start');
				await new Promise<void>((r) => { release = r; });
				order.push('A:end');
				return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }) };
			})
			.mockImplementationOnce(async (mutations: unknown[]) => {
				order.push('B:start');
				return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 200 + index })) }) };
			});

		const a = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'A', hashB64: null, signSkey });
		await vi.waitFor(() => expect(release).toBeTruthy());

		// The slot lock has already released by now — it only ever guarded
		// materialize-then-sign-then-enqueue, not A's still-open HTTP request
		// (§ narrow lock scope). B is free to construct and durably enqueue
		// its own revision immediately, chained onto A via the outbox's own
		// dependency graph (same chain key), not onto the lock.
		const b = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'B', hashB64: null, signSkey });
		await vi.waitFor(async () => expect((await pendingEntries(USER)).length).toBeGreaterThanOrEqual(2));

		release!();
		await a;
		// B is queued behind A in the outbox, not held by the lock — drive
		// its scheduled retry explicitly instead of waiting out its real
		// backoff timer.
		drainPendingWrites(USER, signSkey);
		await b;

		// B's HTTP request still only ever happens after A's finished.
		expect(order).toEqual(['A:start', 'A:end', 'B:start']);
		// last write wins locally, regardless of network timing
		expect((kv.get(`us|${USER}|${SLOT}`) as { row: { value_b64: string } }).row.value_b64).toBe('B');
	});

	it('lets the second write see the first write as its base via the accepted snapshot, even before the shape catches up', async () => {
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'A', hashB64: null, signSkey });
		const accepted = await getAccepted('user_storage', `${USER}|${SLOT}`);
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'B', hashB64: null, signSkey });

		const calls = (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0]?.at(-1)).toBe('insert');
		expect(calls[1]?.at(-1)).toBe('update');
		expect(calls[1]?.[9]).toBe(accepted?.sign_hash);
	});

	it('does not let independent slots block each other', async () => {
		const OTHER_SLOT = '9f9a5f2e-1111-4222-8333-abcdefabcdef';
		let releaseA: (() => void) | null = null;
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>).mockImplementationOnce(async (mutations: unknown[]) => {
			await new Promise<void>((r) => { releaseA = r; });
			return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }) };
		});

		const a = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'A', hashB64: null, signSkey });
		const other = await upsertStorageRow({ userHash: USER, uuid: OTHER_SLOT, valueB64: 'other', hashB64: null, signSkey });
		expect((await other.sync).status).toBe('synced');

		releaseA!();
		await a;
	});

	it('provisionalRow keeps owner_timestamp strictly increasing across back-to-back edits to the same slot, even within the same wall-clock second', async () => {
		const first = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });
		expect((await first.sync).status).toBe('synced');
		const firstTs = Number(first.row.owner_timestamp);

		let releaseSecond: (() => void) | null = null;
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>).mockImplementationOnce(async (mutations: unknown[]) => {
			await new Promise<void>((r) => { releaseSecond = r; });
			return { status: 200, json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 200 + index })) }) };
		});
		const secondPending = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v2', hashB64: null, signSkey });

		await vi.waitFor(() => expect((kv.get(`us|${USER}|${SLOT}`) as { syncStatus: string } | undefined)?.syncStatus).toBe('syncing'));
		const projectedTs = (kv.get(`us|${USER}|${SLOT}`) as { row: { owner_timestamp: number } }).row.owner_timestamp;

		expect(projectedTs).toBeGreaterThan(firstTs);

		releaseSecond!();
		await secondPending;
	});
});

describe('getStorageRow', () => {
	it('prefers the newer revision by owner_timestamp', async () => {
		collection.rows.set(`${USER}|${SLOT}`, serverRow(5000));
		kv.set(`us|${USER}|${SLOT}`, {
			row: { ...serverRow(1000), value_b64: 'stale-local' },
			hash_b64: null,
			syncStatus: 'synced',
		});
		const row = await getStorageRow(USER, SLOT);
		expect(row?.value_b64).toBe('server');
	});

	it('falls back to the local row when the server is unreachable', async () => {
		collection.preloadError = new Error('down');
		kv.set(`us|${USER}|${SLOT}`, {
			row: { ...serverRow(1000), value_b64: 'local-only' },
			hash_b64: null,
			syncStatus: 'failed',
		});
		const row = await getStorageRow(USER, SLOT);
		expect(row?.value_b64).toBe('local-only');
	});
});

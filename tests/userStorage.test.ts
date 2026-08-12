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

// The module under test uses sendMutationsAndAwaitShape, whose contract is
// "returns only after the committed txid is visible in the collection". The
// mock therefore models both halves: the HTTP result AND shape delivery.
const sendAndAwait = vi.fn(async () => ({ txids: [1], results: [] }));
vi.mock('../src/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: (...args: unknown[]) => sendAndAwait(...(args as [])),
	sendMutationsWithRetry: (...args: unknown[]) => sendAndAwait(...(args as [])),
}));

const { upsertStorageRow, getStorageRow, STORAGE_SLOTS } = await import('../src/lib/data/userStorage');

const USER = 'u_' + 'ab'.repeat(64);
const SLOT = STORAGE_SLOTS.profile;
const signSkey = new Uint8Array(32).fill(7);

// The signing helper is exercised elsewhere; here we only care about which
// mutation type is produced, so stub the builder.
vi.mock('@/api/client', () => ({
	api: {
		createStorageMutation: vi.fn((userHash, uuid, valueB64, _h, _v, ownerTimestamp, _sk, _d, _df, parentSignHash, _sh, _sb, mutationType) => ({
			type: mutationType,
			[mutationType === 'insert' ? 'modified' : 'changes']: {
				user_hash: userHash, uuid, value_b64: valueB64,
				owner_timestamp: ownerTimestamp, parent_sign_hash: parentSignHash,
				sign_hash: 'uss_' + 'f'.repeat(128), sign_b64: 'sig',
			},
			syncMetadata: { relation: 'user_storage' },
		})),
	},
}));
const { api } = await import('@/api/client');

beforeEach(() => {
	kv.clear();
	collection.rows.clear();
	collection.preloadError = null;
	vi.clearAllMocks();
	sendAndAwait.mockImplementation(async () => ({ txids: [1], results: [] }));
});

afterEach(() => vi.clearAllMocks());

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
	// unknown base guarantees a conflict once connectivity returns.
	it('signs nothing when the server state is unavailable', async () => {
		collection.preloadError = new Error('node unreachable');
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });

		expect(api.createStorageMutation).not.toHaveBeenCalled();
		expect(sendAndAwait).not.toHaveBeenCalled();
		expect((await res.sync).status).toBe('failed');
		// the user's edit is still kept locally
		expect(kv.get(`us|${USER}|${SLOT}`)).toMatchObject({ syncStatus: 'failed', row: { value_b64: 'v1' } });
	});
});

// Precondition for avatar ordering (review finding 3): the caller publishes
// the avatar uuid inside the profile revision, so it must be able to tell that
// the avatar write was rejected. EncryptionManagerPQ turns this status into a
// throw before the profile is signed.
describe('upsertStorageRow: failure is reported to the caller', () => {
	it('reports failed sync when the server rejects the write', async () => {
		sendAndAwait.mockImplementationOnce(async () => {
			throw Object.assign(new Error('rejected'), { permanent: true });
		});
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v', hashB64: null, signSkey });
		const sync = await res.sync;
		expect(sync.status).toBe('failed');
		expect(kv.get(`us|${USER}|${SLOT}`)).toMatchObject({ syncStatus: 'failed' });
	});

	it('resolves only after the server verdict is known', async () => {
		let settled = false;
		sendAndAwait.mockImplementationOnce(async () => {
			await new Promise((r) => setTimeout(r, 20));
			settled = true;
			return { txids: [1], results: [] };
		});
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v', hashB64: null, signSkey });
		// the write is already decided by the time the caller gets the result
		expect(settled).toBe(true);
		expect((await res.sync).status).toBe('synced');
	});
});

describe('upsertStorageRow: per-slot serialization', () => {
	it('runs overlapping writes to one slot sequentially', async () => {
		const order: string[] = [];
		let release: (() => void) | null = null;
		sendAndAwait.mockImplementationOnce(async () => {
			order.push('A:start');
			await new Promise<void>((r) => { release = r; });
			order.push('A:end');
			return { txids: [1], results: [] };
		});
		sendAndAwait.mockImplementationOnce(async () => {
			order.push('B:start');
			return { txids: [2], results: [] };
		});

		const a = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'A', hashB64: null, signSkey });
		const b = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'B', hashB64: null, signSkey });

		await vi.waitFor(() => expect(release).toBeTruthy());
		release!();
		await Promise.all([a, b]);

		// B must not start before A finished
		expect(order).toEqual(['A:start', 'A:end', 'B:start']);
		// last write wins locally, regardless of network timing
		expect((kv.get(`us|${USER}|${SLOT}`) as { row: { value_b64: string } }).row.value_b64).toBe('B');
	});

	it('lets the second write see the first write as its base', async () => {
		// after A lands, the server row appears in the collection
		sendAndAwait.mockImplementationOnce(async () => {
			collection.rows.set(`${USER}|${SLOT}`, serverRow(2000, 'uss_' + 'b'.repeat(128)));
			return { txids: [1], results: [] };
		});

		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'A', hashB64: null, signSkey });
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'B', hashB64: null, signSkey });

		const calls = (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0]?.at(-1)).toBe('insert');
		expect(calls[1]?.at(-1)).toBe('update');
		expect(calls[1]?.[9]).toBe('uss_' + 'b'.repeat(128));
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

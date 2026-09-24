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
				sign_hash: signHash, sign_b64: 'sig' + signCallCount,
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

const { upsertStorageRow, upsertStorageJsonPatch } = await import('../src/lib/data/userStorage');
const {
	startLeaderElection, stopLeaderElection, stopDrainLoop, pendingEntries,
	quarantinedEntries, blockedEntries,
	_setStorageForTests: _setOutboxStorageForTests, _setLeaderForTests,
} = await import('../src/lib/data/outbox');
const { _setIntentStorageForTests, _clearIntentsForTests } = await import('../src/lib/data/intents');
const { _setAcceptedSnapshotStorageForTests, getAccepted } = await import('../src/lib/data/acceptedSnapshot');
const { recoverIntents } = await import('../src/lib/data/intentRecovery');
const { setStorageJsonCodec, materializeStorageIntent } = await import('../src/lib/data/storageIntent');
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
const ROOT = '85da8ea0-5bc8-856e-83e7-db7b542a1a58';
const CONTACTS = '9f9a5f2e-1111-4222-8333-abcdefabcdef';
const signSkey = new Uint8Array(32).fill(7);
const entityKey = `${USER}|${ROOT}`;

const okResult = (offset: number) => async (mutations: unknown[]) => ({
	status: 200,
	json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: offset + index })) }),
});
const conflictResult = async (mutations: unknown[]) => ({
	status: 422,
	json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'error', error: 'validation_failed', details: { uuid: ['has already been taken'] } })) }),
});

const rootRow = (slots: Record<string, string>, signHash: string, signB64: string, ts: number, parent: string | null = null) => ({
	user_hash: USER, uuid: ROOT,
	value_b64: JSON.stringify({ slots }),
	deleted_flag: false, parent_sign_hash: parent, sign_hash: signHash, owner_timestamp: ts, sign_b64: signB64,
});

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
	setStorageJsonCodec({
		decrypt: async (valueB64: string) => JSON.parse(valueB64),
		encrypt: async (value: Record<string, unknown>) => ({ valueB64: JSON.stringify(value), hashB64: null }),
	});
	startLeaderElection(USER, () => {});
	_setLeaderForTests(true);
});

afterEach(() => {
	setStorageJsonCodec(null);
	vi.clearAllMocks();
	_setLeaderForTests(null);
	stopLeaderElection();
	stopDrainLoop();
});

describe('1&2. different-slot concurrent conflict (Case A) reconciles; the conflicted attempt stays immutable', () => {
	it('rereads the winning revision, preserves the other device\'s slot, reapplies this device\'s slot, and signs the correct next revision', async () => {
		collection.rows.set(entityKey, rootRow({ alpha: 'A0' }, 'server-h10', 'sig-server-10', 1000));

		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				collection.rows.set(entityKey, rootRow({ alpha: 'A0', beta: 'B1' }, 'server-h11', 'sig-server-11', 1001, 'server-h10'));
				return conflictResult(mutations);
			})
			.mockImplementationOnce(okResult(200));

		const res = await upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { slots: { alpha: 'A1' } }, signSkey });
		expect((await res.sync).status).toBe('synced');

		const calls = (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[1]?.[9]).toBe('server-h11');
		expect(JSON.parse(res.row.value_b64 as string).slots).toEqual({ alpha: 'A1', beta: 'B1' });
	});

	it('never mutates the original conflicted outbox entry in place — a fresh replacement is created instead', async () => {
		collection.rows.set(entityKey, rootRow({ alpha: 'A0' }, 'server-h10', 'sig-server-10', 1000));

		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				collection.rows.set(entityKey, rootRow({ alpha: 'A0', beta: 'B1' }, 'server-h11', 'sig-server-11', 1001, 'server-h10'));
				return conflictResult(mutations);
			})
			.mockImplementationOnce(okResult(200));

		await upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { slots: { alpha: 'A1' } }, signSkey });

		const mutationResults = (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.results;
		const originalMutation = mutationResults[0].value;
		const replacementMutation = mutationResults[1].value;

		const quarantined = await quarantinedEntries(USER);
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0].mutations).toEqual([originalMutation]);

		const originalRow = originalMutation.changes ?? originalMutation.modified;
		const replacementRow = replacementMutation.changes ?? replacementMutation.modified;
		expect(replacementRow.sign_hash).not.toBe(originalRow.sign_hash);
		expect(replacementRow.parent_sign_hash).not.toBe(originalRow.parent_sign_hash);
		expect(replacementRow.owner_timestamp).toBeGreaterThanOrEqual(originalRow.owner_timestamp);
	});
});

describe('3. same-slot conflict (Case B) follows the one documented policy, never a silent destructive merge', () => {
	it('an opaque replace-kind write reapplies its own payload verbatim onto the winning revision — no partial merge is invented for opaque content', async () => {
		collection.rows.set(`${USER}|${CONTACTS}`, {
			user_hash: USER, uuid: CONTACTS, value_b64: 'device-A-base', deleted_flag: false,
			parent_sign_hash: null, sign_hash: 'server-h10', owner_timestamp: 1000, sign_b64: 'sig-base',
		});

		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				collection.rows.set(`${USER}|${CONTACTS}`, {
					user_hash: USER, uuid: CONTACTS, value_b64: 'device-B-contacts', deleted_flag: false,
					parent_sign_hash: 'server-h10', sign_hash: 'server-h11', owner_timestamp: 1001, sign_b64: 'sig-B',
				});
				return conflictResult(mutations);
			})
			.mockImplementationOnce(okResult(500));

		const res = await upsertStorageRow({ userHash: USER, uuid: CONTACTS, valueB64: 'device-A-contacts', hashB64: null, signSkey });
		expect((await res.sync).status).toBe('synced');

		const calls = (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[1]?.[2]).toBe('device-A-contacts');
		expect(calls[1]?.[9]).toBe('server-h11');
		expect(res.row.value_b64).toBe('device-A-contacts');
	});

	it('a same-field jsonPatch conflict lets the reconciling device\'s reapplied intent win that field; untouched fields from the base survive', async () => {
		collection.rows.set(entityKey, rootRow({ alpha: 'A0', beta: 'unrelated' }, 'server-h10', 'sig-base', 1000));

		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				collection.rows.set(entityKey, rootRow({ alpha: 'device-B-alpha', beta: 'unrelated' }, 'server-h11', 'sig-B', 1001, 'server-h10'));
				return conflictResult(mutations);
			})
			.mockImplementationOnce(okResult(600));

		const res = await upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { slots: { alpha: 'device-A-alpha' } }, signSkey });
		expect((await res.sync).status).toBe('synced');
		expect(JSON.parse(res.row.value_b64 as string).slots).toEqual({ alpha: 'device-A-alpha', beta: 'unrelated' });
	});
});

describe('4. reconciliation is bounded — it never loops forever', () => {
	it('multiple consecutive conflicts each reconcile safely and the write still succeeds once the race is finally won', async () => {
		collection.rows.set(entityKey, rootRow({ alpha: 'A0' }, 'server-h10', 'sig-server-10', 1000));

		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(conflictResult)
			.mockImplementationOnce(conflictResult)
			.mockImplementationOnce(conflictResult)
			.mockImplementationOnce(okResult(700));

		const res = await upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { slots: { alpha: 'A1' } }, signSkey });
		expect((await res.sync).status).toBe('synced');
		expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
	}, 10000);

	it('a device that keeps losing the race gives up after the bounded number of attempts instead of retrying forever', async () => {
		collection.rows.set(entityKey, rootRow({ alpha: 'A0' }, 'server-h10', 'sig-server-10', 1000));
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>).mockImplementation(conflictResult);

		const res = await upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { slots: { alpha: 'A1' } }, signSkey });
		expect((await res.sync).status).toBe('failed');

		const finalCallCount = (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls.length;
		expect(finalCallCount).toBe(4);

		await new Promise((r) => setTimeout(r, 500));
		expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls.length).toBe(finalCallCount);

		const quarantined = await quarantinedEntries(USER);
		expect(quarantined.length).toBe(4);
	}, 10000);
});

describe('5. reload during reconciliation resumes without losing intent or duplicating the write', () => {
	it('a crash before the replacement intent resolves is healed by recovery, without re-signing or losing the merged content', async () => {
		collection.rows.set(entityKey, rootRow({ alpha: 'A0' }, 'server-h10', 'sig-server-10', 1000));

		const flakyIntents = makeStorage();
		let failResolve = false;
		const realSet = flakyIntents.set.bind(flakyIntents);
		flakyIntents.set = async (k: string, v: string) => {
			if (failResolve && v.includes('"resolved":true')) throw new Error('simulated crash before resolve');
			return realSet(k, v);
		};
		_setIntentStorageForTests(flakyIntents);
		failResolve = true;

		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				collection.rows.set(entityKey, rootRow({ alpha: 'A0', beta: 'B1' }, 'server-h11', 'sig-server-11', 1001, 'server-h10'));
				return conflictResult(mutations);
			})
			.mockImplementationOnce(okResult(800));

		const res = await upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { slots: { alpha: 'A1' } }, signSkey });
		expect((await res.sync).status).toBe('synced');
		expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);

		failResolve = false;
		await recoverIntents(USER, signSkey, { materializeStorage: materializeStorageIntent });

		expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
		const accepted = await getAccepted('user_storage', entityKey);
		expect(JSON.parse((accepted as { value_b64: string }).value_b64).slots).toEqual({ alpha: 'A1', beta: 'B1' });
	});
});

describe('6. a pending descendant of a conflicted write stays blocked, never dispatched with a stale parent', () => {
	it('B, chained onto A, is never sent to the server while A is quarantined, even after A\'s replacement succeeds', async () => {
		collection.rows.set(entityKey, rootRow({ alpha: 'A0' }, 'server-h10', 'sig-server-10', 1000));

		let releaseA: (() => void) | null = null;
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				await new Promise<void>((r) => { releaseA = r; });
				collection.rows.set(entityKey, rootRow({ alpha: 'A0', beta: 'B1' }, 'server-h11', 'sig-server-11', 1001, 'server-h10'));
				return conflictResult(mutations);
			})
			.mockImplementationOnce(okResult(900));

		const a = upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { slots: { alpha: 'A1' } }, signSkey });
		await vi.waitFor(() => expect(releaseA).toBeTruthy());

		const bPromise = upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { slots: { gamma: 'G1' } }, signSkey });
		await vi.waitFor(async () => expect((await pendingEntries(USER)).length).toBeGreaterThanOrEqual(2));

		releaseA!();
		await a;

		expect((api.ingestWithAuthEach as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
		const blocked = await blockedEntries(USER);
		expect(blocked.some((e) => e.relation === 'user_storage')).toBe(true);

		void bPromise;
	});
});

describe('7. a lost response for the reconciled replacement resolves via the existing identity check, not a second replacement', () => {
	it('a dropped response after the replacement is actually accepted is recovered as an idempotent replay', async () => {
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				collection.rows.set(`${USER}|${CONTACTS}`, {
					user_hash: USER, uuid: CONTACTS, value_b64: 'other-device-contacts', deleted_flag: false,
					parent_sign_hash: null, sign_hash: 'server-contacts-1', owner_timestamp: 1000, sign_b64: 'other-sig',
				});
				return conflictResult(mutations);
			})
			.mockImplementationOnce(async () => { throw new Error('response lost'); })
			.mockImplementationOnce(async (mutations: unknown[]) => ({
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'exists', conflicted: false })) }),
			}));

		const res = await upsertStorageRow({ userHash: USER, uuid: CONTACTS, valueB64: 'contacts-v1', hashB64: null, signSkey });
		expect((await res.sync).status).toBe('synced');
		expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
	}, 10000);
});

describe('8. reconciliation serializes construct-sign-persist only, never the network wait', () => {
	it('a concurrent write to the same slot signs and durably enqueues on top of the replacement while its HTTP request is still open', async () => {
		collection.rows.set(entityKey, rootRow({ alpha: 'A0' }, 'server-h10', 'sig-server-10', 1000));

		let releaseReplacement: (() => void) | null = null;
		(api.ingestWithAuthEach as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(async (mutations: unknown[]) => {
				collection.rows.set(entityKey, rootRow({ alpha: 'A0', beta: 'B1' }, 'server-h11', 'sig-server-11', 1001, 'server-h10'));
				return conflictResult(mutations);
			})
			.mockImplementationOnce(async (mutations: unknown[]) => {
				await new Promise<void>((r) => { releaseReplacement = r; });
				return (await okResult(1000)(mutations));
			})
			.mockImplementationOnce(okResult(1100));

		const a = upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { slots: { alpha: 'A1' } }, signSkey });
		await vi.waitFor(() => expect(releaseReplacement).toBeTruthy());
		expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);

		const c = upsertStorageJsonPatch({ userHash: USER, uuid: ROOT, jsonPatch: { slots: { delta: 'D1' } }, signSkey });
		await vi.waitFor(() => expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3));
		await vi.waitFor(async () => expect((await pendingEntries(USER)).length).toBeGreaterThanOrEqual(2));

		releaseReplacement!();
		await a;
		void c;
	}, 10000);
});

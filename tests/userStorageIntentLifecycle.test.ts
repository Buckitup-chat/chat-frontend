import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const USER = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);
const SLOT = '85da8ea0-5bc8-856e-83e7-db7b542a1a58';
const signSkey = new Uint8Array(32).fill(7);

const kv = new Map<string, unknown>();
vi.mock('@/lib/data/localStore', () => ({
	kvGet: vi.fn(async (k: string) => kv.get(k)),
	kvSet: vi.fn(async (k: string, v: unknown) => { kv.set(k, v); }),
	kvDelete: vi.fn(async (k: string) => { kv.delete(k); }),
}));

const collections = new Map<string, { rows: Map<string, unknown>; preload: () => Promise<void>; get: (k: string) => unknown }>();
const collectionFor = (userHash: string) => {
	let c = collections.get(userHash);
	if (!c) {
		const rows = new Map<string, unknown>();
		c = { rows, preload: async () => {}, get: (k: string) => rows.get(k) };
		collections.set(userHash, c);
	}
	return c;
};
vi.mock('@/lib/data/collections', () => ({
	getUserStorageCollection: (userHash: string) => collectionFor(userHash),
}));

let signCallCount = 0;
let sent: unknown[][] = [];
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

const { upsertStorageRow } = await import('@/lib/data/userStorage');
const { recoverIntents, signAndDispatchIntent } = await import('@/lib/data/intentRecovery');
const { materializeStorageIntent } = await import('@/lib/data/storageIntent');
const {
	enqueueIntent, getIntent, intentsOf, _setIntentStorageForTests, _clearIntentsForTests,
} = await import('@/lib/data/intents');
const {
	_setStorageForTests, startLeaderElection, stopLeaderElection, stopDrainLoop,
	pendingEntries, _setLeaderForTests, currentSessionToken, _setAtomicLeaseStoreForTests,
} = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests, getAccepted } = await import('@/lib/data/acceptedSnapshot');
const { drainPendingWrites } = await import('@/lib/data/ingest');
const { api } = await import('@/api/client');

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

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
	collections.clear();
	sent = [];
	signCallCount = 0;
	vi.clearAllMocks();
	_setIntentStorageForTests(makeStorage());
	await _clearIntentsForTests();
	_setStorageForTests(makeStorage());
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setAtomicLeaseStoreForTests(makeLeaseStore());
	startLeaderElection(USER, () => {});
});

afterEach(() => {
	_setLeaderForTests(null);
	stopDrainLoop();
	stopLeaderElection();
	_setAtomicLeaseStoreForTests(null);
});

describe('durable intent precedes signing and network (§1)', () => {
	it('a locked vault (no signing key) commits a durable intent without signing or sending anything', async () => {
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey: null });

		expect(api.createStorageMutation).not.toHaveBeenCalled();
		expect(api.ingestWithAuthEach).not.toHaveBeenCalled();
		expect((await res.sync).status).toBe('awaiting-recovery');

		const { entries } = await intentsOf(USER);
		expect(entries).toHaveLength(1);
		expect(entries[0].intent).toMatchObject({ kind: 'storage', uuid: SLOT, valueB64: 'v1', deletedFlag: false });
	});

	it('waiting on a signing key never creates an outbox entry, so it never accrues retry attempts', async () => {
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey: null });
		expect(await pendingEntries(USER)).toHaveLength(0);
	});
});

describe('recovery resumes the exact durable intent after a key/base becomes available (§2, §3, §4)', () => {
	it('materializes and signs the intent exactly once when recovery runs with a key', async () => {
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey: null });

		await recoverIntents(USER, signSkey, { materializeStorage: materializeStorageIntent });

		expect(api.createStorageMutation).toHaveBeenCalledTimes(1);
		expect((api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls[0]?.at(-1)).toBe('insert');
		expect(sent).toHaveLength(1);
		expect((await intentsOf(USER)).entries).toHaveLength(0);

		await recoverIntents(USER, signSkey, { materializeStorage: materializeStorageIntent });
		expect(api.createStorageMutation).toHaveBeenCalledTimes(1);
		expect(sent).toHaveLength(1);
	});

	it('resolves against the base known at recovery time, not at intent-creation time', async () => {
		const id = await enqueueIntent(
			{ kind: 'storage' as const, relation: 'user_storage' as const, userHash: USER, uuid: SLOT, valueB64: 'v1', deletedFlag: false, revision: 0 },
			USER,
			'user_storage'
		);
		expect(id).toBeTruthy();

		collectionFor(USER).rows.set(`${USER}|${SLOT}`, {
			user_hash: USER, uuid: SLOT, value_b64: 'other-device', deleted_flag: false,
			parent_sign_hash: null, sign_hash: 'uss_' + 'e'.repeat(128), owner_timestamp: 500, sign_b64: 'sig',
		});

		await recoverIntents(USER, signSkey, { materializeStorage: materializeStorageIntent });

		const call = (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call?.at(-1)).toBe('update');
		expect(call?.[9]).toBe('uss_' + 'e'.repeat(128));
	});

	it('does not touch a durable intent belonging to a different account', async () => {
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'mine', hashB64: null, signSkey: null });
		await enqueueIntent(
			{ kind: 'storage' as const, relation: 'user_storage' as const, userHash: OTHER_HASH, uuid: SLOT, valueB64: 'theirs', deletedFlag: false, revision: 0 },
			OTHER_HASH,
			'user_storage'
		);

		await recoverIntents(USER, signSkey, { materializeStorage: materializeStorageIntent });

		expect(sent).toHaveLength(1);
		expect((await intentsOf(OTHER_HASH)).entries).toHaveLength(1);
	});

	it('without a registered storage materializer, the intent is left durable — not dropped, not treated as a network failure', async () => {
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey: null });
		await recoverIntents(USER, signSkey);

		expect(sent).toHaveLength(0);
		expect((await intentsOf(USER)).entries).toHaveLength(1);
		expect((await res.sync).status).toBe('awaiting-recovery');
	});
});

describe('materializeStorageIntent refuses a mismatched account (§12)', () => {
	it('throws instead of trusting the caller when the token account does not match the payload', async () => {
		const token = currentSessionToken()!;
		const payload = { kind: 'storage' as const, relation: 'user_storage' as const, userHash: OTHER_HASH, uuid: SLOT, valueB64: 'x', deletedFlag: false, revision: 0 };
		await expect(materializeStorageIntent(payload, token)).rejects.toThrow(/does not match/);
	});
});

describe('crash-safe handoff from intent to signed outbox snapshot (§4)', () => {
	const makeFlakyIntentStorage = () => {
		const map = new Map<string, string>();
		const control = { failConfirmation: false };
		const storage = {
			async get(k: string) { return map.get(k) ?? null; },
			async set(k: string, v: string) {
				if (control.failConfirmation && (v.includes('"dispatchConfirmed":true') || v.includes('"resolved":true'))) {
					throw new Error('simulated crash — dispatch confirmation never lands');
				}
				map.set(k, v);
			},
			async delete(k: string) { map.delete(k); },
			async keys() { return [...map.keys()]; },
			async clear() { map.clear(); },
		};
		return { storage, control };
	};

	it('a crash right after the outbox commit (before the intent is marked resolved) never produces a second mutation', async () => {
		const { storage, control } = makeFlakyIntentStorage();
		_setIntentStorageForTests(storage);
		const readyRow = { kind: 'ready-row' as const, relation: 'user_storage', row: { user_hash: USER, uuid: SLOT, value_b64: 'v1', deleted_flag: false, owner_timestamp: 1000, parent_sign_hash: null }, mutationType: 'insert' as const };
		const id = (await enqueueIntent(readyRow, USER, 'user_storage'))!;

		control.failConfirmation = true;
		const first = await signAndDispatchIntent(id, readyRow, signSkey);
		expect(first.phase).toBe('accepted');
		expect(signCallCount).toBe(1);
		expect(sent).toHaveLength(1);

		const afterFirst = await getIntent(id);
		expect((afterFirst!.intent as Record<string, unknown>).resolved).toBeFalsy();

		control.failConfirmation = false;
		const second = await signAndDispatchIntent(id, readyRow, signSkey);
		expect(signCallCount).toBe(1);
		expect(sent).toHaveLength(1);
		expect(second.outboxId).toBeTruthy();
		expect((await getIntent(id))?.intent).toMatchObject({ resolved: true, ref: second.outboxId });
	});

	it('two recovery passes for the same still-unresolved intent (simulating two tabs) produce one signature and one outbox entry', async () => {
		const { storage, control } = makeFlakyIntentStorage();
		_setIntentStorageForTests(storage);
		const readyRow = { kind: 'ready-row' as const, relation: 'user_storage', row: { user_hash: USER, uuid: SLOT, value_b64: 'v1', deleted_flag: false, owner_timestamp: 1000, parent_sign_hash: null }, mutationType: 'insert' as const };
		const id = (await enqueueIntent(readyRow, USER, 'user_storage'))!;

		control.failConfirmation = true;
		await signAndDispatchIntent(id, readyRow, signSkey);
		control.failConfirmation = false;
		await signAndDispatchIntent(id, readyRow, signSkey);

		expect(signCallCount).toBe(1);
		expect(sent).toHaveLength(1);
	});

	it('a concurrent live dispatch and recovery pass for the SAME intent id produce exactly one signature', async () => {
		const readyRow = { kind: 'ready-row' as const, relation: 'user_storage', row: { user_hash: USER, uuid: SLOT, value_b64: 'v1', deleted_flag: false, owner_timestamp: 1000, parent_sign_hash: null }, mutationType: 'insert' as const };
		const id = (await enqueueIntent(readyRow, USER, 'user_storage'))!;

		const [a, b] = await Promise.all([
			signAndDispatchIntent(id, readyRow, signSkey),
			signAndDispatchIntent(id, readyRow, signSkey),
		]);

		expect(signCallCount).toBe(1);
		expect(sent).toHaveLength(1);
		expect(a).toBe(b);
	});
});

describe('replay-only acceptance still updates the durable accepted local base (§5)', () => {
	it('records the accepted snapshot via the outbox drain path, even though the original caller never inspects the result', async () => {
		_setLeaderForTests(false);

		const write = upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });
		await vi.waitFor(async () => expect(await pendingEntries(USER)).toHaveLength(1));
		expect(sent).toHaveLength(0);

		_setLeaderForTests(true);
		drainPendingWrites(USER, signSkey);

		await vi.waitFor(async () => expect(await getAccepted('user_storage', `${USER}|${SLOT}`)).toBeTruthy());
		const accepted = await getAccepted('user_storage', `${USER}|${SLOT}`);
		expect(accepted?.value_b64).toBe('v1');

		await write;
	});
});

describe('an accepted mutation is never re-sent just because local reconciliation failed once (§5)', () => {
	it('retries only the accepted-snapshot write, not the HTTP request', async () => {
		let failReconcile = true;
		const flakyAccepted = makeStorage();
		const realSet = flakyAccepted.set.bind(flakyAccepted);
		flakyAccepted.set = async (k: string, v: string) => {
			if (failReconcile) { failReconcile = false; throw new Error('simulated accepted-snapshot write failure'); }
			return realSet(k, v);
		};
		_setAcceptedSnapshotStorageForTests(flakyAccepted);

		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'v1', hashB64: null, signSkey });
		expect((await res.sync).status).toBe('synced');
		expect(sent).toHaveLength(1);
		expect(await getAccepted('user_storage', `${USER}|${SLOT}`)).toBeNull();

		drainPendingWrites(USER, signSkey);
		await vi.waitFor(async () => expect(await getAccepted('user_storage', `${USER}|${SLOT}`)).toBeTruthy());
		await vi.waitFor(async () => expect(await pendingEntries(USER)).toHaveLength(0));
		expect(sent).toHaveLength(1);
	});
});

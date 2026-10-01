import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestIdentity, signedStorageRow } from './helpers/signedFixtures';

const ME = makeTestIdentity(11, 'me');
const USER = ME.userHash;
const OTHER = 'u_' + 'b'.repeat(128);
const SLOT = '85da8ea0-5bc8-856e-83e7-db7b542a1a58';
const signSkey = new Uint8Array(32).fill(7);
const hashOf = (c: string) => 'uss_' + c.repeat(128);

const kv = new Map<string, unknown>();
vi.mock('@/lib/data/localStore', () => ({
	kvGet: vi.fn(async (k: string) => kv.get(k)),
	kvSet: vi.fn(async (k: string, v: unknown) => { kv.set(k, v); }),
	kvDelete: vi.fn(async (k: string) => { kv.delete(k); }),
}));

interface FakeShape {
	rows: Map<string, unknown>;
	preload: () => Promise<void>;
	get: (k: string) => unknown;
	utils: { awaitMatch: (fn: (m: unknown) => boolean) => Promise<boolean> };
	goLive: () => void;
	fail: () => void;
}
let shape: FakeShape;
const cards = new Map<string, unknown>();
vi.mock('@/lib/data/collections', () => ({
	getUserStorageCollection: () => shape,
	getUserCardsCollection: () => ({ preload: async () => {}, get: (k: string) => cards.get(k) }),
}));

let signCallCount = 0;
let sent: unknown[][] = [];
vi.mock('@/api/client', () => ({
	api: {
		createStorageMutation: vi.fn((userHash: string, uuid: string, valueB64: string, _h: unknown, _v: unknown, ownerTimestamp: number, _sk: unknown, _d: unknown, deletedFlag: boolean, parentSignHash: string | null, _sh: unknown, _sb: unknown, mutationType: string) => {
			signCallCount += 1;
			const row = {
				user_hash: userHash, uuid, value_b64: valueB64, deleted_flag: deletedFlag,
				owner_timestamp: ownerTimestamp, parent_sign_hash: parentSignHash,
				sign_hash: 'uss_' + String(signCallCount).padStart(128, '0'), sign_b64: 'sig',
			};
			return {
				type: mutationType,
				...(mutationType === 'insert' ? { modified: row } : { original: {}, changes: row }),
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

const { createShapeLink, registerShapeLink, whenLive } = await import('@/lib/data/shapeLink');
const { upsertStorageRow } = await import('@/lib/data/userStorage');
const { recoverIntents } = await import('@/lib/data/intentRecovery');
const {
	materializeStorageIntent, resolveStorageBase, setStorageJsonCodec, BaseUnavailableError,
} = await import('@/lib/data/storageIntent');
const { enqueueIntent, intentsOf, _setIntentStorageForTests } = await import('@/lib/data/intents');
const {
	_setStorageForTests, startLeaderElection, stopLeaderElection, stopDrainLoop, enqueue,
	pendingEntries, _setLeaderForTests, currentSessionToken, _setAtomicLeaseStoreForTests, SessionFencedError,
} = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { VaultLockedError } = await import('@/lib/data/keyCustody');
const { DecryptFailedError } = await import('@/lib/data/secureStore');
const { api } = await import('@/api/client');

const makeShape = (): FakeShape => {
	const rows = new Map<string, unknown>();
	const matchers = new Set<{ fn: (m: unknown) => boolean; resolve: (v: boolean) => void }>();
	const link = createShapeLink();
	const fake: FakeShape = {
		rows, preload: async () => {}, get: (k) => rows.get(k),
		utils: { awaitMatch: (fn) => new Promise<boolean>((resolve) => matchers.add({ fn, resolve })) },
		goLive: () => {
			for (const m of [...matchers]) if (m.fn({ headers: { control: 'up-to-date' } })) { matchers.delete(m); m.resolve(true); }
		},
		fail: () => link.report(),
	};
	registerShapeLink(fake, link);
	return fake;
};

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		failGet: null as null | ((k: string) => Error | null),
		async get(k: string) {
			const error = this.failGet?.(k);
			if (error) throw error;
			return map.get(k) ?? null;
		},
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
			if (map.get(userHash)?.instanceId === ownerId) map.delete(userHash);
		},
	};
};

const row = (ts: number, sign: string, extra: Record<string, unknown> = {}) => ({
	user_hash: USER, uuid: SLOT, value_b64: `v${ts}`, deleted_flag: false,
	parent_sign_hash: null, owner_timestamp: ts, sign_b64: 'sig', sign_hash: hashOf(sign), ...extra,
});
const shapeRow = (ts: number, extra: Record<string, unknown> = {}) =>
	signedStorageRow(ME, { uuid: SLOT, value_b64: `v${ts}`, owner_timestamp: ts, ...extra });
const storagePayload = (extra: Record<string, unknown> = {}) => ({
	kind: 'storage' as const, relation: 'user_storage' as const, userHash: USER, uuid: SLOT,
	valueB64: 'next', deletedFlag: false, revision: 0, ...extra,
});

let intents: ReturnType<typeof makeStorage>;
let outbox: ReturnType<typeof makeStorage>;
let accepted: ReturnType<typeof makeStorage>;
const acceptedKey = `user_storage:${USER}|${SLOT}`;
const storeAccepted = (value: unknown) => accepted.map.set(acceptedKey, JSON.stringify(value));

const signCalls = () => (api.createStorageMutation as ReturnType<typeof vi.fn>).mock.calls;
const token = () => currentSessionToken()!;

async function expectNothingBuilt(): Promise<void> {
	expect(api.createStorageMutation).not.toHaveBeenCalled();
	expect(api.ingestWithAuthEach).not.toHaveBeenCalled();
	expect(await pendingEntries(USER)).toHaveLength(0);
	const { entries } = await intentsOf(USER);
	expect(entries).toHaveLength(1);
	expect(entries[0].intent).toMatchObject({ kind: 'storage', uuid: SLOT });
	expect(entries[0].intent).not.toHaveProperty('signedMutation');
}

beforeEach(() => {
	kv.clear();
	cards.clear();
	cards.set(USER, ME.card);
	sent = [];
	signCallCount = 0;
	vi.clearAllMocks();
	shape = makeShape();
	intents = makeStorage();
	outbox = makeStorage();
	accepted = makeStorage();
	_setIntentStorageForTests(intents);
	_setStorageForTests(outbox);
	_setAcceptedSnapshotStorageForTests(accepted);
	_setAtomicLeaseStoreForTests(makeLeaseStore());
	startLeaderElection(USER, () => {});
});

afterEach(() => {
	setStorageJsonCodec(null);
	_setLeaderForTests(null);
	stopDrainLoop();
	stopLeaderElection();
	_setAtomicLeaseStoreForTests(null);
});

describe('update from the freshest proven base', () => {
	it('accepted present, shape unavailable → update from the accepted base', async () => {
		storeAccepted(row(200, 'a'));
		shape.fail();

		const ready = await materializeStorageIntent(storagePayload(), token());

		expect(ready.mutationType).toBe('update');
		expect(ready.row).toMatchObject({ parent_sign_hash: hashOf('a') });
		expect(ready.row.owner_timestamp).toBeGreaterThan(200);
	});

	it('a readable pending outbox write newer than accepted and shape → update from the pending base', async () => {
		shape.rows.set(`${USER}|${SLOT}`, shapeRow(100));
		shape.goLive();
		storeAccepted(row(150, 'a'));
		await enqueue([{ type: 'update', original: {}, changes: row(300, 'p'), syncMetadata: { relation: 'user_storage' } }], USER);

		const ready = await materializeStorageIntent(storagePayload(), token());

		expect(ready.mutationType).toBe('update');
		expect(ready.row).toMatchObject({ parent_sign_hash: hashOf('p') });
		expect(ready.row.owner_timestamp).toBeGreaterThan(300);
	});

	it('a signed intent not yet in the outbox is a pending base too', async () => {
		shape.goLive();
		await enqueueIntent({
			kind: 'ready-row', relation: 'user_storage', mutationType: 'insert', row: row(400, 'x'),
			signedMutation: { type: 'insert', modified: row(400, 'x'), syncMetadata: { relation: 'user_storage' } },
		}, USER, 'user_storage');

		const decision = await resolveStorageBase(USER, SLOT, token());

		expect(decision).toMatchObject({ kind: 'update', base: { sign_hash: hashOf('x') } });
	});

	it('shape live with the row → update from it', async () => {
		const live = shapeRow(500);
		shape.rows.set(`${USER}|${SLOT}`, live);
		shape.goLive();

		const ready = await materializeStorageIntent(storagePayload(), token());

		expect(ready.mutationType).toBe('update');
		expect(ready.row).toMatchObject({ parent_sign_hash: live.sign_hash });
		expect(ready.row.owner_timestamp).toBeGreaterThan(500);
	});

	it('a tombstone is a row: update (undelete), never insert — from the shape and from the accepted snapshot', async () => {
		const tombstone = shapeRow(600, { deleted_flag: true, value_b64: '' });
		shape.rows.set(`${USER}|${SLOT}`, tombstone);
		shape.goLive();
		expect(await resolveStorageBase(USER, SLOT, token())).toMatchObject({ kind: 'update', base: { sign_hash: tombstone.sign_hash } });

		shape = makeShape();
		shape.goLive();
		storeAccepted(row(700, 'u', { deleted_flag: true, value_b64: '' }));
		const ready = await materializeStorageIntent(storagePayload(), token());
		expect(ready.mutationType).toBe('update');
		expect(ready.row).toMatchObject({ parent_sign_hash: hashOf('u'), deleted_flag: false });
	});
});

describe('insert only on proven absence', () => {
	it('accepted missing + shape live and missing + nothing pending → genuine insert', async () => {
		shape.goLive();

		const ready = await materializeStorageIntent(storagePayload(), token());

		expect(ready.mutationType).toBe('insert');
		expect(ready.row.parent_sign_hash).toBeNull();
	});

	it('shape failed with accepted missing → blocked, not insert', async () => {
		shape.fail();
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'replicated_unavailable' });
	});

	it('a shape that has not gone live yet is not absence: the decision waits, and a failure then blocks it', async () => {
		let answered = false;
		let acceptedReads = 0;
		const get = accepted.get.bind(accepted);
		accepted.get = async (k: string) => { acceptedReads++; return get(k); };
		const decision = resolveStorageBase(USER, SLOT, token()).finally(() => { answered = true; });
		await vi.waitFor(() => expect(acceptedReads).toBe(1));
		expect(answered).toBe(false);

		shape.fail();
		expect(await decision).toEqual({ kind: 'blocked', reason: 'replicated_unavailable' });
	});

	it('a failed stream keeps rows it had, but they prove nothing: blocked, not an update on them', async () => {
		shape.rows.set(`${USER}|${SLOT}`, shapeRow(800));
		shape.fail();
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'replicated_unavailable' });
	});
});

describe('a shape that was live proves nothing after its stream fails', () => {
	it('live and missing, then a stream failure → blocked, not insert', async () => {
		shape.goLive();
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'insert' });

		shape.fail();
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'replicated_unavailable' });
	});

	it('live and present, then a stream failure → blocked, not an update on the stale row', async () => {
		const live = shapeRow(100);
		shape.rows.set(`${USER}|${SLOT}`, live);
		shape.goLive();
		expect(await resolveStorageBase(USER, SLOT, token())).toMatchObject({ kind: 'update', base: { sign_hash: live.sign_hash } });

		shape.fail();
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'replicated_unavailable' });
	});

	it('live → failure → a new up-to-date: the current state decides again', async () => {
		shape.goLive();
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'insert' });
		shape.fail();
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'replicated_unavailable' });
		const live = shapeRow(900);
		shape.rows.set(`${USER}|${SLOT}`, live);
		shape.goLive();
		await whenLive(shape);
		expect(await resolveStorageBase(USER, SLOT, token())).toMatchObject({ kind: 'update', base: { sign_hash: live.sign_hash } });

		shape.fail();
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'replicated_unavailable' });
		shape.rows.clear();
		shape.goLive();
		await whenLive(shape);
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'insert' });
	});

	it('an intent blocked after live → failure is the one recovery signs once the stream is live again', async () => {
		shape.goLive();
		await resolveStorageBase(USER, SLOT, token());
		shape.fail();
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'next', hashB64: null, signSkey });
		await expectNothingBuilt();
		const [{ id }] = (await intentsOf(USER)).entries;

		shape.goLive();
		await whenLive(shape);
		await recoverIntents(USER, signSkey, { materializeStorage: materializeStorageIntent });

		expect(signCalls()).toHaveLength(1);
		expect(signCalls()[0].at(-1)).toBe('insert');
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect((await intentsOf(USER, { includeResolved: true })).entries.map((e) => e.id)).toEqual([id]);
	});
});

describe('an unreadable accepted snapshot blocks before anything irreversible', () => {
	const blockedUpsert = async () => {
		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'next', hashB64: null, signSkey });
		expect((await res.sync).status).toBe('awaiting-recovery');
		await expectNothingBuilt();
	};

	it('accepted locked → blocked, even with a live shape row: 0 signing, 0 snapshot, 0 HTTP', async () => {
		shape.rows.set(`${USER}|${SLOT}`, shapeRow(100));
		shape.goLive();
		accepted.failGet = () => new VaultLockedError('locked');

		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'accepted_locked' });
		await blockedUpsert();
	});

	it('accepted corrupt (undecryptable, undecodable, foreign owner) → blocked', async () => {
		shape.goLive();
		accepted.failGet = () => new DecryptFailedError('bad tag');
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'accepted_corrupt' });

		accepted.failGet = null;
		accepted.map.set(acceptedKey, '{not json');
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'accepted_corrupt' });

		storeAccepted(row(100, 'a', { user_hash: OTHER }));
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'accepted_corrupt' });
		await blockedUpsert();
	});

	it('accepted unavailable → blocked', async () => {
		shape.goLive();
		accepted.failGet = () => new Error('io');
		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'accepted_unavailable' });
		await blockedUpsert();
	});
});

describe('own pending state that cannot be read blocks (fail closed)', () => {
	beforeEach(() => { shape.goLive(); });

	it('an outbox record whose read fails', async () => {
		await enqueue([{ type: 'update', original: {}, changes: row(300, 'p'), syncMetadata: { relation: 'user_storage' } }], USER);
		const [id] = [...outbox.map.keys()].filter((k) => !k.startsWith('owner|'));
		outbox.failGet = (k) => (k === id ? new Error('io') : null);

		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'pending_unreadable' });
	});

	it('a corrupt outbox record proven to be this account\'s', async () => {
		outbox.map.set('0000-corrupt', '{not json');
		outbox.map.set('owner|0000-corrupt', JSON.stringify({ userHash: USER }));

		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'pending_unreadable' });
	});

	it('an outbox record listed but gone when read', async () => {
		const listed = outbox.keys.bind(outbox);
		outbox.keys = async () => [...(await listed()), '0000-gone'];

		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'pending_unreadable' });
	});

	it('an intent of this account that cannot be parsed', async () => {
		intents.map.set('intent-corrupt', '{not json');
		intents.map.set('owner|intent-corrupt', JSON.stringify({ userHash: USER }));

		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'pending_unreadable' });
	});

	it('a write to this slot built but not signed yet', async () => {
		await enqueueIntent({ kind: 'ready-row', relation: 'user_storage', mutationType: 'insert', row: row(300, 'n') }, USER, 'user_storage');

		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'blocked', reason: 'pending_unsigned' });
	});

	it('the upsert stays an unsigned durable intent: no second snapshot next to the unreadable one', async () => {
		outbox.map.set('0000-corrupt', '{not json');
		outbox.map.set('owner|0000-corrupt', JSON.stringify({ userHash: USER }));

		const res = await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'next', hashB64: null, signSkey });

		expect((await res.sync).status).toBe('awaiting-recovery');
		await expectNothingBuilt();
	});

	it('records of unknown owner or another account keep their existing rules: they do not block', async () => {
		intents.map.set('intent-unknown', '{not json');
		await enqueueIntent({ kind: 'ready-row', relation: 'user_storage', row: row(300, 'o', { user_hash: OTHER }) }, OTHER, 'user_storage');

		expect(await resolveStorageBase(USER, SLOT, token())).toEqual({ kind: 'insert' });
	});
});

describe('recovery builds the same intent once the base is provable', () => {
	it('blocked while accepted is locked; after unlock the same intent becomes an update — one intent, one signature, one send', async () => {
		shape.fail();
		storeAccepted(row(200, 'a'));
		accepted.failGet = () => new VaultLockedError('locked');
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'next', hashB64: null, signSkey });
		await expectNothingBuilt();
		const [{ id }] = (await intentsOf(USER)).entries;

		accepted.failGet = null;
		await recoverIntents(USER, signSkey, { materializeStorage: materializeStorageIntent });

		expect(signCalls()).toHaveLength(1);
		expect(signCalls()[0].at(-1)).toBe('update');
		expect(signCalls()[0][9]).toBe(hashOf('a'));
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const all = (await intentsOf(USER, { includeResolved: true })).entries;
		expect(all.map((e) => e.id)).toEqual([id]);
		expect(all[0].intent).toMatchObject({ resolved: true });
	});

	it('blocked while the shape is not live; once it is live and the slot absent, the same intent becomes a genuine insert', async () => {
		const failed = shape;
		failed.fail();
		await upsertStorageRow({ userHash: USER, uuid: SLOT, valueB64: 'next', hashB64: null, signSkey });
		await expectNothingBuilt();
		const [{ id }] = (await intentsOf(USER)).entries;

		failed.goLive();
		await recoverIntents(USER, signSkey, { materializeStorage: materializeStorageIntent });

		expect(signCalls()).toHaveLength(1);
		expect(signCalls()[0].at(-1)).toBe('insert');
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect((await intentsOf(USER, { includeResolved: true })).entries.map((e) => e.id)).toEqual([id]);
	});
});

describe('a JSON patch is merged only onto a decided base', () => {
	it('blocked: the codec neither decrypts a base nor encrypts a merge', async () => {
		const codec = { decrypt: vi.fn(async (v: string) => JSON.parse(v)), encrypt: vi.fn(async (v: Record<string, unknown>) => ({ valueB64: JSON.stringify(v), hashB64: null })) };
		setStorageJsonCodec(codec);
		shape.rows.set(`${USER}|${SLOT}`, shapeRow(100, { value_b64: JSON.stringify({ slots: { a: 'A' } }) }));
		shape.goLive();
		accepted.failGet = () => new DecryptFailedError('bad tag');

		await expect(materializeStorageIntent(storagePayload({ jsonPatch: { slots: { b: 'B' } } }), token())).rejects.toBeInstanceOf(BaseUnavailableError);
		expect(codec.decrypt).not.toHaveBeenCalled();
		expect(codec.encrypt).not.toHaveBeenCalled();

		accepted.failGet = null;
		const ready = await materializeStorageIntent(storagePayload({ jsonPatch: { slots: { b: 'B' } } }), token());
		expect(codec.decrypt).toHaveBeenCalledWith(JSON.stringify({ slots: { a: 'A' } }));
		expect(JSON.parse(ready.row.value_b64 as string)).toEqual({ slots: { a: 'A', b: 'B' } });
	});
});

describe('session fencing', () => {
	it('an account switch during the base lookup aborts the operation before anything is signed', async () => {
		shape.goLive();
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		let reads = 0;
		const get = accepted.get.bind(accepted);
		accepted.get = async (k: string) => { reads++; await held; return get(k); };

		const call = materializeStorageIntent(storagePayload(), token());
		await vi.waitFor(() => expect(reads).toBe(1));
		stopLeaderElection();
		startLeaderElection(OTHER, () => {});
		release();

		await expect(call).rejects.toBeInstanceOf(SessionFencedError);
		expect(api.createStorageMutation).not.toHaveBeenCalled();
	});
});

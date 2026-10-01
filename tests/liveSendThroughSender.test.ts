import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeLockManager } from './helpers/fakeWebLocks';

vi.mock('@/lib/pq/signature', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/pq/signature')>();
	return { ...actual, signFields: () => 'AAAA' };
});

const USER = 'u_' + 'a'.repeat(128);
const OTHER = 'u_' + 'b'.repeat(128);
const SKEY = new Uint8Array(32).fill(3);
const DIALOG = 'di_' + '1'.repeat(128);

type Mutation = { type: string; modified?: Record<string, unknown>; original?: Record<string, unknown>; changes?: Record<string, unknown>; syncMetadata: { relation: string } };

const http = {
	calls: [] as Array<{ tag: string; mutations: Mutation[]; answer: (status?: number) => void; fail: (e: unknown) => void }>,
	auto: null as null | 'ok' | 'offline' | 'reject',
	inFlight: 0,
	maxInFlight: 0,
};
const tagOf = (m: Mutation) => String((m.modified ?? m.changes)?.tag);
let signatures = 0;

vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string) => {
			signatures++;
			return { type, ...(type === 'insert' ? { modified: { ...row } } : { original: {}, changes: { ...row } }), syncMetadata: { relation } };
		},
		ingestWithAuthEach: (mutations: Mutation[]) => new Promise((resolve, reject) => {
			http.inFlight++;
			http.maxInFlight = Math.max(http.maxInFlight, http.inFlight);
			const respond = (status = 200) => {
				http.inFlight--;
				resolve({
					status,
					json: async () => ({ results: mutations.map((_, index) => (status === 200
						? { index, status: 'ok', txid: 500 + http.calls.length }
						: { index, status: 'error', error: 'validation_failed' })) }),
				} as unknown as Response);
			};
			const fail = (e: unknown) => { http.inFlight--; reject(e); };
			http.calls.push({ tag: tagOf(mutations[0]), mutations, answer: respond, fail });
			if (http.auto === 'ok') respond();
			else if (http.auto === 'reject') respond(422);
			else if (http.auto === 'offline') fail(new TypeError('Failed to fetch'));
		}),
	},
}));

const { sendMutationsAndAwaitShape, IngestError, drainPendingWrites } = await import('@/lib/data/ingest');
const { signAndDispatchIntent, recoverIntents } = await import('@/lib/data/intentRecovery');
const { enqueueIntent, getIntent, _setIntentStorageForTests } = await import('@/lib/data/intents');
const outbox = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { _setOwnObservedTailsStorageForTests } = await import('@/lib/data/ownObservedTails');
const { uploadFile, prepareUpload } = await import('@/lib/data/fileTransfer');

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		failSet: null as null | ((k: string, v: string) => boolean),
		failKeys: 0,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { if (this.failSet?.(k, v)) throw new Error('storage down'); map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { if (this.failKeys > 0) { this.failKeys--; throw new Error('listing failed'); } return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const receipt = (tag: string, owner = USER): Mutation[] => [{
	type: 'insert',
	modified: { receipt_hash: `dmrc_${tag}`, peer_hash: owner, dialog_hash: DIALOG, tag },
	syncMetadata: { relation: 'dialog_message_receipts' },
}];
const edit = (tag: string): Mutation[] => [{
	type: 'update',
	original: {},
	changes: { message_id: 'dmsg_X', sender_hash: USER, dialog_hash: DIALOG, tag },
	syncMetadata: { relation: 'dialog_messages' },
}];
const receiptIntent = (tag: string) => ({ kind: 'ready-row', relation: 'dialog_message_receipts', mutationType: 'insert', row: receipt(tag)[0].modified });
const editIntent = (tag: string) => ({ kind: 'ready-row', relation: 'dialog_messages', mutationType: 'update', row: edit(tag)[0].changes });

let storage: ReturnType<typeof makeStorage>;
let intentStorage: ReturnType<typeof makeStorage>;
const entries = () => [...storage.map.entries()].filter(([k]) => !k.includes('|')).map(([, v]) => JSON.parse(v));
const entryOf = (tag: string) => entries().find((e) => e.mutations[0] && tagOf(e.mutations[0]) === tag);
const answer = (tag: string, status?: number) => http.calls.find((c) => c.tag === tag)!.answer(status);
const drainMicrotasks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

const becomeLeader = async (tab: typeof outbox = outbox) => {
	tab.startLeaderElection(USER, () => {});
	await vi.waitFor(() => expect(tab.isLeader()).toBe(true));
};

beforeEach(() => {
	http.calls = [];
	http.auto = null;
	http.inFlight = 0;
	http.maxInFlight = 0;
	signatures = 0;
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	storage = makeStorage();
	intentStorage = makeStorage();
	outbox._setStorageForTests(storage);
	_setIntentStorageForTests(intentStorage);
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setOwnObservedTailsStorageForTests(makeStorage());
});

afterEach(async () => {
	http.auto = 'ok';
	for (const c of http.calls) c.answer();
	outbox.stopDrainLoop();
	outbox.stopLeaderElection();
	await outbox._drainLoopSettledForTests();
	vi.unstubAllGlobals();
});

describe('a live write is sent by the account\'s sender pool', () => {
	it('a ready write goes out through the pool and the caller gets that exact response; no direct dispatch', async () => {
		await becomeLeader();
		const sending = sendMutationsAndAwaitShape(receipt('A'), SKEY);
		await vi.waitFor(() => expect(http.calls).toHaveLength(1));
		answer('A');

		const handle = await sending;
		expect(handle.phase).toBe('accepted');
		expect(handle.result).toMatchObject({ txids: [expect.any(Number)] });
		expect(entryOf('A')).toBeUndefined(); // resolved to its accepted marker
	});

	it('live A and an already queued independent B are in flight together, in the one pool', async () => {
		await becomeLeader();
		await outbox.enqueue(receipt('B'), USER);
		const sending = sendMutationsAndAwaitShape(receipt('A'), SKEY);
		await vi.waitFor(() => expect(http.calls.map((c) => c.tag).sort()).toEqual(['A', 'B']));
		expect(http.maxInFlight).toBe(2);
		answer('A');
		answer('B');
		expect((await sending).phase).toBe('accepted');
	});

	it('many live writes at once: never more than DRAIN_CONCURRENCY requests in flight', async () => {
		await becomeLeader();
		const count = outbox.DRAIN_CONCURRENCY + 3;
		const sends = Array.from({ length: count }, (_, i) => sendMutationsAndAwaitShape(receipt(`m${i}`), SKEY));
		await vi.waitFor(() => expect(http.calls).toHaveLength(outbox.DRAIN_CONCURRENCY));
		await drainMicrotasks();
		expect(http.calls).toHaveLength(outbox.DRAIN_CONCURRENCY);
		http.auto = 'ok';
		for (const c of http.calls) c.answer();
		await Promise.all(sends);
		expect(http.maxInFlight).toBe(outbox.DRAIN_CONCURRENCY);
	});

	it('a dependent live B does not get past A: queued until A is accepted, then sent', async () => {
		await becomeLeader();
		const sendingA = sendMutationsAndAwaitShape(edit('A'), SKEY);
		await vi.waitFor(() => expect(http.calls).toHaveLength(1));

		const handleB = await sendMutationsAndAwaitShape(edit('B'), SKEY);
		expect(handleB.phase).toBe('queued');
		expect(entryOf('B').dependsOn).toEqual([entryOf('A').id]);
		await drainMicrotasks();
		expect(http.calls.map((c) => c.tag)).toEqual(['A']);

		answer('A');
		await sendingA;
		await vi.waitFor(() => expect(http.calls.map((c) => c.tag)).toEqual(['A', 'B']));
		answer('B');
		await expect(handleB.acceptance).resolves.toEqual({ kind: 'accepted' });
	});

	it('a write whose prerequisites could not be discovered is queued and held, with no HTTP', async () => {
		await becomeLeader();
		storage.failKeys = 1;
		const handle = await sendMutationsAndAwaitShape(edit('A'), SKEY);
		expect(handle.phase).toBe('queued');
		expect(handle.held).toMatchObject({ reason: 'boundary_unknown' });
		await drainMicrotasks();
		expect(http.calls).toHaveLength(0);
	});

	it('a follower\'s live write is queued with 0 HTTP there; the leader sends it', async () => {
		vi.resetModules();
		const leaderTab = await import('@/lib/data/outbox');
		const leaderIngest = await import('@/lib/data/ingest');
		leaderTab._setStorageForTests(storage);
		(await import('@/lib/data/intents'))._setIntentStorageForTests(intentStorage);
		(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStorage());
		(await import('@/lib/data/ownObservedTails'))._setOwnObservedTailsStorageForTests(makeStorage());
		await becomeLeader(leaderTab);
		leaderTab.onOutboxWake((userHash) => leaderIngest.drainPendingWrites(userHash, SKEY));
		outbox.startLeaderElection(USER, () => {});
		await drainMicrotasks();
		expect(outbox.isLeader()).toBe(false);

		const handle = await sendMutationsAndAwaitShape(receipt('F'), SKEY);
		expect(handle.phase).toBe('queued');
		await vi.waitFor(() => expect(http.calls.map((c) => c.tag)).toEqual(['F']));
		answer('F');
		await expect(handle.acceptance).resolves.toEqual({ kind: 'accepted' });
		expect(http.calls).toHaveLength(1);
		leaderTab.stopDrainLoop();
		leaderTab.stopLeaderElection();
		await leaderTab._drainLoopSettledForTests();
	});
});

describe('what the caller is told', () => {
	it('a transport failure throws the attempt\'s own IngestError, and the entry keeps its schedule', async () => {
		await becomeLeader();
		http.auto = 'offline';
		const error = await sendMutationsAndAwaitShape(receipt('A'), SKEY).then(() => null, (e) => e);
		expect(error).toBeInstanceOf(IngestError);
		expect(error).toMatchObject({ network: true, permanent: false });
		expect(http.calls).toHaveLength(1);
		expect(entryOf('A')).toMatchObject({ attempts: 1, lastErrorNetwork: true, nextAttemptAt: expect.any(Number) });
	});

	it('a permanent rejection throws and quarantines the entry', async () => {
		await becomeLeader();
		http.auto = 'reject';
		const error = await sendMutationsAndAwaitShape(receipt('A'), SKEY).then(() => null, (e) => e);
		expect(error).toMatchObject({ permanent: true });
		expect(entryOf('A')).toMatchObject({ status: 'quarantined' });
	});

	it('a server acceptance that cannot be stored is not reported as accepted', async () => {
		await becomeLeader();
		storage.failSet = (_k, v) => v.includes('server_accepted_pending_reconcile');
		const sending = sendMutationsAndAwaitShape(receipt('A'), SKEY).then(() => 'accepted', (e) => e);
		await vi.waitFor(() => expect(http.calls).toHaveLength(1));
		answer('A');
		const outcome = await sending;
		expect(outcome).not.toBe('accepted');
		expect(entryOf('A').status).toBeUndefined();
	});

	it('an entry another path accepted first: accepted, with no response invented', async () => {
		await becomeLeader();
		const handle = await sendMutationsAndAwaitShape(receipt('A'), SKEY, {
			onDurable: async (id) => { await outbox.markServerAccepted(id); }, // e.g. another tab got there first
		});
		expect(handle.phase).toBe('accepted');
		expect(handle.result).toBeUndefined();
		expect(http.calls).toHaveLength(0);
	});

	it('an account switch while the attempt is in flight fences the caller', async () => {
		await becomeLeader();
		const sending = sendMutationsAndAwaitShape(receipt('A'), SKEY).then(() => null, (e) => e);
		await vi.waitFor(() => expect(http.calls).toHaveLength(1));
		outbox.stopLeaderElection();
		outbox.startLeaderElection(OTHER, () => {});
		expect(await sending).toBeInstanceOf(outbox.SessionFencedError);
		answer('A');
	});

	it('accepted but pending reconciliation is never sent again', async () => {
		await becomeLeader();
		const accepted = makeStorage();
		accepted.failSet = () => true;
		_setAcceptedSnapshotStorageForTests(accepted);
		http.auto = 'ok';
		const handle = await sendMutationsAndAwaitShape(receipt('A'), SKEY);
		expect(handle.phase).toBe('accepted');
		expect(entryOf('A').status).toBe('server_accepted_pending_reconcile');

		drainPendingWrites(USER, SKEY);
		await outbox._drainLoopSettledForTests();
		expect(http.calls).toHaveLength(1);
	});
});

describe('the attempt a live caller waits for', () => {
	it('an attempt the running pool makes before the caller submits is still the caller\'s answer', async () => {
		await becomeLeader();
		const failure = new TypeError('Failed to fetch');
		const sending = sendMutationsAndAwaitShape(receipt('A'), SKEY, {
			onDurable: async () => {
				outbox.wakeAccountSender(USER, async () => { throw failure; });
				await vi.waitFor(() => expect(entryOf('A')).toMatchObject({ attempts: 1 }));
			},
		}).then(() => null, (e) => e);
		expect(await sending).toBe(failure); // the attempt's own failure, not a queued handle
	});

	it('an entry another path of this tab holds: the caller is not left waiting — it is told the write is queued', async () => {
		await becomeLeader();
		let held: string | null = null;
		const handle = await sendMutationsAndAwaitShape(receipt('A'), SKEY, {
			onDurable: (id) => { held = id; outbox.tryClaimOutboxEntry(id); },
		});
		expect(handle.phase).toBe('queued');
		expect(http.calls).toHaveLength(0);
		outbox.releaseOutboxEntry(held);
	});
});

describe('signAndDispatchIntent through the sender', () => {
	it('the signed mutation is on the intent before the outbox entry exists', async () => {
		await becomeLeader();
		const id = (await enqueueIntent(receiptIntent('A'), USER, 'dialog_message_receipts'))!;
		const seenAtEnqueue: unknown[] = [];
		storage.failSet = (key, value) => {
			if (!key.includes('|') && value.includes('dmrc_A')) seenAtEnqueue.push(JSON.parse(intentStorage.map.get(id)!).intent.signedMutation);
			return false;
		};
		http.auto = 'ok';
		await signAndDispatchIntent(id, receiptIntent('A') as never, SKEY);
		expect(seenAtEnqueue[0]).toMatchObject({ modified: { receipt_hash: 'dmrc_A' } });
	});

	it('a session that changes while the entry is stored does not link the intent to it', async () => {
		await becomeLeader();
		const id = (await enqueueIntent(receiptIntent('A'), USER, 'dialog_message_receipts'))!;
		const token = outbox.currentSessionToken()!;
		storage.failSet = (key, value) => {
			if (!key.includes('|') && value.includes('dmrc_A')) { outbox.stopLeaderElection(); outbox.startLeaderElection(OTHER, () => {}); }
			return false;
		};
		await expect(signAndDispatchIntent(id, receiptIntent('A') as never, SKEY, { token })).rejects.toBeInstanceOf(outbox.SessionFencedError);
		expect((await getIntent(id))?.intent).not.toHaveProperty('dispatchConfirmed');
		expect((await getIntent(id))?.intent).not.toMatchObject({ resolved: true });
	});

	it('retrying the same intent reuses its snapshot and outbox entry: no second signature or entry, and no HTTP before its schedule', async () => {
		await becomeLeader();
		const id = (await enqueueIntent(receiptIntent('A'), USER, 'dialog_message_receipts'))!;
		http.auto = 'offline';
		await expect(signAndDispatchIntent(id, receiptIntent('A') as never, SKEY)).rejects.toBeInstanceOf(IngestError);
		const stored = entryOf('A');

		const retry = await signAndDispatchIntent(id, receiptIntent('A') as never, SKEY);
		expect(retry).toMatchObject({ outboxId: stored.id, phase: 'queued' });
		expect(signatures).toBe(1);
		expect(entries().filter((e) => e.relation === 'dialog_message_receipts')).toHaveLength(1);
		expect(http.calls).toHaveLength(1);
		expect((await getIntent(id))?.intent).toMatchObject({ resolved: true, ref: stored.id });
	});
});

describe('recoverIntents hands recovered intents to the pool', () => {
	it('independent recovered intents are in flight together: recovery does not wait for each HTTP', async () => {
		await becomeLeader();
		await enqueueIntent(receiptIntent('R1'), USER, 'dialog_message_receipts');
		await enqueueIntent(receiptIntent('R2'), USER, 'dialog_message_receipts');

		await recoverIntents(USER, SKEY);
		await vi.waitFor(() => expect(http.calls.map((c) => c.tag).sort()).toEqual(['R1', 'R2']));
		expect(http.maxInFlight).toBe(2);
	});

	it('one recovered intent failing does not keep another from being sent', async () => {
		await becomeLeader();
		await enqueueIntent(receiptIntent('R1'), USER, 'dialog_message_receipts');
		await enqueueIntent(receiptIntent('R2'), USER, 'dialog_message_receipts');

		await recoverIntents(USER, SKEY);
		await vi.waitFor(() => expect(http.calls).toHaveLength(2));
		http.calls.find((c) => c.tag === 'R1')!.fail(new TypeError('Failed to fetch'));
		answer('R2');
		await vi.waitFor(() => expect(entryOf('R2')).toBeUndefined());
		expect(entryOf('R1')).toMatchObject({ attempts: 1 });
	});

	it('a recovered intent that depends on another stays queued until that one is accepted', async () => {
		await becomeLeader();
		await enqueueIntent(editIntent('E1'), USER, 'dialog_messages');
		await enqueueIntent(editIntent('E2'), USER, 'dialog_messages');

		await recoverIntents(USER, SKEY);
		await vi.waitFor(() => expect(http.calls.map((c) => c.tag)).toEqual(['E1']));
		await drainMicrotasks();
		expect(http.calls.map((c) => c.tag)).toEqual(['E1']);
		answer('E1');
		await vi.waitFor(() => expect(http.calls.map((c) => c.tag)).toEqual(['E1', 'E2']));
		answer('E2');
	});
});

describe('the file manifest goes through the same pool', () => {
	it('uploadFile\'s manifest is sent by the sender, not a direct dispatch', async () => {
		await becomeLeader();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
		http.auto = 'ok';
		const { fileId, encSecretB64 } = prepareUpload('0192aaaa-0000-7000-8000-00000000000a');

		await uploadFile({ bytes: new TextEncoder().encode('hello'), uploaderHash: USER, signSkey: SKEY, fileId, encSecretB64 });

		expect(http.calls.map((c) => c.mutations[0].syncMetadata.relation)).toEqual(['files']);
	});
});

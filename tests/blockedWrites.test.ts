import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeLockManager } from './helpers/fakeWebLocks';
import { shapeOfTable } from '@/lib/data/writeContracts';

vi.mock('@/lib/pq/signature', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/pq/signature')>();
	return { ...actual, signFields: () => 'AAAA' };
});

const USER = 'u_' + 'a'.repeat(128);
const OTHER = 'u_' + 'b'.repeat(128);
const SKEY = new Uint8Array(32).fill(3);
const DIALOG = 'di_' + '1'.repeat(128);

type Mutation = { type: string; modified?: Record<string, unknown>; changes?: Record<string, unknown>; syncMetadata: { relation: string } };

const NEVER_GATED = new Set(['user_card', 'vouch_token', 'review_post_right', 'review_post_right_candidate', 'review_revoke_right', 'review_revoke_right_candidate']);

const server = {
	writeGrants: new Set<string>(),
	posts: [] as Mutation[][],
	mode: null as null | 'unavailable' | 'offline',
	refusal: 'not_in_trust_chain',
	refusalStatus: 403,
};
const tagOf = (m: Mutation) => String((m.modified ?? m.changes)?.tag);
const postedTags = () => server.posts.map((batch) => batch.map(tagOf).join('+'));

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: Mutation[]) => {
			server.posts.push(mutations);
			if (server.mode === 'offline') throw new TypeError('Failed to fetch');
			if (server.mode === 'unavailable') return { status: 503, json: async () => ({}) } as unknown as Response;
			const results = mutations.map((m, index) => {
				if (tagOf(m).startsWith('invalid')) return { index, status: 'error', error: 'validation_failed', details: { owner_timestamp: ['is invalid'] } };
				const shape = shapeOfTable(m.syncMetadata.relation);
				if (NEVER_GATED.has(shape) || server.writeGrants.has(shape)) return { index, status: 'ok', txid: 7000 + server.posts.length * 10 + index };
				return { index, status: 'error', error: server.refusal, max_depth: 7 };
			});
			const failed = results.filter((r) => r.status === 'error');
			const status = failed.length === 0 ? 200 : failed.every((r) => r.error === server.refusal) ? server.refusalStatus : 422;
			return { status, json: async () => ({ results }) } as unknown as Response;
		},
	},
}));

const chunkCache = new Map<string, Uint8Array>();
vi.mock('@/lib/data/chunkCache', () => ({
	putCachedChunk: async (fileId: string, index: number, bytes: Uint8Array) => { chunkCache.set(`${fileId}:${index}`, bytes); },
	getCachedChunk: async (fileId: string, index: number) => chunkCache.get(`${fileId}:${index}`) ?? null,
	requestPersistentStorage: async () => false,
}));

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

const receipt = (tag: string, owner = USER): Mutation[] => [{
	type: 'insert',
	modified: { receipt_hash: `dmrc_${tag}`, peer_hash: owner, dialog_hash: DIALOG, tag },
	syncMetadata: { relation: 'dialog_message_receipts' },
}];
const card = (tag: string): Mutation[] => [{
	type: 'insert',
	modified: { user_hash: USER, tag },
	syncMetadata: { relation: 'user_cards' },
}];

const openTab = async () => {
	vi.resetModules();
	const outbox = await import('@/lib/data/outbox');
	const ingest = await import('@/lib/data/ingest');
	const gate = await import('@/lib/data/accessGate');
	const { _setIntentStorageForTests } = await import('@/lib/data/intents');
	const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
	outbox._setStorageForTests(storage);
	_setIntentStorageForTests(intentStorage);
	_setAcceptedSnapshotStorageForTests(makeStorage());
	return { outbox, ingest, gate };
};
type Tab = Awaited<ReturnType<typeof openTab>>;

const signIn = async (tab: Tab, userHash = USER) => {
	tab.outbox.startLeaderElection(userHash, () => {});
	tab.ingest.drainPendingWrites(userHash, SKEY);
};
const becomeLeader = async (tab: Tab, userHash = USER) => {
	await signIn(tab, userHash);
	await vi.waitFor(() => expect(tab.outbox.isLeader()).toBe(true));
};

const signOut = (tab: Tab) => {
	tab.ingest.stopDrainLoop();
	tab.outbox.stopLeaderElection();
	tab.gate.resetGate();
};

let storage: ReturnType<typeof makeStorage>;
let intentStorage: ReturnType<typeof makeStorage>;
let tabs: Tab[];
const entries = () => [...storage.map.entries()].filter(([k]) => !k.includes('|')).map(([, v]) => JSON.parse(v));
const entryOf = (tag: string) => entries().find((e) => e.mutations[0] && tagOf(e.mutations[0]) === tag);
const settle = () => new Promise((r) => setTimeout(r, 50));

const sendLive = async (tab: Tab, mutations: Mutation[]) => {
	try {
		return { handle: await tab.ingest.sendMutationsAndAwaitShape(mutations, SKEY) };
	} catch (error) {
		return { error: error as InstanceType<Tab['ingest']['IngestError']> };
	}
};

beforeEach(async () => {
	server.writeGrants = new Set();
	server.posts = [];
	server.mode = null;
	server.refusal = 'not_in_trust_chain';
	server.refusalStatus = 403;
	chunkCache.clear();
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	storage = makeStorage();
	intentStorage = makeStorage();
	tabs = [await openTab()];
});

afterEach(async () => {
	vi.useRealTimers();
	for (const tab of tabs) {
		signOut(tab);
		await tab.outbox._drainLoopSettledForTests();
	}
	vi.unstubAllGlobals();
});

describe('a write the trust chain refuses is held, not failed and not retried', () => {
	it('403, one refused row: the signed write stays durable and pending, the caller is told it is queued, the banner shows, and nothing is retried', async () => {
		const [tab] = tabs;
		await becomeLeader(tab);

		const { handle, error } = await sendLive(tab, receipt('R1'));

		expect(error).toBeUndefined();
		expect(handle?.phase).toBe('queued');
		expect(handle?.held?.reason).toBe('awaiting_approval');
		const held = entryOf('R1');
		expect(held.status ?? 'pending').toBe('pending');
		expect(held.mutations).toEqual(receipt('R1'));
		expect(held.approvalHeld).toMatchObject({ shape: 'dialog_message_receipts' });
		expect(held.nextAttemptAt).toBeUndefined();
		await vi.waitFor(() => expect(tab.gate.isWriteBlocked('dialog_message_receipts')).toBe(true));
		expect(tab.gate.hasBlockedShapes()).toBe(true);

		tab.ingest.drainPendingWrites(USER, SKEY);
		tab.ingest.resumePendingWrites(USER, SKEY);
		await settle();
		expect(postedTags()).toEqual(['R1']);
		expect(await tab.outbox.pendingCount(USER)).toBe(0); // nothing for the timed loop to wake up for
	});

	it('the classification is per row: in a 422 batch the accepted row keeps its txid, the refused row is flagged, the invalid row keeps its permanent verdict', async () => {
		const [tab] = tabs;
		server.writeGrants.add('dialog_messages');
		const batch = [
			{ type: 'insert', modified: { message_id: 'dmsg_ok', sender_hash: USER, dialog_hash: DIALOG, tag: 'ok' }, syncMetadata: { relation: 'dialog_messages' } },
			receipt('refused')[0],
			{ ...receipt('invalid')[0] },
		];

		const error = await tab.ingest.sendMutations(batch, SKEY).catch((e) => e);

		expect(error.status).toBe(422);
		expect(error.permanent).toBe(true);
		expect(error.approvalBlocked).toBe(false);
		expect(error.blockedIndexes).toEqual([1]);
		expect(error.results[0]).toMatchObject({ status: 'ok', txid: expect.any(Number) });
	});

	it('three writes with those three verdicts: accepted, held, quarantined — each by its own row, none resent', async () => {
		const [tab] = tabs;
		server.writeGrants.add('dialog_messages');
		await becomeLeader(tab);

		await tab.outbox.enqueue([{ type: 'insert', modified: { message_id: 'dmsg_ok', sender_hash: USER, dialog_hash: DIALOG, tag: 'ok' }, syncMetadata: { relation: 'dialog_messages' } }], USER);
		await tab.outbox.enqueue(receipt('refused'), USER);
		await tab.outbox.enqueue([{ ...receipt('invalid')[0], modified: { ...receipt('invalid')[0].modified, receipt_hash: 'dmrc_other' } }], USER);
		tab.ingest.drainPendingWrites(USER, SKEY);
		await vi.waitFor(() => expect(server.posts).toHaveLength(3));
		await settle();

		expect(entryOf('ok')).toBeUndefined(); // resolved to its accepted marker
		expect(entries().find((e) => e.status === 'accepted')).toBeTruthy();
		expect(entryOf('refused').approvalHeld).toBeTruthy();
		expect(entryOf('invalid').status).toBe('quarantined');
		expect(postedTags().sort()).toEqual(['invalid', 'ok', 'refused']);
	});

	it('an entry holds exactly one mutation, so one request is one row', async () => {
		const [tab] = tabs;
		await expect(tab.outbox.enqueue([...receipt('a'), ...receipt('b')], USER)).rejects.toThrow(/exactly one mutation/);
	});
});

describe('other failures keep their existing handling', () => {
	it('a genuine validation failure is still quarantined, never held', async () => {
		const [tab] = tabs;
		await becomeLeader(tab);
		await sendLive(tab, receipt('invalid'));
		expect(entryOf('invalid').status).toBe('quarantined');
		expect(entryOf('invalid').approvalHeld).toBeUndefined();
		expect(tab.gate.hasBlockedShapes()).toBe(false);
	});

	it.each([['a 503', 'unavailable'], ['no answer', 'offline']] as const)('%s still goes on the retry schedule, never held', async (_name, mode) => {
		const [tab] = tabs;
		await becomeLeader(tab);
		server.mode = mode;
		await sendLive(tab, receipt('R1'));
		expect(entryOf('R1').nextAttemptAt).toEqual(expect.any(Number));
		expect(entryOf('R1').approvalHeld).toBeUndefined();
		expect(tab.gate.hasBlockedShapes()).toBe(false);
	});

	it.each(['Not_In_Trust_Chain', 'not_in_trust_chain_v2', 'forbidden'])('a 403 whose row error is %j is not an approval wait', async (refusal) => {
		const [tab] = tabs;
		await becomeLeader(tab);
		server.refusal = refusal;
		const { error } = await sendLive(tab, receipt('R1'));
		expect(error!.approvalBlocked).toBe(false);
		expect(entryOf('R1').approvalHeld).toBeUndefined();
		expect(entryOf('R1').nextAttemptAt).toEqual(expect.any(Number)); // the existing transient path
	});

	it('the row decides, not the status: a refusal answered with 422 is still held', async () => {
		const [tab] = tabs;
		await becomeLeader(tab);
		server.refusalStatus = 422;
		const { handle } = await sendLive(tab, receipt('R1'));
		expect(handle?.held?.reason).toBe('awaiting_approval');
		expect(entryOf('R1').status ?? 'pending').toBe('pending');
		expect(entryOf('R1').approvalHeld).toBeTruthy();
	});
});

describe('approval is proved by a write, and releases only what it proves', () => {
	const heldReceipts = async (tab: Tab) => {
		await becomeLeader(tab);
		await sendLive(tab, receipt('R1'));
		await sendLive(tab, receipt('R2')); // paused behind R1: never sent
		await vi.waitFor(() => expect(tab.gate.isWriteBlocked('dialog_message_receipts')).toBe(true));
		expect(postedTags()).toEqual(['R1']);
	};

	it('Check again with a write-only vouch sends the oldest held write once; accepted, the shape\'s other writes follow and the banner clears — without any read session', async () => {
		const [tab] = tabs;
		const readSessions = vi.fn(async () => new Response(JSON.stringify({ error: 'not_in_trust_chain' }), { status: 403 }));
		vi.stubGlobal('fetch', readSessions);
		await heldReceipts(tab);
		server.writeGrants.add('dialog_message_receipts');

		tab.gate.probeAllBlocked();

		await vi.waitFor(() => expect(postedTags()).toEqual(['R1', 'R1', 'R2']));
		await vi.waitFor(() => expect(tab.gate.isWriteBlocked('dialog_message_receipts')).toBe(false));
		expect(tab.gate.hasBlockedShapes()).toBe(false);
		expect(readSessions).not.toHaveBeenCalled();
		expect(entries().filter((e) => e.status !== 'accepted')).toEqual([]);
	});

	it('a read-only vouch releases nothing: the probe is refused again, and an open read session does not clear the write', async () => {
		const [tab] = tabs;
		await heldReceipts(tab);
		tab.gate.markShapeBlocked('dialog_message_receipts');
		tab.gate.markShapeUnblocked('dialog_message_receipts'); // a read session opened for the shape

		tab.gate.probeAllBlocked();

		await vi.waitFor(() => expect(postedTags()).toEqual(['R1', 'R1']));
		await settle();
		expect(tab.gate.isWriteBlocked('dialog_message_receipts')).toBe(true);
		expect(entryOf('R1').approvalHeld).toBeTruthy();
		expect(entryOf('R2').approvalHeld).toBeUndefined(); // never refused: it waits behind R1
		expect(entryOf('R1').nextAttemptAt).toBeUndefined();
	});

	it('the scheduled probe runs 15 s after the write was held, then backs off — never the retry schedule', async () => {
		const [tab] = tabs;
		await heldReceipts(tab);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		tab.gate.resetGate();
		tab.ingest.drainPendingWrites(USER, SKEY); // re-sync: a fresh 15 s schedule under fake time
		await vi.waitFor(() => expect(tab.gate.isWriteBlocked('dialog_message_receipts')).toBe(true));

		await vi.advanceTimersByTimeAsync(14_000);
		expect(postedTags()).toEqual(['R1']);
		await vi.advanceTimersByTimeAsync(1_500);
		await vi.waitFor(() => expect(postedTags()).toEqual(['R1', 'R1']));

		await vi.advanceTimersByTimeAsync(29_000); // next probe at 30 s
		expect(postedTags()).toEqual(['R1', 'R1']);
		server.writeGrants.add('dialog_message_receipts');
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.waitFor(() => expect(postedTags()).toEqual(['R1', 'R1', 'R1', 'R2']));
	});
});

describe('held writes across reloads, tabs and accounts', () => {
	it('after a reload the held write is still held and shown; a second tab probing at the same time does not send it twice', async () => {
		const [first] = tabs;
		await becomeLeader(first);
		await sendLive(first, receipt('R1'));
		signOut(first); // the page goes away

		const reloaded = await openTab();
		const second = await openTab();
		tabs.push(reloaded, second);
		await becomeLeader(reloaded);
		await signIn(second);
		await vi.waitFor(() => expect(reloaded.gate.isWriteBlocked('dialog_message_receipts')).toBe(true));
		await vi.waitFor(() => expect(second.gate.isWriteBlocked('dialog_message_receipts')).toBe(true));
		await settle();
		expect(postedTags()).toEqual(['R1']);

		server.writeGrants.add('dialog_message_receipts');
		reloaded.gate.probeAllBlocked();
		second.gate.probeAllBlocked();

		await vi.waitFor(() => expect(entries().every((e) => e.status === 'accepted')).toBe(true));
		await settle();
		expect(postedTags()).toEqual(['R1', 'R1']);
	});

	it('logout, then another account: none of the former account\'s held writes are shown, probed or sent — and they stay stored', async () => {
		const [tab] = tabs;
		await becomeLeader(tab);
		await sendLive(tab, receipt('R1'));
		await vi.waitFor(() => expect(tab.gate.isWriteBlocked('dialog_message_receipts')).toBe(true));

		signOut(tab);
		expect(tab.gate.hasBlockedShapes()).toBe(false);
		await becomeLeader(tab, OTHER);
		server.writeGrants.add('dialog_message_receipts');
		tab.gate.probeAllBlocked();
		await settle();

		expect(tab.gate.hasBlockedShapes()).toBe(false);
		expect(postedTags()).toEqual(['R1']);
		expect(entryOf('R1').approvalHeld).toBeTruthy();
	});
});

describe('what the gate never refuses keeps going', () => {
	it('the own card goes out while receipts are held; a new receipt waits behind them and is reported as awaiting approval', async () => {
		const [tab] = tabs;
		await becomeLeader(tab);
		await sendLive(tab, receipt('R1'));

		const cardSend = await sendLive(tab, card('C1'));
		const later = await sendLive(tab, receipt('R2'));

		expect(cardSend.handle?.phase).toBe('accepted');
		expect(later.handle?.phase).toBe('queued');
		expect(later.handle?.held?.reason).toBe('awaiting_approval');
		expect(postedTags()).toEqual(['R1', 'C1']);
	});

	it('a refused file manifest is held after its chunks; the chunks stay cached and are not sent again on approval', async () => {
		const [tab] = tabs;
		await becomeLeader(tab);
		const chunkPuts = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal('fetch', chunkPuts);
		const { uploadFile, prepareUpload } = await import('@/lib/data/fileTransfer');
		const { fileId, encSecretB64 } = prepareUpload('0192aaaa-0000-7000-8000-00000000000a');

		const upload = await uploadFile({ bytes: new TextEncoder().encode('hello'), uploaderHash: USER, signSkey: SKEY, fileId, encSecretB64 });

		expect(upload.manifestAwaitingApproval).toBeInstanceOf(Promise);
		const manifest = entries().find((e) => e.relation === 'files');
		expect(manifest.approvalHeld).toMatchObject({ shape: 'file' });
		expect(chunkPuts).toHaveBeenCalledTimes(1);
		expect(chunkCache.get(`${fileId}:0`)).toBeInstanceOf(Uint8Array);
		await vi.waitFor(() => expect(tab.gate.isWriteBlocked('file')).toBe(true));

		server.writeGrants.add('file');
		tab.gate.probeAllBlocked();
		await vi.waitFor(() => expect(entries().find((e) => e.relation === 'files').status).toBe('accepted'));
		await expect(upload.manifestAwaitingApproval).resolves.toBeUndefined();
		expect(chunkPuts).toHaveBeenCalledTimes(1);
	});
});

describe('an accepted write does not wait on a stream stopped for approval', () => {
	it('the ingest answer is the commit proof when the shape is blocked, whatever the table is called', async () => {
		const [tab] = tabs;
		const { awaitShapeVisibility } = await import('@/lib/data/barrier');
		tab.gate.markShapeBlocked('user_card'); // read gate keys by shape; the write names the table user_cards
		const never = { utils: { awaitTxId: () => new Promise<boolean>(() => {}) } };

		const outcome = await Promise.race([
			awaitShapeVisibility(never, [42], 'user_cards').then((visible) => ({ visible })),
			new Promise((resolve) => setTimeout(() => resolve('still waiting'), 300)),
		]);

		expect(outcome).toEqual({ visible: true });
	});
});

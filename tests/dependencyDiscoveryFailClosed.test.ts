import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { effectScope } from 'vue';

const MY_HASH = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32);

const sent: unknown[][] = [];
let failTransport: (mutations: unknown[]) => boolean = () => false;

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			currentUserHash: null,
			exportVaultKeys: async () => { throw new Error('locked'); },
		}),
	},
}));

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: async (mutations: unknown[]) => {
			if (failTransport(mutations)) throw new TypeError('Failed to fetch');
			sent.push(mutations);
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		},
	},
}));

const { sendMutationsAndAwaitShape, rediscoverDependencies, drainPendingWrites, DurabilityError } = await import('@/lib/data/ingest');
const { discoverDependencies } = await import('@/lib/data/coordinator');
const {
	enqueue, drainOutbox, readyEntries, blockedEntries, blockedDependentIssues, pendingEntries, requeueEntry, recordFailure,
	corruptOutboxRecords, accountOutboxSnapshot, stopDrainLoop, _setStorageForTests, _setLeaderForTests,
} = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { _setIntentStorageForTests } = await import('@/lib/data/intents');
const { _setOwnObservedTailsStorageForTests } = await import('@/lib/data/ownObservedTails');
const { useAccountSyncStatus } = await import('@/composables/useAccountSyncStatus');
const { createSecureStore, deriveLocalStorageKey } = await import('@/lib/data/secureStore');
import type { StringStore } from '@/lib/data/secureStore';

const makeStore = (): StringStore & { map: Map<string, string> } => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k) { return map.get(k) ?? null; },
		async set(k, v) { map.set(k, v); },
		async delete(k) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const edit = (messageId: string, text: string) => ([{
	type: 'update',
	original: { message_id: messageId, sender_hash: MY_HASH, dialog_hash: 'dh1' },
	changes: { message_id: messageId, sender_hash: MY_HASH, dialog_hash: 'dh1', content_b64: text, parent_sign_hash: null, owner_timestamp: 1, sign_b64: `sig-${text}` },
	syncMetadata: { relation: 'dialog_messages' },
}]);

const textsSent = () => sent.map((m) => (m[0] as { changes: { content_b64: string } }).changes.content_b64);
const settle = () => new Promise((r) => setTimeout(r, 30));
const stored = (store: { map: Map<string, string> }, id: string) => JSON.parse(store.map.get(id) as string);

const failReadsOf = (store: StringStore, key: () => string | null, failing = { value: true }) => {
	const realGet = store.get.bind(store);
	store.get = async (k) => {
		if (failing.value && k === key()) throw new Error('disk read error: secret-bytes');
		return realGet(k);
	};
	return failing;
};

let store: ReturnType<typeof makeStore>;

beforeEach(() => {
	sent.length = 0;
	failTransport = () => false;
	store = makeStore();
	_setStorageForTests(store);
	_setAcceptedSnapshotStorageForTests(makeStore());
	_setLeaderForTests(true);
});

afterEach(() => {
	stopDrainLoop();
	_setLeaderForTests(null);
});

describe('a failed dependency discovery is never "no dependencies"', () => {
	it('a predecessor that cannot be read blocks the write durably instead of dispatching it live', async () => {
		const pId = await enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		failReadsOf(store, () => pId);

		const handle = await sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await settle();

		expect(handle.phase).toBe('queued');
		expect(sent).toEqual([]);
		const entry = stored(store, handle.outboxId as string);
		expect(entry.discoveryBlocked).toMatchObject({ reason: 'storage_unavailable', attempts: expect.any(Number) });
		expect(entry).not.toHaveProperty('dependsOn');
	});

	it('undecryptable ciphertext of this account blocks the write as a corrupt prerequisite, never dependsOn: []', async () => {
		const raw = makeStore();
		const key = await deriveLocalStorageKey(new Uint8Array(32).fill(1));
		const secure = createSecureStore(raw, { getKey: async () => key });
		_setStorageForTests(secure, raw);
		const pId = await enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		const value = raw.map.get(pId) as string;
		raw.map.set(pId, value.slice(0, -6) + (value.at(-6) === 'A' ? 'B' : 'A') + value.slice(-5));

		const handle = await sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await settle();

		expect(sent).toEqual([]);
		const entry = JSON.parse(await secure.get(handle.outboxId as string) as string);
		expect(entry.discoveryBlocked.reason).toBe('corrupt_record');
		expect(entry).not.toHaveProperty('dependsOn');
		expect((await corruptOutboxRecords(MY_HASH)).map((r) => r.key)).toEqual([pId]);
	});

	it('a failure to list the queue blocks the write with no recovery boundary and a safe reason, and nothing is sent', async () => {
		let failures = 1;
		const realKeys = store.keys.bind(store);
		store.keys = async () => { if (failures-- > 0) throw new Error('boom: secret-bytes'); return realKeys(); };
		_setLeaderForTests(false);

		const handle = await sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await settle();

		expect(handle.phase).toBe('queued');
		expect(sent).toEqual([]);
		const entry = stored(store, handle.outboxId as string);
		expect(entry.discoveryBlocked).toMatchObject({
			kind: 'discovery', reason: 'boundary_unknown', observedKeys: null,
			message: 'it was queued while storage could not be listed — discard it and send it again',
		});
		expect(store.map.get(handle.outboxId as string)).not.toContain('secret-bytes');
	});

	it('the exact signed snapshot and the blocked reason survive a reload, and neither replay nor retry sends it', async () => {
		const pId = await enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		failReadsOf(store, () => pId);
		const mutations = edit('msg_X', 'b');
		const handle = await sendMutationsAndAwaitShape(mutations, SKEY);
		await settle();
		stopDrainLoop();

		const reloaded: StringStore = { ...store };
		_setStorageForTests(reloaded);
		const [entry] = (await pendingEntries(MY_HASH)).filter((e) => e.id === handle.outboxId);
		expect(entry.mutations).toEqual(mutations);
		expect(entry.discoveryBlocked).toMatchObject({ reason: 'storage_unavailable', message: 'a queued write it may depend on could not be read from storage' });
		expect(JSON.stringify(entry)).not.toContain('secret-bytes');

		await drainOutbox(MY_HASH, async (m) => { sent.push(m); });
		await requeueEntry(handle.outboxId as string);
		await recordFailure(handle.outboxId as string, new Error('503'));
		await drainOutbox(MY_HASH, async (m) => { sent.push(m); }, undefined, undefined, rediscoverDependencies);

		expect(sent).toEqual([]);
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(handle.outboxId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(handle.outboxId);
		expect(stored(store, handle.outboxId as string).discoveryBlocked.attempts).toBeGreaterThan(0);
	});

	it('successful rediscovery stores the real dependencies and clears the block; dispatch waits for them', async () => {
		const pId = await enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		const failing = failReadsOf(store, () => pId);
		_setLeaderForTests(false);
		const handle = await sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await settle();
		stopDrainLoop();
		expect(stored(store, handle.outboxId as string).discoveryBlocked).toBeTruthy();

		failing.value = false;
		_setLeaderForTests(true);
		failTransport = (m) => (m[0] as { changes: { content_b64: string } }).changes.content_b64 === 'p';
		await drainOutbox(MY_HASH, async (m) => { await sendThroughApi(m); }, undefined, undefined, rediscoverDependencies);

		const recovered = stored(store, handle.outboxId as string);
		expect(recovered).not.toHaveProperty('discoveryBlocked');
		expect(recovered.dependsOn).toEqual([pId]);
		expect(sent).toEqual([]);

		failTransport = () => false;
		const due = stored(store, pId);
		delete due.nextAttemptAt;
		store.map.set(pId, JSON.stringify(due));
		await drainOutbox(MY_HASH, async (m) => { await sendThroughApi(m); }, undefined, undefined, rediscoverDependencies);
		expect(textsSent()).toEqual(['p', 'b']);
	});

	it('the drain a login or reconnect arms recovers the blocked write and sends it after its predecessor', async () => {
		const pId = await enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		const failing = failReadsOf(store, () => pId);
		_setLeaderForTests(false);
		const handle = await sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		stopDrainLoop();
		expect(handle.held?.reason).toBe('storage_unavailable');

		failing.value = false;
		_setLeaderForTests(true);
		drainPendingWrites(MY_HASH, SKEY);

		expect(await handle.acceptance).toEqual({ kind: 'accepted' });
		expect(textsSent()).toEqual(['p', 'b']);
		expect(stored(store, handle.outboxId as string)).not.toHaveProperty('discoveryBlocked');
	});

	it('an unrelated entry still dispatches while the affected entry stays blocked', async () => {
		const cId = await enqueue(edit('msg_Y', 'c'), MY_HASH) as string;
		const pId = await enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		failReadsOf(store, () => pId);
		_setLeaderForTests(false);
		const handle = await sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		stopDrainLoop();
		_setLeaderForTests(true);

		await drainOutbox(MY_HASH, async (m) => { await sendThroughApi(m); }, undefined, undefined, rediscoverDependencies);

		expect(textsSent()).toEqual(['c']);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(handle.outboxId);
		void cId;
	});

	it('when even the blocked entry cannot be persisted, nothing is sent and a durability error surfaces', async () => {
		let failures = 1;
		const realKeys = store.keys.bind(store);
		store.keys = async () => { if (failures-- > 0) throw new Error('boom'); return realKeys(); };
		store.set = async () => { throw new Error('disk full'); };

		await expect(sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY))
			.rejects.toBeInstanceOf(DurabilityError);
		await settle();
		expect(sent).toEqual([]);
	});

	it('a write no rule can depend on (user_cards insert) completes discovery without reading storage', async () => {
		store.keys = async () => { throw new Error('storage down'); };
		const cardInsert = [{ type: 'insert', modified: { user_hash: MY_HASH, name: 'me' }, syncMetadata: { relation: 'user_cards' } }];

		expect(await discoverDependencies(cardInsert, MY_HASH)).toEqual({ kind: 'found', dependsOn: [] });
	});
});

describe('a new message whose refs_map record cannot be read', () => {
	const message = (messageId: string) => ([{
		type: 'insert',
		modified: { message_id: messageId, sender_hash: MY_HASH, dialog_hash: 'dh1', content_b64: messageId, sign_hash: `dms_${messageId}` },
		syncMetadata: { relation: 'dialog_messages' },
	}]);
	const messageIdsSent = () => sent.flat().map((m) => (m as { modified?: { message_id?: string } }).modified?.message_id);

	it('is blocked, never sent as citing nothing, while a queued message of the dialog could be cited', async () => {
		const tails = makeStore();
		tails.get = async () => { throw new Error('disk read error: secret-bytes'); };
		_setOwnObservedTailsStorageForTests(tails);
		await enqueue(edit('msg_X', 'p'), MY_HASH);

		expect(await discoverDependencies(message('msg_N'), MY_HASH)).toMatchObject({ kind: 'blocked', block: { reason: 'discovery_error' } });

		const handle = await sendMutationsAndAwaitShape(message('msg_N'), SKEY);
		await settle();

		expect(handle.phase).toBe('queued');
		expect(messageIdsSent()).not.toContain('msg_N');
		const entry = stored(store, handle.outboxId as string);
		expect(entry.discoveryBlocked).toMatchObject({ reason: 'discovery_error' });
		expect(entry).not.toHaveProperty('dependsOn');
	});
});

describe('the blocked write is visible and needs attention', () => {
	it('diagnostics and the account status report it', async () => {
		_setIntentStorageForTests(makeStore());
		const pId = await enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		failReadsOf(store, () => pId);
		_setLeaderForTests(false);
		const handle = await sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		stopDrainLoop();

		const issue = (await blockedDependentIssues(MY_HASH)).find((i) => i.entry.id === handle.outboxId);
		expect(issue?.discovery).toEqual({ reason: 'storage_unavailable', message: 'a queued write it may depend on could not be read from storage' });
		expect((await accountOutboxSnapshot(MY_HASH)).blocked.map((i) => i.entry.id)).toContain(handle.outboxId);

		const scope = effectScope();
		const status = scope.run(() => useAccountSyncStatus(() => MY_HASH, () => true))!;
		await vi.waitFor(() => expect(status.value).toBe('needs_attention'));
		scope.stop();
	});
});

describe('a stored discovery block must be well-formed', () => {
	const block = (fields: Record<string, unknown>) => ({
		kind: 'discovery', reason: 'discovery_error', message: 'its dependencies could not be determined', blockedAt: 1, attempts: 0, observedKeys: [], ...fields,
	});
	it.each([
		['a custom message', block({ message: 'Error: secret-bytes' }), {}, 'discoveryBlocked is malformed'],
		['an unknown reason', block({ reason: 'nope', message: 'x' }), {}, 'discoveryBlocked is malformed'],
		['no kind', block({ kind: undefined }), {}, 'discoveryBlocked has no valid kind'],
		['a stale base without admission kind', block({ reason: 'stale_base', message: 'it was built on data the server has not confirmed yet — it waits until that data is confirmed' }), {}, 'discoveryBlocked reports a stale base without admission kind'],
		['malformed observedKeys', block({ observedKeys: [1] }), {}, 'discoveryBlocked has malformed observedKeys'],
		['no boundary for an ordinary reason', block({ observedKeys: null }), {}, 'discoveryBlocked has a boundary that contradicts its reason'],
		['a boundary for boundary_unknown', block({ reason: 'boundary_unknown', message: 'it was queued while storage could not be listed — discard it and send it again' }), {}, 'discoveryBlocked has a boundary that contradicts its reason'],
		['a dependsOn beside it', block({}), { dependsOn: ['x'] }, 'discoveryBlocked cannot carry dependsOn'],
		['a quarantined status', block({}), { status: 'quarantined', quarantinedAt: 1 }, 'status quarantined cannot carry discoveryBlocked'],
	])('%s is quarantined, never replayed', async (_name, badBlock, extra, reason) => {
		const id = await enqueue(edit('msg_X', 'z'), MY_HASH) as string;
		store.map.set(id, JSON.stringify({ ...stored(store, id), discoveryBlocked: badBlock, ...extra }));

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(id);
		expect(await corruptOutboxRecords(MY_HASH)).toEqual([expect.objectContaining({ key: id, message: `decoded value is not a valid outbox entry: ${reason}` })]);
	});
});

async function sendThroughApi(mutations: unknown[]): Promise<void> {
	const { api } = await import('@/api/client');
	await (api as unknown as { ingestWithAuthEach: (m: unknown[]) => Promise<unknown> }).ingestWithAuthEach(mutations);
}

describe('leader takeover obeys the same gate', () => {
	it('a fresh tab taking over the drain neither sends the blocked write nor loses its block, and recovers it once storage reads again', async () => {
		const pId = await enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		const failing = failReadsOf(store, () => pId);
		_setLeaderForTests(false);
		const handle = await sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		stopDrainLoop();

		vi.resetModules();
		const tab = await import('@/lib/data/outbox');
		const tabIngest = await import('@/lib/data/ingest');
		tab._setStorageForTests({ ...store });
		tab._setLeaderForTests(true);
		try {
			await tab.drainOutbox(MY_HASH, async (m) => { await sendThroughApi(m); }, undefined, undefined, tabIngest.rediscoverDependencies);
			expect(sent).toEqual([]);
			expect((await tab.blockedEntries(MY_HASH)).map((e) => e.id)).toContain(handle.outboxId);

			failing.value = false;
			await tab.drainOutbox(MY_HASH, async (m) => { await sendThroughApi(m); }, undefined, undefined, tabIngest.rediscoverDependencies);
			expect(textsSent()).toEqual(['p', 'b']);
		} finally {
			tab._setLeaderForTests(null);
			tab.stopDrainLoop();
		}
	});
});

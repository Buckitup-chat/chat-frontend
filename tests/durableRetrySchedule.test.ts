import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFakeLockManager } from './helpers/fakeWebLocks';

const USER = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32).fill(3);
const DIALOG = 'di_' + '1'.repeat(128);

type Mutation = { type: string; modified?: Record<string, unknown>; original?: Record<string, unknown>; changes?: Record<string, unknown>; syncMetadata: { relation: string } };

const http = {
	calls: [] as Array<{ tag: string; body: string; answer: (status?: number) => void }>,
	mode: null as null | 'ok' | 'offline' | 'unavailable',
};
const tagOf = (m: Mutation) => String((m.modified ?? m.changes)?.tag);

vi.mock('@/api/client', () => ({
	api: {
		ingestWithAuthEach: (mutations: Mutation[]) => new Promise((resolve, reject) => {
			const respond = (status = 200) => resolve({
				status,
				json: async () => ({ results: mutations.map((_, index) => (status === 200
					? { index, status: 'ok', txid: 800 + http.calls.length }
					: { index, status: 'error', error: 'unavailable' })) }),
			} as unknown as Response);
			http.calls.push({ tag: tagOf(mutations[0]), body: JSON.stringify(mutations), answer: respond });
			if (http.mode === 'ok') respond();
			else if (http.mode === 'unavailable') respond(503);
			else if (http.mode === 'offline') reject(new TypeError('Failed to fetch'));
		}),
	},
}));

const ingest = await import('@/lib/data/ingest');
const { sendMutationsAndAwaitShape } = ingest;
const outbox = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { _setOwnObservedTailsStorageForTests } = await import('@/lib/data/ownObservedTails');

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

const receipt = (tag: string): Mutation[] => [{
	type: 'insert',
	modified: { receipt_hash: `dmrc_${tag}`, peer_hash: USER, dialog_hash: DIALOG, tag, sign_b64: `sig-${tag}` },
	syncMetadata: { relation: 'dialog_message_receipts' },
}];
const edit = (tag: string): Mutation[] => [{
	type: 'update',
	original: {},
	changes: { message_id: 'dmsg_X', sender_hash: USER, dialog_hash: DIALOG, tag, sign_b64: `sig-${tag}` },
	syncMetadata: { relation: 'dialog_messages' },
}];

type Tab = { outbox: typeof outbox; ingest: typeof import('@/lib/data/ingest') };
let storage: ReturnType<typeof makeStorage>;
let tabs: Tab[];
const thisTab = (): Tab => tabs[0];
const entryById = (id: string) => JSON.parse(storage.map.get(id)!);
const entryOf = (tag: string) => [...storage.map.entries()].filter(([k]) => !k.includes('|')).map(([, v]) => JSON.parse(v))
	.find((e) => e.mutations[0] && tagOf(e.mutations[0]) === tag);
const tagsSent = () => http.calls.map((c) => c.tag);
const drainMicrotasks = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

const becomeLeader = async (tab: Tab = thisTab()) => {
	tab.outbox.startLeaderElection(USER, () => {});
	await vi.waitFor(() => expect(tab.outbox.isLeader()).toBe(true));
};
const openTab = async (): Promise<Tab> => {
	vi.resetModules();
	const tab = { outbox: await import('@/lib/data/outbox'), ingest: await import('@/lib/data/ingest') };
	tab.outbox._setStorageForTests(storage);
	(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStorage());
	(await import('@/lib/data/ownObservedTails'))._setOwnObservedTailsStorageForTests(makeStorage());
	tabs.push(tab);
	return tab;
};
const closeTab = async (tab: Tab) => {
	tab.outbox.stopDrainLoop();
	tab.outbox.stopLeaderElection();
	await tab.outbox._drainLoopSettledForTests();
};
const settle = async (tab: Tab = thisTab()) => {
	await drainMicrotasks();
	await tab.outbox._drainLoopSettledForTests();
	await drainMicrotasks();
};

const failedOnce = async (mutations: Mutation[], mode: 'offline' | 'unavailable') => {
	http.mode = mode;
	await expect(sendMutationsAndAwaitShape(mutations, SKEY)).rejects.toThrow();
	await settle();
	http.mode = null;
	return entryOf(tagOf(mutations[0]));
};

beforeEach(() => {
	http.calls = [];
	http.mode = null;
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	storage = makeStorage();
	outbox._setStorageForTests(storage);
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setOwnObservedTailsStorageForTests(makeStorage());
	tabs = [{ outbox, ingest }];
});

afterEach(async () => {
	http.mode = 'ok';
	for (const c of http.calls) c.answer();
	for (const tab of tabs) await closeTab(tab);
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});


describe('failures are recorded durably and classified', () => {
	it('a 503 records one attempt and a server backoff', async () => {
		await becomeLeader();
		const a = await failedOnce(receipt('A'), 'unavailable');
		expect(a).toMatchObject({ attempts: 1, nextAttemptAt: expect.any(Number) });
		expect(a.lastErrorNetwork).toBeUndefined();
		expect(a.nextAttemptAt).toBeGreaterThan(Date.now());
	});

	it('a request that got no answer records one attempt and a network backoff', async () => {
		await becomeLeader();
		const a = await failedOnce(receipt('A'), 'offline');
		expect(a).toMatchObject({ attempts: 1, lastErrorNetwork: true, nextAttemptAt: expect.any(Number) });
	});

	it('attempts counts HTTP requests exactly: one per attempt, whatever triggered it', async () => {
		await becomeLeader();
		const a = await failedOnce(receipt('A'), 'offline');
		http.mode = 'offline';
		ingest.resumePendingWrites(USER, SKEY);
		await vi.waitFor(() => expect(entryById(a.id).attempts).toBe(2));
		await settle();
		expect(tagsSent().filter((t) => t === 'A')).toHaveLength(entryById(a.id).attempts);
	});
});

describe('a trigger that proves nothing never jumps a stored time', () => {
	it('login or reload before the retry time sends nothing and keeps the time', async () => {
		await becomeLeader();
		const a = await failedOnce(receipt('A'), 'unavailable');
		await closeTab(thisTab());

		const reloaded = await openTab();
		await becomeLeader(reloaded);
		http.mode = 'ok';
		reloaded.ingest.drainPendingWrites(USER, SKEY);
		await settle(reloaded);
		expect(http.calls).toHaveLength(1);
		expect(entryById(a.id).nextAttemptAt).toBe(a.nextAttemptAt);
	});

	it('another tab\'s wake before the retry time sends the new write, not the backed-off one', async () => {
		await becomeLeader();
		outbox.onOutboxWake((userHash) => ingest.drainPendingWrites(userHash, SKEY));
		const a = await failedOnce(receipt('A'), 'unavailable');

		const other = await openTab();
		other.outbox.startLeaderElection(USER, () => {});
		http.mode = 'ok';
		await other.outbox.enqueue(receipt('B'), USER);
		await vi.waitFor(() => expect(tagsSent()).toContain('B'));
		await settle();
		expect(tagsSent()).toEqual(['A', 'B']);
		expect(entryById(a.id).nextAttemptAt).toBe(a.nextAttemptAt);
	});

	it('a leader takeover before the retry time sends nothing and keeps the time', async () => {
		const first = await openTab();
		await becomeLeader(first);
		http.mode = 'unavailable';
		await expect(first.ingest.sendMutationsAndAwaitShape(receipt('A'), SKEY)).rejects.toThrow();
		await settle(first);
		const a = entryOf('A');
		first.outbox.stopLeaderElection();

		await becomeLeader();
		http.mode = 'ok';
		ingest.drainPendingWrites(USER, SKEY);
		await settle();
		expect(http.calls).toHaveLength(1);
		expect(entryById(a.id).nextAttemptAt).toBe(a.nextAttemptAt);
	});

	it('the page coming back into view, or the connection coming back, does not end a server backoff', async () => {
		await becomeLeader();
		const a = await failedOnce(receipt('A'), 'unavailable');
		http.mode = 'ok';
		ingest.resumePendingWrites(USER, SKEY);
		await settle();
		expect(http.calls).toHaveLength(1);
		expect(entryById(a.id).nextAttemptAt).toBe(a.nextAttemptAt);
	});

	it('a trigger never makes a quarantined, held or dependency-blocked write ready', async () => {
		await becomeLeader();
		const refused = (await outbox.enqueue(receipt('Q'), USER))!;
		await outbox.recordFailure(refused, new ingest.IngestError('refused', { permanent: true }));
		await outbox.enqueue(receipt('H'), USER, { discoveryBlocked: outbox.dependencyBlockFor(null, { kind: 'discovery', observedKeys: null }) });
		const a = await failedOnce(edit('A'), 'unavailable');
		await outbox.enqueue(edit('A2'), USER, { dependsOn: [a.id] });

		http.mode = 'ok';
		ingest.drainPendingWrites(USER, SKEY);
		ingest.resumePendingWrites(USER, SKEY);
		await settle();
		expect(tagsSent()).toEqual(['A']);
		expect(entryById(refused).status).toBe('quarantined');
	});
});

describe('the connection being back ends only the waits for a connection', () => {
	it('online or a visible page makes a network backoff due now', async () => {
		await becomeLeader();
		await failedOnce(receipt('A'), 'offline');
		http.mode = 'ok';
		ingest.resumePendingWrites(USER, SKEY);
		await vi.waitFor(() => expect(tagsSent()).toEqual(['A', 'A']));
	});

	it('an answered request ends the network backoffs, and a server backoff still stands', async () => {
		await becomeLeader();
		const net = await failedOnce(receipt('N'), 'offline');
		const server = await failedOnce(receipt('S'), 'unavailable');
		http.mode = 'ok';
		await sendMutationsAndAwaitShape(receipt('live'), SKEY);
		await vi.waitFor(() => expect(tagsSent().filter((t) => t === 'N')).toHaveLength(2));
		await settle();
		expect(tagsSent().filter((t) => t === 'S')).toHaveLength(1);
		expect(entryById(server.id).nextAttemptAt).toBeGreaterThan(Date.now());
		expect(entryById(net.id).status).toBe('accepted');
	});
});

describe('the retry itself', () => {
	it('at its time the byte-identical signed snapshot goes again, with no trigger at all', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
		await becomeLeader();
		const a = await failedOnce(receipt('A'), 'unavailable');
		http.mode = 'ok';

		await vi.advanceTimersByTimeAsync(a.nextAttemptAt - Date.now() - 20);
		expect(http.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(http.calls).toHaveLength(2);
		expect(http.calls[1].body).toBe(http.calls[0].body);
		expect(entryById(a.id).status).toBe('accepted');
	});

	it('after a reload and after a takeover, the timer is set again from the stored time', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
		await becomeLeader();
		const a = await failedOnce(receipt('A'), 'unavailable');
		const body = http.calls[0].body;
		await closeTab(thisTab());

		const next = await openTab();
		await becomeLeader(next);
		http.mode = 'ok';
		next.ingest.drainPendingWrites(USER, SKEY);
		await vi.advanceTimersByTimeAsync(a.nextAttemptAt - Date.now() - 20);
		expect(http.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(http.calls).toHaveLength(2);
		expect(http.calls[1].body).toBe(body);
	});

	it('A backing off does not hold up independent B; A\'s dependent A2 waits until A is accepted', async () => {
		await becomeLeader();
		const a = await failedOnce(edit('A'), 'unavailable');
		http.mode = 'ok';
		expect((await sendMutationsAndAwaitShape(receipt('B'), SKEY)).phase).toBe('accepted');
		const a2 = await sendMutationsAndAwaitShape(edit('A2'), SKEY);
		expect(a2.phase).toBe('queued');
		expect(entryOf('A2').dependsOn).toEqual([a.id]);
		await settle();
		expect(tagsSent()).toEqual(['A', 'B']);

		const clock = vi.spyOn(Date, 'now').mockReturnValue(a.nextAttemptAt + 1);
		ingest.drainPendingWrites(USER, SKEY);
		await vi.waitFor(() => expect(tagsSent()).toEqual(['A', 'B', 'A', 'A2']));
		clock.mockRestore();
	});
});

describe('a person\'s Retry', () => {
	it('makes only the chosen entry due; every other schedule stands', async () => {
		await becomeLeader();
		outbox.onOutboxWake((userHash) => ingest.drainPendingWrites(userHash, SKEY));
		const chosen = await failedOnce(receipt('C'), 'unavailable');
		const other = await failedOnce(receipt('O'), 'unavailable');
		http.mode = 'ok';

		await outbox.requeueEntry(chosen.id);
		await vi.waitFor(() => expect(tagsSent()).toEqual(['C', 'O', 'C']));
		await settle();
		expect(entryById(other.id).nextAttemptAt).toBe(other.nextAttemptAt);
	});
});

describe('the production triggers', () => {
	const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

	it('no schedule reset remains', () => {
		for (const path of ['src/lib/data/outbox.ts', 'src/lib/data/ingest.ts', 'src/libs/EncryptionManagerPQ.js']) {
			expect(source(path)).not.toMatch(/resetSchedules|clearSchedules\(/);
		}
	});

	it('online and a visible page release network waits; login, takeover and wakes only wake the sender', () => {
		const em = source('src/libs/EncryptionManagerPQ.js');
		const listener = (name: string) => em.slice(em.indexOf(`this.#${name} = `), em.indexOf('};', em.indexOf(`this.#${name} = `)));
		expect(listener('outboxOnlineListener')).toMatch(/resumePendingWrites\(/);
		expect(listener('outboxVisibleListener')).toMatch(/resumePendingWrites\(/);
		const drain = em.slice(em.indexOf('#startOutboxDrain() {'), em.indexOf('#stopOutboxDrain() {'));
		expect(drain).toMatch(/startLeaderElection\(userHash, \(\) => drainPendingWrites\(/);
		expect(drain).toMatch(/onOutboxWake\([\s\S]*drainPendingWrites\(/);
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeLockManager } from './helpers/fakeWebLocks';

const USER = 'u_' + 'a'.repeat(128);
const OTHER = 'u_' + 'b'.repeat(128);

type Outbox = typeof import('@/lib/data/outbox');

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		failSet: null as null | ((key: string, value: string) => boolean),
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) {
			if (this.failSet?.(k, v)) throw new Error('storage down');
			map.set(k, v);
		},
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const message = (tag: string) => [{
	type: 'insert',
	modified: { message_id: `dmsg_${tag}`, sender_hash: USER, dialog_hash: 'di_' + '1'.repeat(128), content_b64: tag },
	syncMetadata: { relation: 'dialog_messages' },
}];
const tagOf = (mutations: unknown[]) => String((mutations[0] as { modified: { content_b64: string } }).modified.content_b64);

const makeTransport = () => {
	const calls: Array<{ tag: string; answer: (result?: unknown) => void; fail: (e: unknown) => void }> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const inFlightTags = new Set<string>();
	const overlapsOfOneEntry: string[] = [];
	const send = (mutations: unknown[]) => new Promise<unknown>((resolve, reject) => {
		const tag = tagOf(mutations);
		if (inFlightTags.has(tag)) overlapsOfOneEntry.push(tag);
		inFlightTags.add(tag);
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		const done = () => { inFlight--; inFlightTags.delete(tag); };
		calls.push({
			tag,
			answer: (result = { txids: [], results: [{ tag }] }) => { done(); resolve(result); },
			fail: (e) => { done(); reject(e); },
		});
	});
	return {
		send, calls,
		sentTags: () => calls.map((c) => c.tag),
		get maxInFlight() { return maxInFlight; },
		overlapsOfOneEntry,
		answer: (tag: string, result?: unknown) => calls.find((c) => c.tag === tag)!.answer(result),
		answerAll: () => { for (const c of calls) c.answer(); },
	};
};

let storage: ReturnType<typeof makeStorage>;
let tabs: Outbox[];
let transports: Array<ReturnType<typeof makeTransport>>;

const openTab = async (): Promise<Outbox> => {
	vi.resetModules();
	const tab = await import('@/lib/data/outbox');
	tab._setStorageForTests(storage);
	tabs.push(tab);
	return tab;
};
const signedInTab = async (): Promise<Outbox> => {
	const tab = await openTab();
	tab.startLeaderElection(USER, () => {});
	return tab;
};
const leaderTab = async () => {
	const tab = await signedInTab();
	await vi.waitFor(() => expect(tab.isLeader()).toBe(true));
	return tab;
};
const transport = () => {
	const t = makeTransport();
	transports.push(t);
	return t;
};
const drainMicrotasks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const settledSoon = async (promise: Promise<unknown>) => {
	let settled = false;
	void promise.finally(() => { settled = true; });
	for (let i = 0; i < 30; i++) await Promise.resolve();
	return settled;
};
const statusOf = (id: string) => JSON.parse(storage.map.get(id)!).status as string | undefined;

beforeEach(() => {
	storage = makeStorage();
	tabs = [];
	transports = [];
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
});

afterEach(async () => {
	for (const t of transports) t.answerAll();
	for (const tab of tabs) {
		tab.stopDrainLoop();
		tab.stopLeaderElection();
	}
	for (const tab of tabs) await tab._drainLoopSettledForTests();
	vi.unstubAllGlobals();
});

describe('submitEntryToSender: the leader\'s pool sends a stored entry', () => {
	it('a ready durable entry is sent by the pool, and its waiter gets that exact response', async () => {
		const tab = await leaderTab();
		const http = transport();
		const id = (await tab.enqueue(message('A'), USER))!;

		const { attempt } = await tab.submitEntryToSender(USER, id, http.send);
		await vi.waitFor(() => expect(http.sentTags()).toEqual(['A']));
		const response = { txids: [7], results: [{ tag: 'A' }] };
		http.answer('A', response);

		expect(await attempt).toEqual({ kind: 'accepted', result: response });
		expect(statusOf(id)).toBe('accepted');
	});

	it('only a stored entry of this account is accepted for submission', async () => {
		const tab = await leaderTab();
		await expect(tab.submitEntryToSender(USER, 'no-such-entry', transport().send)).rejects.toThrow(/not a stored entry/);
		const id = (await tab.enqueue(message('A'), OTHER))!;
		await expect(tab.submitEntryToSender(USER, id, transport().send)).rejects.toThrow(/not a stored entry/);
	});
});

describe('leader-only sending', () => {
	it('a follower\'s submission wakes the leader: the follower sends nothing, the leader sends it', async () => {
		const leader = await leaderTab();
		const follower = await signedInTab();
		const leaderHttp = transport();
		const followerHttp = transport();
		leader.onOutboxWake((userHash) => leader.wakeAccountSender(userHash, leaderHttp.send));
		const id = (await follower.enqueue(message('F'), USER))!;

		const { attempt } = await follower.submitEntryToSender(USER, id, followerHttp.send);
		await vi.waitFor(() => expect(leaderHttp.sentTags()).toEqual(['F']));
		leaderHttp.answer('F');

		expect(await attempt).toEqual({ kind: 'settled-elsewhere', outcome: { kind: 'accepted' } });
		expect(followerHttp.calls).toHaveLength(0);
	});

	it('two tabs woken for the same entries never send one entry twice or at once', async () => {
		const a = await leaderTab();
		const b = await signedInTab();
		const httpA = transport();
		const httpB = transport();
		const ids: string[] = [];
		for (const tag of ['1', '2', '3']) ids.push((await a.enqueue(message(tag), USER))!);

		await Promise.all(ids.flatMap((id) => [a.submitEntryToSender(USER, id, httpA.send), b.submitEntryToSender(USER, id, httpB.send)]));
		await vi.waitFor(() => expect(httpA.calls.length + httpB.calls.length).toBe(3));
		httpA.answerAll();
		httpB.answerAll();
		await vi.waitFor(() => expect(ids.map(statusOf)).toEqual(['accepted', 'accepted', 'accepted']));

		expect([...httpA.sentTags(), ...httpB.sentTags()].sort()).toEqual(['1', '2', '3']);
		expect(httpB.calls).toHaveLength(0);
		expect(httpA.overlapsOfOneEntry).toEqual([]);
	});

	it('leader takeover: the new leader waits out the old one\'s send in flight and does not send that entry again', async () => {
		const oldLeader = await leaderTab();
		const successor = await signedInTab();
		const oldHttp = transport();
		const newHttp = transport();
		const inFlight = (await oldLeader.enqueue(message('E'), USER))!;
		await oldLeader.submitEntryToSender(USER, inFlight, oldHttp.send);
		await vi.waitFor(() => expect(oldHttp.sentTags()).toEqual(['E']));

		oldLeader.stopLeaderElection();
		const next = (await successor.enqueue(message('N'), USER))!;
		await successor.submitEntryToSender(USER, next, newHttp.send);
		await vi.waitFor(() => expect(successor.isLeader()).toBe(true));
		await drainMicrotasks();
		expect(newHttp.calls).toHaveLength(0);

		oldHttp.answer('E');
		await vi.waitFor(() => expect(newHttp.sentTags()).toEqual(['N']));
		newHttp.answer('N');
		await vi.waitFor(() => expect([statusOf(inFlight), statusOf(next)]).toEqual(['accepted', 'accepted']));
		expect(newHttp.sentTags()).toEqual(['N']);
	});
});

describe('the running pool picks up what is submitted to it', () => {
	it('A in flight, independent B submitted: B goes out in the same pool while A is still in flight', async () => {
		const tab = await leaderTab();
		const http = transport();
		const a = (await tab.enqueue(message('A'), USER))!;
		await tab.submitEntryToSender(USER, a, http.send);
		await vi.waitFor(() => expect(http.sentTags()).toEqual(['A']));

		const b = (await tab.enqueue(message('B'), USER))!;
		const { attempt } = await tab.submitEntryToSender(USER, b, http.send);
		await vi.waitFor(() => expect(http.sentTags()).toEqual(['A', 'B']));
		http.answer('B');
		expect(await attempt).toMatchObject({ kind: 'accepted' });
		http.answer('A');
	});

	it('never more than DRAIN_CONCURRENCY requests in flight, however many entries are submitted while it runs', async () => {
		const tab = await leaderTab();
		const http = transport();
		const count = tab.DRAIN_CONCURRENCY + 3;
		for (let i = 0; i < count; i++) {
			const id = (await tab.enqueue(message(`m${i}`), USER))!;
			await tab.submitEntryToSender(USER, id, http.send);
		}
		await vi.waitFor(() => expect(http.calls).toHaveLength(tab.DRAIN_CONCURRENCY));
		await drainMicrotasks();
		expect(http.calls).toHaveLength(tab.DRAIN_CONCURRENCY);
		while (http.calls.length < count) {
			const answered = http.calls.length;
			http.calls[answered - tab.DRAIN_CONCURRENCY].answer();
			await vi.waitFor(() => expect(http.calls.length).toBeGreaterThan(answered));
		}
		http.answerAll();
		expect(http.maxInFlight).toBe(tab.DRAIN_CONCURRENCY);
	});

	it('a dependent B submitted while A is in flight waits for A', async () => {
		const tab = await leaderTab();
		const http = transport();
		const a = (await tab.enqueue(message('A'), USER))!;
		await tab.submitEntryToSender(USER, a, http.send);
		await vi.waitFor(() => expect(http.sentTags()).toEqual(['A']));
		const b = (await tab.enqueue(message('B'), USER, { dependsOn: [a] }))!;

		const { attempt } = await tab.submitEntryToSender(USER, b, http.send);
		expect(await settledSoon(attempt)).toBe(false);
		expect(http.sentTags()).toEqual(['A']);

		http.answer('A');
		await vi.waitFor(() => expect(http.sentTags()).toEqual(['A', 'B']));
		http.answer('B');
		expect(await attempt).toMatchObject({ kind: 'accepted' });
	});

	it('a sleeping loop is woken, not restarted: a submitted entry goes now, while the backed-off one keeps its schedule', async () => {
		const tab = await leaderTab();
		const http = transport();
		const backedOff = (await tab.enqueue(message('late'), USER))!;
		await tab.recordFailure(backedOff, new Error('503'));
		const scheduled = JSON.parse(storage.map.get(backedOff)!).nextAttemptAt;
		tab.ensureDrainLoop(USER, http.send);
		await tab._drainLoopSettledForTests();

		const now = (await tab.enqueue(message('now'), USER))!;
		await tab.submitEntryToSender(USER, now, http.send);
		await vi.waitFor(() => expect(http.sentTags()).toEqual(['now']));
		http.answer('now');
		await vi.waitFor(() => expect(statusOf(now)).toBe('accepted'));
		expect(JSON.parse(storage.map.get(backedOff)!).nextAttemptAt).toBe(scheduled);
	});
});

describe('the pool\'s readiness is not bypassed', () => {
	const notSent = async (arrange: (tab: Outbox, id: string) => Promise<void>) => {
		const tab = await leaderTab();
		const http = transport();
		const id = (await tab.enqueue(message('X'), USER))!;
		await arrange(tab, id);
		const { attempt } = await tab.submitEntryToSender(USER, id, http.send);
		await tab._drainLoopSettledForTests();
		return { http, attempt };
	};

	it('an entry with unknown prerequisites (discovery-blocked) is not sent', async () => {
		const tab = await leaderTab();
		const http = transport();
		const block = tab.dependencyBlockFor(new Error('listing failed'), { kind: 'discovery', observedKeys: [] });
		const id = (await tab.enqueue(message('X'), USER, { discoveryBlocked: block }))!;
		const { attempt } = await tab.submitEntryToSender(USER, id, http.send);
		await tab._drainLoopSettledForTests();
		expect(http.calls).toHaveLength(0);
		expect(await settledSoon(attempt)).toBe(false); // still queued
	});

	it('an entry whose next attempt is in the future is not sent early', async () => {
		const { http, attempt } = await notSent(async (tab, id) => { await tab.recordFailure(id, new Error('503')); });
		expect(http.calls).toHaveLength(0);
		expect(await settledSoon(attempt)).toBe(false);
	});

	it('an entry already refused is reported settled at once, with its outcome', async () => {
		const tab = await leaderTab();
		const http = transport();
		const id = (await tab.enqueue(message('X'), USER))!;
		const { IngestError } = await import('@/lib/data/ingest');
		await tab.recordFailure(id, new IngestError('refused', { permanent: true }));

		const submission = await tab.submitEntryToSender(USER, id, http.send);
		expect(submission.disposition).toEqual({ kind: 'settled', outcome: { kind: 'rejected', error: 'refused' } });
		expect(http.calls).toHaveLength(0);
	});

	it('an entry the server already accepted, pending reconciliation, is not sent again', async () => {
		const { http, attempt } = await notSent(async (tab, id) => { await tab.markServerAccepted(id); });
		expect(http.calls).toHaveLength(0);
		expect(await attempt).toEqual({ kind: 'settled-elsewhere', outcome: { kind: 'accepted' } });
	});
});

describe('the attempt waiter', () => {
	it('each waiter gets its own entry\'s result', async () => {
		const tab = await leaderTab();
		const http = transport();
		const a = (await tab.enqueue(message('A'), USER))!;
		const b = (await tab.enqueue(message('B'), USER))!;
		const [subA, subB] = await Promise.all([tab.submitEntryToSender(USER, a, http.send), tab.submitEntryToSender(USER, b, http.send)]);
		await vi.waitFor(() => expect(http.sentTags().sort()).toEqual(['A', 'B']));

		http.answer('B', { txids: [2], results: [{ tag: 'B' }] });
		expect(await subB.attempt).toEqual({ kind: 'accepted', result: { txids: [2], results: [{ tag: 'B' }] } });
		expect(await settledSoon(subA.attempt)).toBe(false);
		http.answer('A', { txids: [1], results: [{ tag: 'A' }] });
		expect(await subA.attempt).toEqual({ kind: 'accepted', result: { txids: [1], results: [{ tag: 'A' }] } });
	});

	it('a failed attempt is reported as failed, with the error', async () => {
		const tab = await leaderTab();
		const http = transport();
		const id = (await tab.enqueue(message('A'), USER))!;
		const { attempt } = await tab.submitEntryToSender(USER, id, http.send);
		await vi.waitFor(() => expect(http.calls).toHaveLength(1));
		const error = new Error('503');
		http.calls[0].fail(error);
		expect(await attempt).toEqual({ kind: 'failed', error });
	});

	it('a server acceptance that cannot be stored is not reported as a success', async () => {
		const tab = await leaderTab();
		const http = transport();
		const id = (await tab.enqueue(message('A'), USER))!;
		storage.failSet = (key, value) => key === id && value.includes('server_accepted_pending_reconcile');
		const { attempt } = await tab.submitEntryToSender(USER, id, http.send);
		await vi.waitFor(() => expect(http.calls).toHaveLength(1));
		http.answer('A');

		expect(await attempt).toMatchObject({ kind: 'failed' });
		expect(statusOf(id)).toBeUndefined(); // still pending: nothing claims it was accepted
	});

	it('an acceptance that finds its entry gone is not reported as a success either', async () => {
		const tab = await leaderTab();
		const http = transport();
		const id = (await tab.enqueue(message('A'), USER))!;
		const { attempt } = await tab.submitEntryToSender(USER, id, http.send);
		await vi.waitFor(() => expect(http.calls).toHaveLength(1));
		storage.map.delete(id);
		http.answer('A');

		expect(await attempt).toMatchObject({ kind: 'failed', error: expect.any(tab.AcceptanceNotRecordedError) });
	});

	it('an account switch before the attempt settles fences the waiter', async () => {
		const tab = await leaderTab();
		const http = transport();
		const id = (await tab.enqueue(message('A'), USER))!;
		const { attempt } = await tab.submitEntryToSender(USER, id, http.send);
		await vi.waitFor(() => expect(http.calls).toHaveLength(1));

		tab.stopLeaderElection();
		tab.startLeaderElection(OTHER, () => {});
		expect(await attempt).toEqual({ kind: 'fenced' });
		http.answer('A');
	});

	it('a submission under another account\'s session is fenced at once; with no session nothing here attempts it', async () => {
		const tab = await openTab();
		const http = transport();
		const id = (await tab.enqueue(message('A'), USER))!;
		const alone = await tab.submitEntryToSender(USER, id, http.send);
		expect(alone.disposition).toEqual({ kind: 'queued', reason: 'not-sender' });

		tab.startLeaderElection(OTHER, () => {});
		const underOther = await tab.submitEntryToSender(USER, id, http.send);
		expect(await underOther.attempt).toEqual({ kind: 'fenced' });
		expect(http.calls).toHaveLength(0);
	});

	it('another tab\'s server acceptance reaches this tab\'s waiter even while its reconciliation is still pending', async () => {
		const leader = await leaderTab();
		const follower = await signedInTab();
		const leaderHttp = transport();
		const id = (await follower.enqueue(message('A'), USER))!;
		const { attempt } = await follower.submitEntryToSender(USER, id, transport().send);
		let seen: unknown = null;
		void attempt.then((a) => { seen = a; });

		await leader.submitEntryToSender(USER, id, leaderHttp.send, { reconcile: async () => { throw new Error('read model not ready'); } });
		await vi.waitFor(() => expect(leaderHttp.calls).toHaveLength(1));
		leaderHttp.answer('A');

		await vi.waitFor(() => expect(seen).toEqual({ kind: 'settled-elsewhere', outcome: { kind: 'accepted' } }));
		expect(statusOf(id)).toBe('server_accepted_pending_reconcile');
	});

	it('an entry another tab sent: the durable outcome, and no response invented', async () => {
		const leader = await leaderTab();
		const follower = await signedInTab();
		const leaderHttp = transport();
		const id = (await follower.enqueue(message('A'), USER))!;
		const { attempt } = await follower.submitEntryToSender(USER, id, transport().send);

		await leader.submitEntryToSender(USER, id, leaderHttp.send);
		await vi.waitFor(() => expect(leaderHttp.calls).toHaveLength(1));
		leaderHttp.answer('A');

		const seen = await attempt;
		expect(seen).toEqual({ kind: 'settled-elsewhere', outcome: { kind: 'accepted' } });
		expect(seen).not.toHaveProperty('result');
	});
});

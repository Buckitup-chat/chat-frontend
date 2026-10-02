import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeFakeLockManager } from './helpers/fakeWebLocks';

const USER = 'u_' + 'a'.repeat(128);
const CARD_KEYS = { sign_pkey: 'c2lnbg==', contact_pkey: 'Y29udGFjdA==', contact_cert: 'Y2VydA==', crypt_pkey: 'Y3J5cHQ=', crypt_cert: 'Y2VydA==' };
const SKEY = new Uint8Array(32).fill(3);
const DIALOG = 'di_' + '1'.repeat(128);

type Mutation = { type: string; modified?: Record<string, unknown>; original?: Record<string, unknown>; changes?: Record<string, unknown>; syncMetadata: { relation: string } };

const http = {
	calls: [] as Array<{ tag: string; body: string; answer: (status?: number) => void; fail: (e: unknown) => void }>,
	auto: null as null | 'ok' | 'offline' | 'reject' | 'unavailable',
};
const tagOf = (m: Mutation) => String((m.modified ?? m.changes)?.tag);
let signatures = 0;

vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string) => {
			signatures++;
			return { type, ...(type === 'insert' ? { modified: { ...row, sign_b64: `sig${signatures}` } } : { original: {}, changes: { ...row, sign_b64: `sig${signatures}` } }), syncMetadata: { relation } };
		},
		createUserCard: (name: string, keys: { user_hash: string }, type: string, ownerTimestamp: number) => {
			signatures++;
			const row = { ...CARD_KEYS, user_hash: keys.user_hash, name, owner_timestamp: ownerTimestamp, deleted_flag: false, tag: 'card', sign_b64: `sig${signatures}` };
			return { mutation: { type, ...(type === 'insert' ? { modified: row } : { original: {}, changes: row }), syncMetadata: { relation: 'user_cards' } } };
		},
		ingestWithAuthEach: (mutations: Mutation[]) => new Promise((resolve, reject) => {
			const respond = (status = 200) => resolve({
				status,
				json: async () => ({ results: mutations.map((_, index) => (status === 200
					? { index, status: 'ok', txid: 700 + http.calls.length }
					: { index, status: 'error', error: 'validation_failed' })) }),
			} as unknown as Response);
			http.calls.push({ tag: tagOf(mutations[0]), body: JSON.stringify(mutations), answer: respond, fail: reject });
			if (http.auto === 'ok') respond();
			else if (http.auto === 'reject') respond(422);
			else if (http.auto === 'unavailable') respond(503);
			else if (http.auto === 'offline') reject(new TypeError('Failed to fetch'));
		}),
	},
}));

const { sendMutationsAndAwaitShape, deliverStoredWrite, drainPendingWrites } = await import('@/lib/data/ingest');
const { signAndDispatchIntent } = await import('@/lib/data/intentRecovery');
const { enqueueIntent, _setIntentStorageForTests } = await import('@/lib/data/intents');
const outbox = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');
const { _setOwnObservedTailsStorageForTests } = await import('@/lib/data/ownObservedTails');

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		failSet: null as null | ((k: string, v: string) => boolean),
		holdGet: null as null | ((k: string) => Promise<void> | null),
		async get(k: string) { await this.holdGet?.(k); return map.get(k) ?? null; },
		async set(k: string, v: string) { if (this.failSet?.(k, v)) throw new Error('storage down'); map.set(k, v); },
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
	changes: { message_id: 'dmsg_X', sender_hash: USER, dialog_hash: DIALOG, tag },
	syncMetadata: { relation: 'dialog_messages' },
}];
const card = (tag = 'card'): Mutation[] => [{
	type: 'insert',
	modified: { ...CARD_KEYS, user_hash: USER, name: 'Me', owner_timestamp: 1, deleted_flag: false, tag, sign_b64: 'sig-card' },
	syncMetadata: { relation: 'user_cards' },
}];
const cardIntent = {
	kind: 'ready-row', relation: 'user_cards', mutationType: 'insert', purpose: 'bootstrap-prerequisite',
	row: { user_hash: USER, name: 'Me', owner_timestamp: 1, sign_pkey: 'c2lnbg==', contact_pkey: 'Y29udGFjdA==', contact_cert: 'Y2VydA==', crypt_pkey: 'Y3J5cHQ=', crypt_cert: 'Y2VydA==' },
};

let storage: ReturnType<typeof makeStorage>;
let releaseHeldScans: () => void = () => {};
const entries = () => [...storage.map.entries()].filter(([k]) => !k.includes('|')).map(([, v]) => JSON.parse(v));
const entryById = (id: string) => JSON.parse(storage.map.get(id)!);
const tagsSent = () => http.calls.map((c) => c.tag);
const drainMicrotasks = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const whenDue = async <T>(fn: () => Promise<T>): Promise<T> => {
	const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
	try { return await fn(); } finally { clock.mockRestore(); }
};

const becomeLeader = async (tab: typeof outbox = outbox) => {
	tab.startLeaderElection(USER, () => {});
	await vi.waitFor(() => expect(tab.isLeader()).toBe(true));
};
const openOtherTab = async () => {
	vi.resetModules();
	const tab = { outbox: await import('@/lib/data/outbox'), ingest: await import('@/lib/data/ingest') };
	tab.outbox._setStorageForTests(storage);
	(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStorage());
	(await import('@/lib/data/intents'))._setIntentStorageForTests(makeStorage());
	(await import('@/lib/data/ownObservedTails'))._setOwnObservedTailsStorageForTests(makeStorage());
	return tab;
};
const closeTab = async (tab: { outbox: typeof outbox }) => {
	tab.outbox.stopDrainLoop();
	tab.outbox.stopLeaderElection();
	await tab.outbox._drainLoopSettledForTests();
};

beforeEach(() => {
	http.calls = [];
	http.auto = null;
	signatures = 0;
	vi.stubGlobal('navigator', { locks: makeFakeLockManager() });
	storage = makeStorage();
	outbox._setStorageForTests(storage);
	_setIntentStorageForTests(makeStorage());
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setOwnObservedTailsStorageForTests(makeStorage());
});

afterEach(async () => {
	releaseHeldScans();
	storage.holdGet = null;
	http.auto = 'ok';
	for (const c of http.calls) c.answer();
	await closeTab({ outbox });
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('targeted bootstrap: one durable entry, sent alone', () => {
	it('a new bootstrap intent sends only its own entry; another queued write of the account stays unsent', async () => {
		await becomeLeader();
		const other = (await outbox.enqueue(receipt('queued-before'), USER))!;
		const id = (await enqueueIntent(cardIntent, USER, 'user_cards'))!;

		const sending = signAndDispatchIntent(id, cardIntent as never, SKEY, { bootstrap: true });
		await vi.waitFor(() => expect(tagsSent()).toEqual(['card']));
		http.calls[0].answer();
		expect((await sending).phase).toBe('accepted');

		await drainMicrotasks();
		expect(tagsSent()).toEqual(['card']);
		expect(entryById(other).status).toBeUndefined(); // still pending, untouched
	});

	it('deliverStoredWrite before the session: only that entry, even with other writes of the account ready', async () => {
		await becomeLeader();
		await outbox.enqueue(receipt('other'), USER);
		const id = (await outbox.enqueue(card(), USER))!;
		http.auto = 'ok';

		expect(await deliverStoredWrite(id, USER, SKEY)).toEqual({ kind: 'accepted' });
		await drainMicrotasks();
		expect(tagsSent()).toEqual(['card']);
	});

	it('a retry of the bootstrap sends the same entry, the same snapshot and signature', async () => {
		await becomeLeader();
		const id = (await enqueueIntent(cardIntent, USER, 'user_cards'))!;
		http.auto = 'offline';
		await expect(signAndDispatchIntent(id, cardIntent as never, SKEY, { bootstrap: true })).rejects.toThrow();
		const [stored] = entries().filter((e) => e.relation === 'user_cards');

		http.auto = 'ok';
		expect(await whenDue(() => deliverStoredWrite(stored.id, USER, SKEY))).toEqual({ kind: 'accepted' });
		expect(http.calls).toHaveLength(2);
		expect(http.calls[1].body).toBe(http.calls[0].body);
		expect(signatures).toBe(1);
		expect(entries().filter((e) => e.relation === 'user_cards').map((e) => e.id)).toEqual([stored.id]);
	});

	it('a follower tab makes no bootstrap HTTP: the leader sends it and the follower gets its verdict', async () => {
		const leaderTab = await openOtherTab();
		await becomeLeader(leaderTab.outbox);
		leaderTab.outbox.onOutboxWake((userHash) => leaderTab.ingest.drainPendingWrites(userHash, SKEY));
		outbox.startLeaderElection(USER, () => {});
		await drainMicrotasks();
		const id = (await outbox.enqueue(card(), USER))!;
		http.auto = 'ok';

		expect(await deliverStoredWrite(id, USER, SKEY)).toEqual({ kind: 'accepted' });
		expect(outbox.isLeader()).toBe(false);
		expect(tagsSent()).toEqual(['card']);
		await closeTab(leaderTab);
	});

	it('a bootstrap started before this tab\'s leadership request has settled still sends: the targeted send asks for it', async () => {
		const locks = makeFakeLockManager();
		let grant!: () => void;
		const granted = new Promise<void>((resolve) => { grant = resolve; });
		vi.stubGlobal('navigator', {
			locks: {
				request: async (name: string, options: unknown, callback?: unknown) => {
					if (name.startsWith('buckitup-outbox-drain:')) await granted;
					return locks.request(name, options, callback as never);
				},
			},
		});
		const id = (await outbox.enqueue(card(), USER))!;
		http.auto = 'ok';
		outbox.startLeaderElection(USER, () => {});
		const verdict = deliverStoredWrite(id, USER, SKEY);
		await drainMicrotasks();
		expect(outbox.isLeader()).toBe(false);
		grant();

		expect(await verdict).toEqual({ kind: 'accepted' });
		expect(tagsSent()).toEqual(['card']);
	});

	it('the leader tab itself sends a targeted bootstrap', async () => {
		await becomeLeader();
		const id = (await outbox.enqueue(card(), USER))!;
		http.auto = 'ok';
		expect(await deliverStoredWrite(id, USER, SKEY)).toEqual({ kind: 'accepted' });
		expect(tagsSent()).toEqual(['card']);
	});

	it('leader takeover during a bootstrap send: the successor waits out the request and does not send it again', async () => {
		const oldLeader = await openOtherTab();
		await becomeLeader(oldLeader.outbox);
		const id = (await oldLeader.outbox.enqueue(card(), USER))!;
		const first = oldLeader.ingest.deliverStoredWrite(id, USER, SKEY);
		await vi.waitFor(() => expect(http.calls).toHaveLength(1));
		oldLeader.outbox.stopLeaderElection();

		outbox.startLeaderElection(USER, () => {});
		const second = deliverStoredWrite(id, USER, SKEY);
		await drainMicrotasks();
		expect(http.calls).toHaveLength(1);
		http.calls[0].answer();

		await first.catch(() => null);
		expect(await second).toEqual({ kind: 'accepted' });
		expect(http.calls).toHaveLength(1);
		await closeTab(oldLeader);
	});

	it('an accepted bootstrap is not sent again', async () => {
		await becomeLeader();
		const id = (await outbox.enqueue(card(), USER))!;
		await outbox.markServerAccepted(id);
		expect(await deliverStoredWrite(id, USER, SKEY)).toEqual({ kind: 'accepted' });
		expect(http.calls).toHaveLength(0);
	});

	it('a transient bootstrap failure records one attempt and its retry time, and reports retrying', async () => {
		await becomeLeader();
		const id = (await outbox.enqueue(card(), USER))!;
		http.auto = 'offline';
		expect(await deliverStoredWrite(id, USER, SKEY)).toEqual({ kind: 'retrying' });
		expect(entryById(id)).toMatchObject({ attempts: 1, lastErrorNetwork: true, nextAttemptAt: expect.any(Number) });
		expect(http.calls).toHaveLength(1);
	});

	it('a permanent bootstrap rejection quarantines that exact entry', async () => {
		await becomeLeader();
		const other = (await outbox.enqueue(receipt('other'), USER))!;
		const id = (await outbox.enqueue(card(), USER))!;
		http.auto = 'reject';
		expect(await deliverStoredWrite(id, USER, SKEY)).toMatchObject({ kind: 'rejected' });
		expect(entryById(id).status).toBe('quarantined');
		expect(entryById(other).status).toBeUndefined();
	});

	it('an acceptance that cannot be stored durably is not reported as accepted', async () => {
		await becomeLeader();
		const id = (await outbox.enqueue(card(), USER))!;
		storage.failSet = (k, v) => k === id && v.includes('server_accepted_pending_reconcile');
		http.auto = 'ok';
		expect(await deliverStoredWrite(id, USER, SKEY)).not.toEqual({ kind: 'accepted' });
		expect(entryById(id).status).toBeUndefined();
	});

	it('deliverStoredWrite does not get around dependencies, a held entry or the schedule', async () => {
		await becomeLeader();
		const predecessor = (await outbox.enqueue(edit('A'), USER))!;
		const dependent = (await outbox.enqueue(edit('B'), USER, { dependsOn: [predecessor] }))!;
		const held = (await outbox.enqueue(card('held'), USER, {
			discoveryBlocked: outbox.dependencyBlockFor(new Error('x'), { kind: 'discovery', observedKeys: [] }),
		}))!;
		const scheduled = (await outbox.enqueue(receipt('later'), USER))!;
		await outbox.recordFailure(scheduled, new Error('503'));

		for (const id of [dependent, held, scheduled]) expect(await deliverStoredWrite(id, USER, SKEY)).toEqual({ kind: 'retrying' });
		await drainMicrotasks();
		expect(http.calls).toHaveLength(0);
	});
});

describe('a failure\'s schedule is authoritative for every worker', () => {
	it('a worker holding a scan from before another worker\'s failure does not send the entry again', async () => {
		await becomeLeader();
		const e = (await outbox.enqueue(receipt('E'), USER))!;
		const f = (await outbox.enqueue(receipt('F'), USER))!;
		let heldScans = 0;
		const scanHeld = new Promise<void>((resolve) => { releaseHeldScans = resolve; });
		storage.holdGet = (k) => {
			if (k !== f || !tagsSent().includes('E') || released) return null;
			heldScans++;
			return scanHeld;
		};
		let released = false;

		drainPendingWrites(USER, SKEY);
		await vi.waitFor(() => expect(tagsSent()).toContain('E'));
		outbox.wakeAccountSender(USER, async () => ({}));
		await vi.waitFor(() => expect(heldScans).toBeGreaterThan(0));
		http.calls.find((c) => c.tag === 'E')!.fail(new TypeError('Failed to fetch'));
		await vi.waitFor(() => expect(entryById(e)).toMatchObject({ attempts: 1, nextAttemptAt: expect.any(Number) }));
		await drainMicrotasks();
		released = true;
		releaseHeldScans();
		await drainMicrotasks();
		await drainMicrotasks();

		expect(tagsSent().filter((t) => t === 'E')).toHaveLength(1);
		expect(entryById(e).attempts).toBe(1);
	});

	it('after a transient failure there is no second attempt before its time, and then the same signed snapshot goes', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		try {
			await becomeLeader();
			http.auto = 'offline';
			await expect(sendMutationsAndAwaitShape(receipt('A'), SKEY)).rejects.toThrow();
			const [{ id, nextAttemptAt }] = entries();
			const body = http.calls[0].body;

			await vi.advanceTimersByTimeAsync(Math.max(nextAttemptAt - Date.now() - 50, 0));
			expect(http.calls).toHaveLength(1);

			http.auto = 'ok';
			await vi.advanceTimersByTimeAsync(60_000);
			expect(http.calls.length).toBeGreaterThanOrEqual(2);
			expect(http.calls[1].body).toBe(body);
			expect(storage.map.get(id)).toContain('"status":"accepted"');
		} finally {
			vi.useRealTimers();
		}
	});

	it('A in backoff does not hold up independent B; A\'s dependent A2 waits for A', async () => {
		await becomeLeader();
		http.auto = 'unavailable';
		await expect(sendMutationsAndAwaitShape(edit('A'), SKEY)).rejects.toThrow();
		http.auto = 'ok';

		const b = await sendMutationsAndAwaitShape(receipt('B'), SKEY);
		expect(b.phase).toBe('accepted');
		const a2 = await sendMutationsAndAwaitShape(edit('A2'), SKEY);
		expect(a2.phase).toBe('queued');
		await drainMicrotasks();
		expect(tagsSent()).toEqual(['A', 'B']);
	});

	it('a reload and a leader takeover keep the stored retry time', async () => {
		await becomeLeader();
		http.auto = 'offline';
		await expect(sendMutationsAndAwaitShape(receipt('A'), SKEY)).rejects.toThrow();
		const [{ id, nextAttemptAt }] = entries();
		await closeTab({ outbox });

		const reloaded = await openOtherTab();
		await becomeLeader(reloaded.outbox);
		http.auto = 'ok';
		reloaded.ingest.resumePendingWrites(USER, SKEY);
		await reloaded.outbox._drainLoopSettledForTests();
		expect(http.calls).toHaveLength(1);
		expect(entryById(id).nextAttemptAt).toBe(nextAttemptAt);
		await closeTab(reloaded);
	});

	it('live, replay and targeted sends record one attempt per request, the same way', async () => {
		await becomeLeader();
		http.auto = 'offline';
		await expect(sendMutationsAndAwaitShape(receipt('L'), SKEY)).rejects.toThrow();
		const live = entries().find((e) => e.mutations[0].modified.tag === 'L');

		const targeted = (await outbox.enqueue(card(), USER))!;
		await deliverStoredWrite(targeted, USER, SKEY);

		await whenDue(async () => {
			drainPendingWrites(USER, SKEY);
			await vi.waitFor(() => expect(entryById(live.id).attempts).toBe(2));
			await vi.waitFor(() => expect(entryById(targeted).attempts).toBe(2));
		});
		for (const tag of ['L', 'card']) {
			const id = tag === 'L' ? live.id : targeted;
			expect(tagsSent().filter((t) => t === tag)).toHaveLength(entryById(id).attempts);
			expect(entryById(id)).toMatchObject({ lastErrorNetwork: true, nextAttemptAt: expect.any(Number) });
		}
	});
});

describe('one transport path', () => {
	const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? sources(path) : /\.(ts|js|vue)$/.test(name) ? [path] : [];
	});
	const callSites = (pattern: RegExp, definition: RegExp) => sources(join(process.cwd(), 'src')).flatMap((file) =>
		readFileSync(file, 'utf8').split('\n')
			.map((line, i) => ({ line, i }))
			.filter(({ line }) => pattern.test(line) && !/^\s*(\*|\/\/)/.test(line) && !definition.test(line))
			.map(({ i }) => `${file.slice(process.cwd().length + 1)}:${i + 1}`));

	it('the only HTTP send of a mutation is the sender\'s send closure', () => {
		const enclosing = (site: string) => {
			const [file, line] = site.split(':');
			return readFileSync(join(process.cwd(), file), 'utf8').split('\n').slice(0, Number(line) - 1).reverse()
				.find((l) => /^(export )?(async )?function \w+|^const \w+ = /.test(l))?.match(/(?:function|const) (\w+)/)?.[1];
		};
		const withRetry = callSites(/\bsendMutationsWithRetry\(/, /function sendMutationsWithRetry\(/);
		expect(withRetry.map(enclosing)).toEqual(['replaySend']);
		const transport = callSites(/\.ingestWithAuthEach\(/, /ingestWithAuthEach: async/);
		expect(transport.map((site) => [site.split(':')[0], enclosing(site)])).toEqual([['src/lib/data/ingest.ts', 'sendMutations']]);
	});
});

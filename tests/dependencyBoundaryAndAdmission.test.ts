import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32);
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

const sent: unknown[][] = [];

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
			sent.push(mutations);
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })) }),
			} as unknown as Response;
		},
	},
}));

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
const newMessage = (text: string) => ([{
	type: 'insert',
	modified: { message_id: `dmsg_${text}`, sender_hash: MY_HASH, dialog_hash: 'dh1', content_b64: text },
	syncMetadata: { relation: 'dialog_messages' },
}]);

const textOf = (m: unknown[]): string => {
	const first = m[0] as { changes?: { content_b64: string }; modified?: { content_b64: string } };
	return (first.changes ?? first.modified)!.content_b64;
};
const textsSent = () => sent.map(textOf);
const dependsOnAtSend = new Map<string, string[] | undefined>();
const stored = (store: { map: Map<string, string> }, id: string) => JSON.parse(store.map.get(id) as string);

const failReadsOf = (store: StringStore, keys: () => string[], failing = { value: true }) => {
	const realGet = store.get.bind(store);
	store.get = async (k) => {
		if (failing.value && keys().includes(k)) throw new Error('disk read error');
		return realGet(k);
	};
	return failing;
};

let store: ReturnType<typeof makeStore>;

const settleLoop = async (o: { stopDrainLoop(): void; _drainLoopSettledForTests(): Promise<void> }): Promise<void> => {
	o.stopDrainLoop();
	await o._drainLoopSettledForTests();
};

beforeEach(() => {
	sent.length = 0;
	dependsOnAtSend.clear();
	store = makeStore();
});

const recordingSend = async (m: unknown[]): Promise<void> => {
	const text = textOf(m);
	for (const value of store.map.values()) {
		if (!value.startsWith('{')) continue;
		const entry = JSON.parse(value);
		if (Array.isArray(entry.mutations) && entry.mutations.length && textOf(entry.mutations) === text) dependsOnAtSend.set(text, entry.dependsOn);
	}
	sent.push(m);
};

afterEach(() => {
	vi.restoreAllMocks();
});

type Tab = typeof import('@/lib/data/outbox') & Pick<typeof import('@/lib/data/ingest'), 'sendMutationsAndAwaitShape' | 'rediscoverDependencies'>;

const openTab = async (random: number): Promise<Tab> => {
	vi.resetModules();
	const nonce = vi.spyOn(Math, 'random').mockReturnValue(random);
	const outbox = await import('@/lib/data/outbox');
	nonce.mockRestore();
	const ingest = await import('@/lib/data/ingest');
	const acceptedSnapshot = await import('@/lib/data/acceptedSnapshot');
	acceptedSnapshot._setAcceptedSnapshotStorageForTests(makeStore());
	outbox._setStorageForTests(store);
	outbox._setLeaderForTests(false);
	return { ...outbox, sendMutationsAndAwaitShape: ingest.sendMutationsAndAwaitShape, rediscoverDependencies: ingest.rediscoverDependencies };
};

const LOW = 0;
const HIGH = 0.99;

const drainAsLeader = async (tab: Tab) => {
	tab._setLeaderForTests(true);
	try {
		return await tab.drainOutbox(MY_HASH, recordingSend, undefined, undefined, tab.rediscoverDependencies);
	} finally {
		tab._setLeaderForTests(false);
		await settleLoop(tab);
	}
};

describe('recovery boundary across tabs: the ids of two tabs in one millisecond say nothing about order', () => {
	beforeEach(() => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
	});

	it('a real predecessor whose id sorts AFTER the blocked entry is never omitted', async () => {
		const tabHigh = await openTab(HIGH);
		const tabLow = await openTab(LOW);
		const pId = await tabHigh.enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		const failing = failReadsOf(store, () => [pId]);

		const handle = await tabLow.sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await settleLoop(tabLow);
		const bId = handle.outboxId as string;
		expect(bId < pId).toBe(true);
		expect(stored(store, bId).discoveryBlocked.observedKeys).toContain(pId);

		failing.value = false;
		await drainAsLeader(tabLow);

		expect(dependsOnAtSend.get('b')).toEqual([pId]);
		expect(textsSent()).toEqual(['p', 'b']);
	});

	it('a later entry whose id sorts BEFORE the blocked entry never becomes its predecessor: no cycle, even after a takeover', async () => {
		const tabHigh = await openTab(HIGH);
		const tabLow = await openTab(LOW);
		const zId = await tabHigh.enqueue(edit('msg_Z', 'z'), MY_HASH) as string;
		const failing = failReadsOf(store, () => [zId]);
		const handle = await tabHigh.sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await settleLoop(tabHigh);
		const bId = handle.outboxId as string;
		const later = await tabLow.sendMutationsAndAwaitShape(edit('msg_X', 'y'), SKEY);
		await settleLoop(tabLow);
		const yId = later.outboxId as string;
		expect(yId < bId).toBe(true);
		expect(stored(store, yId).discoveryBlocked.observedKeys).toContain(bId);
		expect(stored(store, bId).discoveryBlocked.observedKeys).not.toContain(yId);
		failing.value = false;

		const takeover = await openTab(LOW);
		await drainAsLeader(takeover);

		expect(stored(store, bId)).not.toHaveProperty('discoveryBlocked');
		expect(dependsOnAtSend.get('b') ?? []).not.toContain(yId);
		expect(dependsOnAtSend.get('y')).toEqual([bId]);
		expect(textsSent()).toEqual(['z', 'b', 'y']);
	});

	it('the block cannot clear while an observed record is unreadable, and records written later do not hold it', async () => {
		const tab = await openTab(LOW);
		const pId = await tab.enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		const failing = failReadsOf(store, () => [pId]);
		const handle = await tab.sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await settleLoop(tab);
		const bId = handle.outboxId as string;

		await drainAsLeader(tab);
		expect(stored(store, bId).discoveryBlocked).toMatchObject({ reason: 'storage_unavailable' });
		expect(stored(store, bId).discoveryBlocked.attempts).toBe(1);
		expect(sent).toEqual([]);

		failing.value = false;
		const later = await tab.enqueue(edit('msg_Q', 'q'), MY_HASH) as string;
		failReadsOf(store, () => [later]);
		await drainAsLeader(tab);

		expect(stored(store, bId)).not.toHaveProperty('discoveryBlocked');
		expect(dependsOnAtSend.get('b')).toEqual([pId]);
		expect(textsSent()).toEqual(['p', 'b']);
	});

	const overlappingRecoveries = () => {
		const arrived: Array<() => void> = [];
		const bothArrived = new Promise<void>((resolve) => { arrived.push(resolve); });
		let waiting = 0;
		const release = { a: () => {}, b: () => {} };
		const gated = (name: 'a' | 'b', outcome: (entry: Parameters<Tab['rediscoverDependencies']>[0]) => Promise<unknown>) =>
			async (entry: Parameters<Tab['rediscoverDependencies']>[0]) => {
				const go = new Promise<void>((r) => { release[name] = r; });
				if (++waiting === 2) arrived[0]();
				await go;
				return outcome(entry) as ReturnType<Tab['rediscoverDependencies']>;
			};
		return { bothArrived, release, gated };
	};

	const blockedWithoutBoundary = async (tab: Tab) => {
		let failures = 1;
		const realKeys = store.keys.bind(store);
		store.keys = async () => { if (failures-- > 0) throw new Error('listing failed'); return realKeys(); };
		const handle = await tab.sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await settleLoop(tab);
		return handle.outboxId as string;
	};

	it('two failed recoveries whose re-reads interleave (read, read, write, write) each count exactly one attempt', async () => {
		const tab = await openTab(LOW);
		const bId = await blockedWithoutBoundary(tab);
		expect(stored(store, bId).discoveryBlocked.attempts).toBe(0);
		const race = overlappingRecoveries();
		tab._setLeaderForTests(true);
		try {
			const a = tab.drainOutbox(MY_HASH, recordingSend, undefined, undefined, race.gated('a', tab.rediscoverDependencies));
			const b = tab.drainOutbox(MY_HASH, recordingSend, undefined, undefined, race.gated('b', tab.rediscoverDependencies));
			await race.bothArrived;
			race.release.a();
			race.release.b();
			await Promise.all([a, b]);
		} finally {
			tab._setLeaderForTests(false);
			await settleLoop(tab);
		}

		expect(stored(store, bId).discoveryBlocked.attempts).toBe(2);
		expect(sent).toEqual([]);
	});

	it('recoveries of one entry in two tabs are serialized by the Web Lock', async () => {
		const tails = new Map<string, Promise<void>>();
		const locks = {
			request<T>(name: string, fn: () => Promise<T>): Promise<T> {
				const run = (tails.get(name) ?? Promise.resolve()).then(fn);
				const tail = run.then(() => {}, () => {});
				tails.set(name, tail);
				return run;
			},
		};
		vi.stubGlobal('navigator', { locks });
		try {
			const tabA = await openTab(LOW);
			const tabB = await openTab(HIGH);
			const bId = await blockedWithoutBoundary(tabA);
			const race = overlappingRecoveries();
			tabA._setLeaderForTests(true);
			tabB._setLeaderForTests(true);
			try {
				const a = tabA.drainOutbox(MY_HASH, recordingSend, undefined, undefined, race.gated('a', tabA.rediscoverDependencies));
				const b = tabB.drainOutbox(MY_HASH, recordingSend, undefined, undefined, race.gated('b', tabB.rediscoverDependencies));
				await race.bothArrived;
				race.release.a();
				race.release.b();
				await Promise.all([a, b]);
			} finally {
				tabA._setLeaderForTests(false);
				tabB._setLeaderForTests(false);
				await settleLoop(tabA);
				await settleLoop(tabB);
			}

			expect(stored(store, bId).discoveryBlocked.attempts).toBe(2);
			expect(sent).toEqual([]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('a stale blocked outcome finishing after a successful recovery does not block the recovered entry again', async () => {
		const tab = await openTab(LOW);
		const bId = await blockedWithoutBoundary(tab);
		const staleBlock = stored(store, bId).discoveryBlocked;
		const race = overlappingRecoveries();
		tab._setLeaderForTests(true);
		try {
			const a = tab.drainOutbox(MY_HASH, recordingSend, undefined, undefined, race.gated('a', async () => ({ kind: 'blocked', block: staleBlock })));
			const b = tab.drainOutbox(MY_HASH, recordingSend, undefined, undefined, race.gated('b', async () => ({ kind: 'found', dependsOn: [] })));
			await race.bothArrived;
			race.release.b();
			race.release.a();
			await Promise.all([a, b]);
		} finally {
			tab._setLeaderForTests(false);
			await settleLoop(tab);
		}

		expect(stored(store, bId)).not.toHaveProperty('discoveryBlocked');
		expect(stored(store, bId).status).toBe('accepted');
		expect(textsSent()).toEqual(['b']);
	});

	it('with no boundary (the listing failed), the block never clears — however well storage reads later', async () => {
		const tab = await openTab(LOW);
		let failures = 1;
		const realKeys = store.keys.bind(store);
		store.keys = async () => { if (failures-- > 0) throw new Error('listing failed'); return realKeys(); };
		const handle = await tab.sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await settleLoop(tab);
		const bId = handle.outboxId as string;

		for (let i = 0; i < 3; i++) await drainAsLeader(tab);

		expect(stored(store, bId).discoveryBlocked).toMatchObject({ reason: 'boundary_unknown', observedKeys: null });
		expect(stored(store, bId).discoveryBlocked.attempts).toBe(3);
		expect(sent).toEqual([]);
	});
});

describe('one captured boundary: a record written between listing and reading never enters discovery', () => {
	const pauseAfterNextListing = () => {
		const realKeys = store.keys.bind(store);
		let reached!: () => void;
		let release!: () => void;
		const listed = new Promise<void>((r) => { reached = r; });
		const gate = new Promise<void>((r) => { release = r; });
		let armed = true;
		store.keys = async () => {
			const keys = await realKeys();
			if (armed) {
				armed = false;
				reached();
				await gate;
			}
			return keys;
		};
		return { listed, release };
	};

	it('a matching predecessor inserted after the listing is excluded from the discovery itself', async () => {
		const tabA = await openTab(LOW);
		const tabB = await openTab(HIGH);
		tabA._setLeaderForTests(false);
		const pause = pauseAfterNextListing();

		const sending = tabA.sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await pause.listed;
		const pId = await tabB.enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		pause.release();
		const handle = await sending;
		await settleLoop(tabA);

		const entry = stored(store, handle.outboxId as string);
		expect(entry).not.toHaveProperty('discoveryBlocked');
		expect(entry.dependsOn ?? []).not.toContain(pId);
	});

	it('in the same race with a failing discovery, the durable boundary excludes it too, and recovery reaches the same result', async () => {
		const tabA = await openTab(LOW);
		const tabB = await openTab(HIGH);
		tabA._setLeaderForTests(false);
		const zId = await tabA.enqueue(edit('msg_Z', 'z'), MY_HASH) as string;
		const failing = failReadsOf(store, () => [zId]);
		const pause = pauseAfterNextListing();

		const sending = tabA.sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await pause.listed;
		const pId = await tabB.enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		pause.release();
		const handle = await sending;
		await settleLoop(tabA);
		const bId = handle.outboxId as string;

		expect(stored(store, bId).discoveryBlocked.observedKeys).toEqual([zId]);
		failing.value = false;
		await drainAsLeader(tabA);

		expect(dependsOnAtSend.get('b') ?? []).not.toContain(pId);
		expect(textsSent().sort()).toEqual(['b', 'p', 'z']);
	});

	it('a key of the boundary that no longer holds a record keeps the block — it is never silently dropped', async () => {
		const tab = await openTab(LOW);
		tab._setLeaderForTests(false);
		const pId = await tab.enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		const zId = await tab.enqueue(edit('msg_Z', 'z'), MY_HASH) as string;
		const failing = failReadsOf(store, () => [zId]);
		const handle = await tab.sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY);
		await settleLoop(tab);
		const bId = handle.outboxId as string;
		expect(stored(store, bId).discoveryBlocked.observedKeys.sort()).toEqual([pId, zId].sort());

		failing.value = false;
		store.map.delete(pId);
		await drainAsLeader(tab);

		expect(stored(store, bId).discoveryBlocked).toMatchObject({ reason: 'record_missing' });
		expect(textsSent()).not.toContain('b');
	});
});

describe('admission blocks are durable across a real reload', () => {
	const SCOPE = 'dialog_messages|dh1';

	type Session = {
		outbox: typeof import('@/lib/data/outbox');
		ingest: typeof import('@/lib/data/ingest');
		coordinator: typeof import('@/lib/data/coordinator');
		staleBase: typeof import('@/lib/data/staleBase');
	};
	let session: Session | null = null;

	const reload = async (): Promise<Session> => {
		if (session) {
			await settleLoop(session.outbox);
			session.outbox._setLeaderForTests(null);
		}
		vi.resetModules();
		const next: Session = {
			outbox: await import('@/lib/data/outbox'),
			ingest: await import('@/lib/data/ingest'),
			coordinator: await import('@/lib/data/coordinator'),
			staleBase: await import('@/lib/data/staleBase'),
		};
		(await import('@/lib/data/acceptedSnapshot'))._setAcceptedSnapshotStorageForTests(makeStore());
		next.outbox._setStorageForTests(store);
		next.outbox._setLeaderForTests(true);
		session = next;
		return next;
	};

	afterEach(async () => {
		if (session) await settleLoop(session.outbox);
		session?.outbox._setLeaderForTests(null);
		session = null;
	});

	const drain = (s: Session) => s.outbox.drainOutbox(MY_HASH, recordingSend, undefined, undefined, s.ingest.rediscoverDependencies);

	const sendHeld = async (s: Session, mutations: unknown[]) => {
		s.staleBase.markUnconfirmed(SCOPE);
		const handle = await s.ingest.sendMutationsAndAwaitShape(mutations, SKEY);
		await settleLoop(s.outbox);
		expect(handle.phase).toBe('queued');
		expect(handle.held).toEqual({ reason: 'stale_base', message: 'it was built on data the server has not confirmed yet — it waits until that data is confirmed' });
		return handle.outboxId as string;
	};

	it('stores the exact snapshot with its scope and confirmation generation, sends nothing, and reports a held write', async () => {
		const s = await reload();
		const mutations = edit('msg_X', 'b');

		const id = await sendHeld(s, mutations);

		const entry = stored(store, id);
		expect(entry.mutations).toEqual(mutations);
		expect(entry.discoveryBlocked).toMatchObject({ kind: 'admission', reason: 'stale_base', observedKeys: [], admission: { scope: SCOPE, generation: 0 } });
		expect(entry).not.toHaveProperty('dependsOn');
		expect(sent).toEqual([]);
	});

	it('a reload is not a confirmation: nothing is sent until the scope is durably confirmed', async () => {
		let s = await reload();
		const id = await sendHeld(s, edit('msg_X', 'b'));

		s = await reload();
		expect(s.staleBase.isUnconfirmed(SCOPE)).toBe(false);
		await drain(s);
		await drain(s);
		expect(sent).toEqual([]);
		expect(stored(store, id).discoveryBlocked).toMatchObject({ kind: 'admission', reason: 'stale_base' });

		await s.coordinator.confirmScope(SCOPE);
		s = await reload();
		await drain(s);

		expect(stored(store, id)).not.toHaveProperty('discoveryBlocked');
		expect(textsSent()).toEqual(['b']);
	});

	it('after a durable confirmation, recovery runs normal discovery, stores the real dependencies, and only then dispatches', async () => {
		let s = await reload();
		const pId = await s.outbox.enqueue(edit('msg_X', 'p'), MY_HASH) as string;
		s.outbox._setLeaderForTests(false);
		const id = await sendHeld(s, edit('msg_X', 'b'));
		await s.coordinator.confirmScope(SCOPE);

		s = await reload();
		await drain(s);

		expect(stored(store, id)).not.toHaveProperty('discoveryBlocked');
		expect(dependsOnAtSend.get('b')).toEqual([pId]);
		expect(textsSent()).toEqual(['p', 'b']);
	});

	it('a confirmation of another scope does not clear it', async () => {
		let s = await reload();
		const id = await sendHeld(s, edit('msg_X', 'b'));
		await s.coordinator.confirmScope('dialog_messages|other');

		s = await reload();
		await drain(s);

		expect(sent).toEqual([]);
		expect(stored(store, id).discoveryBlocked.reason).toBe('stale_base');
	});

	it('a confirmation older than the block does not clear it', async () => {
		let s = await reload();
		await s.coordinator.confirmScope(SCOPE);
		const id = await sendHeld(s, edit('msg_X', 'b'));
		expect(stored(store, id).discoveryBlocked.admission).toEqual({ scope: SCOPE, generation: 1 });

		s = await reload();
		await drain(s);

		expect(sent).toEqual([]);
		expect(stored(store, id).discoveryBlocked.reason).toBe('stale_base');
	});

	it('a confirmation that cannot be stored leaves the block in place', async () => {
		let s = await reload();
		const id = await sendHeld(s, edit('msg_X', 'b'));
		const realSet = store.set.bind(store);
		store.set = async (k, v) => { if (k.startsWith('confirm|')) throw new Error('disk full'); return realSet(k, v); };
		await s.coordinator.confirmScope(SCOPE);
		store.set = realSet;

		s = await reload();
		await drain(s);

		expect(sent).toEqual([]);
		expect(stored(store, id).discoveryBlocked.reason).toBe('stale_base');
	});

	it('a failed confirmation keeps the scope refused in this session: a new chained write is held too, nothing is sent until a stored confirmation', async () => {
		const s = await reload();
		const firstId = await sendHeld(s, edit('msg_X', 'b1'));
		const realSet = store.set.bind(store);
		store.set = async (k, v) => { if (k.startsWith('confirm|')) throw new Error('disk full'); return realSet(k, v); };

		await s.coordinator.confirmScope(SCOPE);

		expect(s.staleBase.isUnconfirmed(SCOPE)).toBe(true);
		const second = await s.ingest.sendMutationsAndAwaitShape(edit('msg_X', 'b2'), SKEY);
		await settleLoop(s.outbox);
		expect(second.phase).toBe('queued');
		expect(second.held?.reason).toBe('stale_base');
		await drain(s);
		expect(sent).toEqual([]);
		expect(stored(store, firstId).discoveryBlocked.reason).toBe('stale_base');
		expect(stored(store, second.outboxId as string).discoveryBlocked.reason).toBe('stale_base');

		store.set = realSet;
		await s.coordinator.confirmScope(SCOPE);
		expect(s.staleBase.isUnconfirmed(SCOPE)).toBe(false);
		await drain(s);

		expect(dependsOnAtSend.get('b2')).toEqual([firstId]);
		expect(textsSent()).toEqual(['b1', 'b2']);
	});

	it('if the held snapshot cannot be stored, the caller gets DurabilityError and nothing is sent', async () => {
		const s = await reload();
		s.staleBase.markUnconfirmed(SCOPE);
		store.set = async () => { throw new Error('disk full'); };

		await expect(s.ingest.sendMutationsAndAwaitShape(edit('msg_X', 'b'), SKEY)).rejects.toBeInstanceOf(s.ingest.DurabilityError);
		expect(sent).toEqual([]);
	});

	it('an unrelated independent write still dispatches while the admission block holds', async () => {
		const s = await reload();
		const id = await sendHeld(s, edit('msg_X', 'b'));
		const tails = await import('@/lib/data/ownObservedTails');
		tails._setOwnObservedTailsStorageForTests(makeStore());
		await tails.recordOwnObservedTails('dmsg_hello', {}, MY_HASH);

		const handle = await s.ingest.sendMutationsAndAwaitShape(newMessage('hello'), SKEY);

		expect(handle.phase).toBe('accepted');
		expect(textsSent()).toEqual(['hello']);
		expect((await s.outbox.blockedEntries(MY_HASH)).map((e) => e.id)).toContain(id);
	});
});

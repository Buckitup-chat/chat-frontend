import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory, IDBDatabase as FakeIDBDatabase } from 'fake-indexeddb';
import type { AtomicLeaseStore, FallbackLease } from '@/lib/data/outbox';

const MY_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);

function makeControllableLeaseStore() {
	const map = new Map<string, FallbackLease>();
	let queue: Promise<unknown> = Promise.resolve();
	let gate: (() => Promise<void>) | null = null;

	function enqueue<T>(fn: () => T): Promise<T> {
		const result = queue.then(async () => {
			if (gate) {
				const g = gate;
				gate = null;
				await g();
			}
			return fn();
		});
		queue = result.then(() => undefined, () => undefined);
		return result;
	}

	const store: AtomicLeaseStore = {
		claim(userHash, candidate, now) {
			return enqueue(() => {
				const current = map.get(userHash);
				const winner = current && current.instanceId !== candidate.instanceId && current.expiresAt > now
					? current
					: candidate;
				map.set(userHash, winner);
				return winner;
			});
		},
		release(userHash, ownerId) {
			return enqueue(() => {
				const current = map.get(userHash);
				if (!current || current.instanceId !== ownerId) return;
				map.delete(userHash);
			});
		},
	};

	return {
		store,
		map,
		armGate(): () => void {
			let resolveFn!: () => void;
			const p = new Promise<void>((resolve) => { resolveFn = resolve; });
			gate = () => p;
			return () => resolveFn();
		},
	};
}

type OutboxModule = typeof import('@/lib/data/outbox');
type CoordinatorModule = typeof import('@/lib/data/coordinator');

async function freshTabInstance(): Promise<{ outbox: OutboxModule; coordinator: CoordinatorModule }> {
	vi.resetModules();
	const outbox = await import('@/lib/data/outbox');
	const coordinator = await import('@/lib/data/coordinator');
	return { outbox, coordinator };
}

const message = (tag: string, userHash = MY_HASH) => ([{
	type: 'insert',
	modified: { message_id: `dmsg_${tag}`, sender_hash: userHash, content_b64: tag },
	syncMetadata: { relation: 'dialog_messages' },
}]);

const makeEntryStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

describe('outbox.ts fallback leadership: atomic claim/release closes the concurrency defects (v3 §3)', () => {
	let leaseStore: ReturnType<typeof makeControllableLeaseStore>;
	let tabA: OutboxModule;
	let tabB: OutboxModule;
	let coordA: CoordinatorModule;
	let coordB: CoordinatorModule;

	beforeEach(async () => {
		leaseStore = makeControllableLeaseStore();
		const sharedEntryStorage = makeEntryStorage();
		({ outbox: tabA, coordinator: coordA } = await freshTabInstance());
		tabA._setAtomicLeaseStoreForTests(leaseStore.store);
		tabA._setStorageForTests(sharedEntryStorage);
		({ outbox: tabB, coordinator: coordB } = await freshTabInstance());
		tabB._setAtomicLeaseStoreForTests(leaseStore.store);
		tabB._setStorageForTests(sharedEntryStorage);
	});

	it('1. A confirms a claim; B\'s later attempt never overwrites the still-valid lease into both getting leadership', async () => {
		tabA.startLeaderElection(MY_HASH, () => {});
		await vi.waitFor(() => expect(tabA.isLeader()).toBe(true));
		const leaseAfterA = leaseStore.map.get(MY_HASH);
		expect(leaseAfterA).toBeDefined();

		tabB.startLeaderElection(MY_HASH, () => {});
		await new Promise((r) => setTimeout(r, 20));

		expect([tabA.isLeader(), tabB.isLeader()].filter(Boolean)).toHaveLength(1);
		expect(tabA.isLeader()).toBe(true);
		expect(tabB.isLeader()).toBe(false);
		expect(leaseStore.map.get(MY_HASH)).toBe(leaseAfterA);
	});

	it('2. two live-sends fired immediately after startLeaderElection (before either confirms) — exactly one transport call total', async () => {
		tabA.startLeaderElection(MY_HASH, () => {});
		tabB.startLeaderElection(MY_HASH, () => {});

		const idA = await tabA.enqueue(message('a'), MY_HASH);
		const idB = await tabB.enqueue(message('b'), MY_HASH);
		expect(idA).toBeTruthy();
		expect(idB).toBeTruthy();

		const sentA: unknown[][] = [];
		const sentB: unknown[][] = [];
		const sendA = async (m: unknown[]) => { sentA.push(m); return { txids: [], results: [] }; };
		const sendB = async (m: unknown[]) => { sentB.push(m); return { txids: [], results: [] }; };

		const [resultA, resultB] = await Promise.allSettled([
			coordA.dispatchMutations(message('a'), sendA, idA),
			coordB.dispatchMutations(message('b'), sendB, idB),
		]);

		expect(sentA.length + sentB.length).toBe(1);
		const outcomes = [resultA, resultB];
		expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
	});

	it('3. a send outlasting one TTL window is kept renewed — a follower never starts parallel transport', async () => {
		await tabA.enqueue(message('long'), MY_HASH);
		tabA.startLeaderElection(MY_HASH, () => {});
		await vi.waitFor(() => expect(tabA.isLeader()).toBe(true));

		vi.useFakeTimers();
		try {
			let releaseSend!: () => void;
			const held = new Promise<void>((r) => { releaseSend = r; });
			const sentA: unknown[][] = [];

			const drainPromise = tabA.drainOutbox(MY_HASH, async (m) => {
				sentA.push(m as unknown[]);
				await held;
				return {};
			});
			await vi.advanceTimersByTimeAsync(0);

			await vi.advanceTimersByTimeAsync(35_000);

			tabB.startLeaderElection(MY_HASH, () => {});
			const sentB: unknown[][] = [];
			const resultB = await tabB.drainOutbox(MY_HASH, async (m) => { sentB.push(m as unknown[]); return {}; });

			expect(resultB.wasLeader).toBe(false);
			expect(sentB).toHaveLength(0);

			releaseSend();
			await vi.advanceTimersByTimeAsync(0);
			await drainPromise;
			expect(sentA).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('4. a stale release from a superseded leader can never delete the new owner\'s lease', async () => {
		tabA.startLeaderElection(MY_HASH, () => {});
		await vi.waitFor(() => expect(tabA.isLeader()).toBe(true));

		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + 60_000);
			tabB.startLeaderElection(MY_HASH, () => {});
			await vi.waitFor(() => expect(tabB.isLeader()).toBe(true));
		} finally {
			vi.useRealTimers();
		}
		const leaseAfterB = leaseStore.map.get(MY_HASH);
		expect(leaseAfterB).toBeDefined();

		tabA.stopLeaderElection();
		await new Promise((r) => setTimeout(r, 20));

		expect(tabB.isLeader()).toBe(true);
		expect(leaseStore.map.get(MY_HASH)).toBe(leaseAfterB);
	});

	it('5. coordination primitive unavailable — no live, retry, or replay transport is ever called', async () => {
		tabA._setAtomicLeaseStoreForTests(null);

		tabA.startLeaderElection(MY_HASH, () => {});
		await vi.waitFor(() => expect(tabA.isLeader()).toBe(false));

		const outboxId = await tabA.enqueue(message('unavailable'), MY_HASH);
		expect(outboxId).toBeTruthy();
		const sendSpy = vi.fn(async () => ({ txids: [], results: [] }));

		const drainResult = await tabA.drainOutbox(MY_HASH, sendSpy);
		expect(drainResult.wasLeader).toBe(false);

		await expect(coordA.dispatchMutations(message('unavailable'), sendSpy, outboxId)).rejects.toThrow();

		expect(sendSpy).not.toHaveBeenCalled();
	});

	it('6. two tabs on two different accounts never block each other', async () => {
		tabA.startLeaderElection(MY_HASH, () => {});
		tabB.startLeaderElection(OTHER_HASH, () => {});

		await vi.waitFor(() => {
			expect(tabA.isLeader()).toBe(true);
			expect(tabB.isLeader()).toBe(true);
		});
	});

	it('7. the follower only durably enqueues — its own drainOutbox never calls transport while a leader holds the lease', async () => {
		tabA.startLeaderElection(MY_HASH, () => {});
		tabB.startLeaderElection(MY_HASH, () => {});
		await vi.waitFor(() => {
			expect([tabA.isLeader(), tabB.isLeader()].filter(Boolean)).toHaveLength(1);
		});
		const follower = tabA.isLeader() ? tabB : tabA;

		const outboxId = await follower.enqueue(message('follower-write'), MY_HASH);
		expect(outboxId).toBeTruthy();

		const sent: unknown[][] = [];
		const result = await follower.drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });

		expect(sent).toHaveLength(0);
		expect(result.wasLeader).toBe(false);
		expect((await follower.pendingEntries(MY_HASH)).map((e) => e.id)).toContain(outboxId);
	});

	it('8. stopLeaderElection during a held-open send: the follower cannot transport until the old send genuinely finishes, then takeover works (§ correctness boundary 3)', async () => {
		await tabA.enqueue(message('held'), MY_HASH);
		tabA.startLeaderElection(MY_HASH, () => {});
		await vi.waitFor(() => expect(tabA.isLeader()).toBe(true));

		let releaseSend!: () => void;
		const held = new Promise<void>((r) => { releaseSend = r; });
		const sentA: unknown[][] = [];
		const drainPromiseA = tabA.drainOutbox(MY_HASH, async (m) => {
			sentA.push(m as unknown[]);
			await held;
			return {};
		});
		await vi.waitFor(() => expect(sentA).toHaveLength(1));

		tabA.stopLeaderElection();

		const sentB: unknown[][] = [];
		tabB.startLeaderElection(MY_HASH, () => {});
		const resultBWhileHeld = await tabB.drainOutbox(MY_HASH, async (m) => { sentB.push(m as unknown[]); return {}; });
		expect(resultBWhileHeld.wasLeader).toBe(false);
		expect(sentB).toHaveLength(0);

		releaseSend();
		await drainPromiseA;
		expect(sentA).toHaveLength(1);

		await vi.waitFor(async () => {
			const resultBAfter = await tabB.drainOutbox(MY_HASH, async (m) => { sentB.push(m as unknown[]); return {}; });
			expect(resultBAfter.wasLeader).toBe(true);
		});
	});

	it('9. a claim that only confirms after stopLeaderElection() must not start transport, and must not leave its own won lease dangling (§ determinism 1)', async () => {
		tabA._setActiveSessionForTests(MY_HASH);
		const releaseGate = leaseStore.armGate();
		const sendSpy = vi.fn(async () => 'sent');

		const opPromise = tabA.withAcquiredLeadership(MY_HASH, sendSpy);

		tabA.stopLeaderElection();

		releaseGate();

		const outcome = await opPromise;
		expect(outcome).toEqual({ acquired: false });
		expect(sendSpy).not.toHaveBeenCalled();

		tabB._setActiveSessionForTests(MY_HASH);
		const takeover = await tabB.withAcquiredLeadership(MY_HASH, async () => 'ok');
		expect(takeover).toEqual({ acquired: true, result: 'ok' });
	});

	it('10. logout then relogin as the same account in the same tab, while the old send is still finishing: the delayed old release must not delete the new lease (§ determinism 2)', async () => {
		await tabA.enqueue(message('relogin'), MY_HASH);
		tabA.startLeaderElection(MY_HASH, () => {});
		await vi.waitFor(() => expect(tabA.isLeader()).toBe(true));
		const oldLease = leaseStore.map.get(MY_HASH);
		expect(oldLease).toBeDefined();

		let releaseSend!: () => void;
		const held = new Promise<void>((r) => { releaseSend = r; });
		const sentA: unknown[][] = [];
		const drainPromiseA = tabA.drainOutbox(MY_HASH, async (m) => { sentA.push(m as unknown[]); await held; return {}; });
		await vi.waitFor(() => expect(sentA).toHaveLength(1));

		tabA.stopLeaderElection();

		vi.useFakeTimers();
		try {
			vi.setSystemTime(Date.now() + 60_000);
			tabA.startLeaderElection(MY_HASH, () => {});
			await vi.waitFor(() => expect(tabA.isLeader()).toBe(true));
		} finally {
			vi.useRealTimers();
		}
		const newLease = leaseStore.map.get(MY_HASH);
		expect(newLease).toBeDefined();
		expect(newLease).not.toBe(oldLease);

		releaseSend();
		await drainPromiseA;
		await new Promise((r) => setTimeout(r, 20));

		expect(leaseStore.map.get(MY_HASH)).toBe(newLease);
		expect(tabA.isLeader()).toBe(true);
	});

	it('11. startLeaderElection\'s own initial claim, paused, that only commits after stop(): the callback never fires and the lease is released immediately — no TTL wait for takeover (§ determinism gap 1)', async () => {
		const releaseGate = leaseStore.armGate();
		let becameLeaderCalled = false;
		tabA.startLeaderElection(MY_HASH, () => { becameLeaderCalled = true; });

		tabA.stopLeaderElection();

		releaseGate();
		await new Promise((r) => setTimeout(r, 20));

		expect(becameLeaderCalled).toBe(false);
		expect(tabA.isLeader()).toBe(false);
		expect(leaseStore.map.get(MY_HASH)).toBeUndefined();

		tabB._setActiveSessionForTests(MY_HASH);
		const takeover = await tabB.withAcquiredLeadership(MY_HASH, async () => 'ok');
		expect(takeover).toEqual({ acquired: true, result: 'ok' });
	});

	it('12. durable dispatchMutations begun after logout (no active session): transport is never called, even though the entry is durably enqueued and ready (§ determinism gap 2)', async () => {
		tabA._setActiveSessionForTests(MY_HASH);
		const outboxId = await tabA.enqueue(message('post-logout'), MY_HASH);
		tabA.stopLeaderElection();

		const sendSpy = vi.fn(async () => ({ txids: [], results: [] }));
		await expect(coordA.dispatchMutations(message('post-logout'), sendSpy, outboxId))
			.rejects.toThrow(coordA.AlreadyDispatchingError);
		expect(sendSpy).not.toHaveBeenCalled();
	});

	it('13. fn synchronously calling stopLeaderElection() before its own first await must not free the lease early — a follower does not get it until fn genuinely finishes (§ determinism gap 3)', async () => {
		tabA.startLeaderElection(MY_HASH, () => {});
		await vi.waitFor(() => expect(tabA.isLeader()).toBe(true));

		let releaseFn!: () => void;
		const held = new Promise<void>((r) => { releaseFn = r; });
		let stopCalledSynchronously = false;

		const opPromise = tabA.withAcquiredLeadership(MY_HASH, async () => {
			tabA.stopLeaderElection();
			stopCalledSynchronously = true;
			await held;
			return 'done';
		});

		await vi.waitFor(() => expect(stopCalledSynchronously).toBe(true));

		tabB._setActiveSessionForTests(MY_HASH);
		const followerDuring = await tabB.withAcquiredLeadership(MY_HASH, async () => 'follower-ran');
		expect(followerDuring).toEqual({ acquired: false });

		releaseFn();
		const result = await opPromise;
		expect(result).toEqual({ acquired: true, result: 'done' });

		await vi.waitFor(async () => {
			const followerAfter = await tabB.withAcquiredLeadership(MY_HASH, async () => 'follower-after');
			expect(followerAfter).toEqual({ acquired: true, result: 'follower-after' });
		});
	});
});

function makeDelayableEntryStorage() {
	const map = new Map<string, string>();
	let gate: Promise<void> | null = null;
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) {
			if (gate) {
				const armed = gate;
				gate = null;
				await armed;
			}
			map.set(k, v);
		},
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
		armDelayOnNextSet(): () => void {
			let release!: () => void;
			const p = new Promise<void>((resolve) => { release = resolve; });
			gate = p;
			return () => release();
		},
	};
}

describe('IndexedDB claim(): committed only on tx.oncomplete, never on put.onsuccess alone (§ correctness boundary 1)', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const originalIndexedDB = (globalThis as any).indexedDB;

	afterEach(() => {
		if (originalIndexedDB === undefined) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			delete (globalThis as any).indexedDB;
		} else {
			globalThis.indexedDB = originalIndexedDB;
		}
	});

	function armAbortOnNextReadwriteTransactionPut(): void {
		const originalTransaction = FakeIDBDatabase.prototype.transaction;
		FakeIDBDatabase.prototype.transaction = function (
			this: IDBDatabase,
			...args: Parameters<IDBDatabase['transaction']>
		): IDBTransaction {
			const tx = originalTransaction.apply(this, args);
			if (args[1] !== 'readwrite') return tx;
			FakeIDBDatabase.prototype.transaction = originalTransaction;
			const originalObjectStore = tx.objectStore.bind(tx);
			tx.objectStore = ((name: string) => {
				const store = originalObjectStore(name);
				const originalPut = store.put.bind(store);
				store.put = ((...putArgs: Parameters<typeof store.put>) => {
					const req = originalPut(...putArgs);
					req.addEventListener('success', () => { tx.abort(); }, { once: true });
					return req;
				}) as typeof store.put;
				return store;
			}) as typeof tx.objectStore;
			return tx;
		};
	}

	it('aborts the live-send path: dispatchMutations\'s own claim aborts after put.onsuccess — it rejects, and transport is never called', async () => {
		globalThis.indexedDB = new IDBFactory();
		armAbortOnNextReadwriteTransactionPut();

		const { outbox, coordinator } = await freshTabInstance();
		outbox._setStorageForTests(makeEntryStorage());
		outbox._setActiveSessionForTests(MY_HASH);

		const outboxId = await outbox.enqueue(message('aborted-live'), MY_HASH);
		const sendSpy = vi.fn(async () => ({ txids: [], results: [] }));

		await expect(coordinator.dispatchMutations(message('aborted-live'), sendSpy, outboxId)).rejects.toThrow();
		expect(sendSpy).not.toHaveBeenCalled();
	});

	it('aborts the replay path: drainOutbox\'s own claim aborts after put.onsuccess — it reports wasLeader:false, and transport is never called', async () => {
		globalThis.indexedDB = new IDBFactory();

		const { outbox } = await freshTabInstance();
		outbox._setStorageForTests(makeEntryStorage());
		outbox._setActiveSessionForTests(MY_HASH);
		await outbox.enqueue(message('aborted-replay'), MY_HASH);
		const sendSpy = vi.fn(async () => ({}));

		armAbortOnNextReadwriteTransactionPut();

		const result = await outbox.drainOutbox(MY_HASH, sendSpy);

		expect(result.wasLeader).toBe(false);
		expect(sendSpy).not.toHaveBeenCalled();
	});
});

describe('Web Locks: the transport gate is genuinely operation-scoped, not a leadership probe (§ correctness boundary 2)', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const originalNavigator = (globalThis as any).navigator;

	afterEach(() => {
		if (originalNavigator === undefined) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			delete (globalThis as any).navigator;
		} else {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(globalThis as any).navigator = originalNavigator;
		}
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function makeFakeLockManager(): any {
		const chains = new Map<string, Promise<void>>();
		async function request(name: string, optionsArg: unknown, callbackArg?: unknown): Promise<unknown> {
			const hasOptions = typeof optionsArg !== 'function';
			const options = (hasOptions ? optionsArg : {}) as { ifAvailable?: boolean };
			const callback = (hasOptions ? callbackArg : optionsArg) as (lock: { name: string } | null) => Promise<unknown>;

			if (options.ifAvailable && chains.has(name)) {
				return callback(null);
			}
			const previous = chains.get(name) ?? Promise.resolve();
			let releaseThis!: () => void;
			const thisHold = new Promise<void>((resolve) => { releaseThis = resolve; });
			const ourTurn = previous.then(() => undefined, () => undefined);
			chains.set(name, thisHold);
			await ourTurn;
			try {
				return await callback({ name });
			} finally {
				releaseThis();
				if (chains.get(name) === thisHold) chains.delete(name);
			}
		}
		return { request };
	}

	it('two tabs starting simultaneously under real navigator.locks semantics: exactly one operation-scoped transport call total', async () => {
		const locks = makeFakeLockManager();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(globalThis as any).navigator = { locks };

		const sharedEntryStorage = makeEntryStorage();
		const { outbox: tabA, coordinator: coordA } = await freshTabInstance();
		tabA._setStorageForTests(sharedEntryStorage);
		const { outbox: tabB, coordinator: coordB } = await freshTabInstance();
		tabB._setStorageForTests(sharedEntryStorage);

		tabA.startLeaderElection(MY_HASH, () => {});
		tabB.startLeaderElection(MY_HASH, () => {});

		const idA = await tabA.enqueue(message('a'), MY_HASH);
		const idB = await tabB.enqueue(message('b'), MY_HASH);

		const sentA: unknown[][] = [];
		const sentB: unknown[][] = [];
		const sendA = async (m: unknown[]) => { sentA.push(m); return { txids: [], results: [] }; };
		const sendB = async (m: unknown[]) => { sentB.push(m); return { txids: [], results: [] }; };

		const [resultA, resultB] = await Promise.allSettled([
			coordA.dispatchMutations(message('a'), sendA, idA),
			coordB.dispatchMutations(message('b'), sendB, idB),
		]);

		expect(sentA.length + sentB.length).toBe(1);
		const outcomes = [resultA, resultB];
		expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
	});

	it('HTTP already returned success, but markServerAccepted\'s durable write is still in flight: the lock stays held, so a second tab cannot replay or re-send the same entry (§ determinism 3)', async () => {
		const locks = makeFakeLockManager();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(globalThis as any).navigator = { locks };

		const sharedStorage = makeDelayableEntryStorage();
		const { outbox: tabA, coordinator: coordA } = await freshTabInstance();
		tabA._setStorageForTests(sharedStorage);
		tabA._setActiveSessionForTests(MY_HASH);
		const { outbox: tabB } = await freshTabInstance();
		tabB._setStorageForTests(sharedStorage);
		tabB._setActiveSessionForTests(MY_HASH);

		const outboxId = await tabA.enqueue(message('slow-accept'), MY_HASH);
		const sendSpy = vi.fn(async () => ({ txids: [], results: [] }));

		const releaseAccept = sharedStorage.armDelayOnNextSet();
		const dispatchPromise = coordA.dispatchMutations(message('slow-accept'), sendSpy, outboxId);

		await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));

		const sentB: unknown[][] = [];
		const resultB = await tabB.drainOutbox(MY_HASH, async (m) => { sentB.push(m as unknown[]); return {}; });
		expect(resultB.wasLeader).toBe(false);
		expect(sentB).toHaveLength(0);

		releaseAccept();
		await dispatchPromise;

		const resultBAfter = await tabB.drainOutbox(MY_HASH, async (m) => { sentB.push(m as unknown[]); return {}; });
		expect(resultBAfter.wasLeader).toBe(true);
		expect(sentB).toHaveLength(0);
		expect(sendSpy).toHaveBeenCalledTimes(1);
	});
});

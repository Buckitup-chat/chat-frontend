// Durable outbox for signed mutations.
//
// Storage and cross-tab leadership come from @tanstack/offline-transactions
// (IndexedDBAdapter, WebLocksLeader). Only the domain logic lives here — what an entry is,
// when it may be replayed, and what ends its life. The package's full
// OfflineExecutor is not used: it replays through a static collection
// registry, and dialog collections are created lazily per dialog_hash, so the
// executor could not resolve them after a reload. Our mutations don't need a
// collection to replay anyway — they are self-contained signed rows.
//
// Why replay-after-crash is safe: an entry is replaced by a durable accepted
// marker only after the server confirms it, so a crash between "accepted"
// and "marked" replays a write that already landed. The server answers with
// a unique-key conflict and the identity check (confirm.ts) proves the
// stored row carries our exact signature — reported as success, not as a
// duplicate.
// Why entries survive key custody: a mutation carries its own ML-DSA
// signature over the row content and never expires. Only the *request* needs
// a live key (auth challenge), which is why draining requires an unlocked
// account and entries are partitioned by the user that signed them.
//
// Why the queue is encrypted: several accounts can share one browser profile,
// and each must replay only its own writes. secureStore wraps the adapter, so
// an entry is readable only by the account that wrote it, and only while it
// is unlocked — another account's entries are opaque rather than mistaken
// for corrupt records and deleted. Hiding the envelope from the device owner
// is not the goal (metadata access control starts at the backend).
import { IndexedDBAdapter, WebLocksLeader } from '@tanstack/offline-transactions';
import { IngestError } from './ingest';
import { createSecureStore, type StringStore } from './secureStore';

const DB_NAME = 'buckitup-outbox';

const LOCK_NAME = 'buckitup-outbox-drain';
const SEND_LOCK_NAME = 'buckitup-outbox-send';

export interface OutboxEntry {
	id: string;
	/** The account that signed these mutations; only it may replay them. */
	userHash: string;
	relation: string;
	mutations: unknown[];
	createdAt: number;
	attempts: number;
	lastError: string | null;
	
	status?: 'pending' | 'server_accepted_pending_reconcile' | 'quarantined' | 'discarded' | 'accepted';
	quarantinedAt?: number;
	discardedAt?: number;
	acceptedAt?: number;
	serverAcceptedAt?: number;
	reconciledAt?: number;
	nextAttemptAt?: number;
	dependsOn?: string[];
	dependsOnDurableMarkers?: true;
	scope?: string;
	sourceIntentId?: string;
}

const DEPENDS_ON_DURABLE_MARKERS_FIELD = 'dependsOnDurableMarkers' as const;

/**
 * Entries are never silently dropped to make room — the oldest pending write
 * is usually the one the user cares about most. The cap catches a runaway
 * producer, and hitting it is reported, not absorbed.
 */
export const MAX_OUTBOX_ENTRIES = 1000;

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

const indexedDb = new IndexedDBAdapter(DB_NAME);

/**
 * Encrypted view: everything written from now on goes through this.
 *
 * The key module is imported lazily because it reaches into the vault, and the
 * vault pulls in the whole crypto stack — the send path must not depend on it
 * at import time.
 */
let storage: StringStore = createSecureStore(indexedDb, {
	getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
});
/**
 * Unencrypted view of the same records. Needed for exactly one thing: telling
 * an entry written before encryption apart from one belonging to a different
 * account, which are otherwise both "cannot read this".
 */
let plainStorage: StringStore = indexedDb;
let encrypted = true;

let leader: WebLocksLeader | null = null;
let leaderUserHash: string | null = null;
let onBecomeLeader: (() => void) | null = null;

export function isLeader(): boolean {
	if (leaderOverrideForTests !== null) return leaderOverrideForTests;
	if (!WebLocksLeader.isSupported()) return fallbackIsLeader;
	return leader?.isLeader() ?? true;
}

let leaderOverrideForTests: boolean | null = null;
export function _setLeaderForTests(value: boolean | null): void {
	leaderOverrideForTests = value;
}

export function _setActiveSessionForTests(userHash: string | null): void {
	leaderUserHash = userHash;
}

export function startLeaderElection(userHash: string, becomeLeader: () => void): void {
	if (leaderUserHash === userHash) {
		onBecomeLeader = becomeLeader;
		return;
	}
	stopLeaderElection();
	leaderUserHash = userHash;
	onBecomeLeader = becomeLeader;
	if (!WebLocksLeader.isSupported()) {
		const generation = sessionGeneration;
		void tryAcquireFallbackLease(userHash, generation).then((won) => {
			if (!won) return;
			if (generation === sessionGeneration) {
				onBecomeLeader?.();
				return;
			}
			void releaseFallbackLease(userHash, generation);
		});
		return;
	}
	leader = new WebLocksLeader(`${LOCK_NAME}:${userHash}`);
	leader.onLeadershipChange((becameLeader) => {
		if (becameLeader) onBecomeLeader?.();
	});
	void leader.requestLeadership();
}

export function stopLeaderElection(): void {
	leader?.releaseLeadership();
	leader = null;
	if (!WebLocksLeader.isSupported() && leaderUserHash && fallbackIsLeader) {
		const releasingUserHash = leaderUserHash;
		const releasingGeneration = sessionGeneration;
		void drainFallbackOperations(releasingUserHash).then(() => releaseFallbackLease(releasingUserHash, releasingGeneration));
	}
	leaderUserHash = null;
	onBecomeLeader = null;
	fallbackIsLeader = false;
	sessionGeneration++;
}

export function currentSessionUserHash(): string | null {
	return leaderUserHash;
}
let sessionGeneration = 0;

export interface SessionToken {
	userHash: string;
	generation: number;
}

export function currentSessionToken(): SessionToken | null {
	return leaderUserHash ? { userHash: leaderUserHash, generation: sessionGeneration } : null;
}

export function sameSessionToken(a: SessionToken | null, b: SessionToken | null): boolean {
	return !!a && !!b && a.userHash === b.userHash && a.generation === b.generation;
}

export class SessionFencedError extends Error {}

export interface FallbackLease {
	instanceId: string;
	expiresAt: number;
}

export interface AtomicLeaseStore {
	claim(userHash: string, candidate: FallbackLease, now: number): Promise<FallbackLease>;
	release(userHash: string, ownerId: string): Promise<void>;
}

const LEASE_DB_NAME = 'buckitup-outbox-leader-lease';
const LEASE_STORE_NAME = 'lease';
let leaseDbPromise: Promise<IDBDatabase> | null = null;

function openLeaseDb(): Promise<IDBDatabase> {
	if (!leaseDbPromise) {
		leaseDbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(LEASE_DB_NAME, 1);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(LEASE_STORE_NAME)) req.result.createObjectStore(LEASE_STORE_NAME);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}
	return leaseDbPromise;
}

const indexedDbLeaseStore: AtomicLeaseStore = {
	claim(userHash, candidate, now) {
		return openLeaseDb().then((db) => new Promise<FallbackLease>((resolve, reject) => {
			const tx = db.transaction(LEASE_STORE_NAME, 'readwrite');
			const store = tx.objectStore(LEASE_STORE_NAME);
			let winner: FallbackLease;
			const getReq = store.get(userHash);
			getReq.onsuccess = () => {
				const current = getReq.result as FallbackLease | undefined;
				winner = current && current.instanceId !== candidate.instanceId && current.expiresAt > now
					? current
					: candidate;
				store.put(winner, userHash);
			};
			tx.oncomplete = () => resolve(winner);
			tx.onabort = () => reject(tx.error ?? new Error('lease claim transaction aborted'));
			tx.onerror = () => reject(tx.error ?? new Error('lease claim transaction failed'));
		}));
	},
	release(userHash, ownerId) {
		return openLeaseDb().then((db) => new Promise<void>((resolve, reject) => {
			const tx = db.transaction(LEASE_STORE_NAME, 'readwrite');
			const store = tx.objectStore(LEASE_STORE_NAME);
			const getReq = store.get(userHash);
			getReq.onsuccess = () => {
				const current = getReq.result as FallbackLease | undefined;
				if (!current || current.instanceId !== ownerId) return;
				store.delete(userHash);
			};
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error ?? new Error('lease release transaction aborted'));
			tx.onerror = () => reject(tx.error ?? new Error('lease release transaction failed'));
		}));
	},
};

let atomicLeaseStoreOverride: AtomicLeaseStore | null = null;
export function _setAtomicLeaseStoreForTests(store: AtomicLeaseStore | null): void {
	atomicLeaseStoreOverride = store;
}

function currentAtomicLeaseStore(): AtomicLeaseStore | null {
	if (atomicLeaseStoreOverride) return atomicLeaseStoreOverride;
	return typeof indexedDB !== 'undefined' ? indexedDbLeaseStore : null;
}

const FALLBACK_LEASE_TTL_MS = 30_000;
const FALLBACK_LEASE_RENEW_INTERVAL_MS = Math.floor(FALLBACK_LEASE_TTL_MS / 3);
const fallbackInstanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function fallbackOwnerId(generation: number): string {
	return `${fallbackInstanceId}:${generation}`;
}

let fallbackIsLeader = false;

async function tryAcquireFallbackLease(userHash: string, generation: number, now: number = Date.now()): Promise<boolean> {
	const store = currentAtomicLeaseStore();
	let won: boolean;
	if (!store) {
		won = false;
	} else {
		try {
			const ownerId = fallbackOwnerId(generation);
			const candidate: FallbackLease = { instanceId: ownerId, expiresAt: now + FALLBACK_LEASE_TTL_MS };
			const result = await store.claim(userHash, candidate, now);
			won = result.instanceId === ownerId;
		} catch {
			won = false;
		}
	}
	if (generation === sessionGeneration) fallbackIsLeader = won;
	return won;
}

async function releaseFallbackLease(userHash: string, generation: number): Promise<void> {
	const store = currentAtomicLeaseStore();
	if (!store) return;
	try {
		await store.release(userHash, fallbackOwnerId(generation));
	} catch {
	}
}

const activeFallbackOperations = new Map<string, Set<Promise<unknown>>>();

function trackFallbackOperation(userHash: string, operation: Promise<unknown>): void {
	let ops = activeFallbackOperations.get(userHash);
	if (!ops) {
		ops = new Set();
		activeFallbackOperations.set(userHash, ops);
	}
	ops.add(operation);
	const forget = () => {
		ops!.delete(operation);
		if (ops!.size === 0) activeFallbackOperations.delete(userHash);
	};
	operation.then(forget, forget);
}

async function drainFallbackOperations(userHash: string): Promise<void> {
	const ops = activeFallbackOperations.get(userHash);
	if (!ops || ops.size === 0) return;
	await Promise.allSettled([...ops]);
}

export async function withAcquiredLeadership<T>(
	userHash: string,
	fn: () => Promise<T>
): Promise<{ acquired: true; result: T } | { acquired: false }> {
	if (leaderOverrideForTests !== null) {
		if (!leaderOverrideForTests) return { acquired: false };
		return { acquired: true, result: await fn() };
	}
	if (leaderUserHash !== userHash) return { acquired: false };
	if (WebLocksLeader.isSupported()) {
		return await navigator.locks.request(
			`${SEND_LOCK_NAME}:${userHash}`,
			{ ifAvailable: true },
			async (lock): Promise<{ acquired: true; result: T } | { acquired: false }> => {
				if (!lock) return { acquired: false };
				return { acquired: true, result: await fn() };
			}
		);
	}
	const generation = sessionGeneration;
	const won = await tryAcquireFallbackLease(userHash, generation);
	if (!won) return { acquired: false };
	if (generation !== sessionGeneration || (leaderUserHash !== null && leaderUserHash !== userHash)) {
		await releaseFallbackLease(userHash, generation);
		return { acquired: false };
	}
	let stopped = false;
	let renewTimer: ReturnType<typeof setTimeout> | null = null;
	const scheduleRenew = () => {
		renewTimer = setTimeout(() => {
			if (stopped) return;
			void tryAcquireFallbackLease(userHash, generation).then((stillOurs) => {
				if (stopped) return;
				if (!stillOurs) { stopped = true; return; }
				scheduleRenew();
			});
		}, FALLBACK_LEASE_RENEW_INTERVAL_MS);
	};
	scheduleRenew();
	let settleTracking!: () => void;
	const trackingPromise = new Promise<void>((resolve) => { settleTracking = resolve; });
	trackFallbackOperation(userHash, trackingPromise);
	let fnPromise: Promise<T>;
	try {
		fnPromise = fn();
	} catch (e) {
		settleTracking();
		stopped = true;
		if (renewTimer) clearTimeout(renewTimer);
		throw e;
	}
	fnPromise.then(settleTracking, settleTracking);
	try {
		const result = await fnPromise;
		return { acquired: true, result };
	} finally {
		stopped = true;
		if (renewTimer) clearTimeout(renewTimer);
	}
}

const WAKE_CHANNEL_NAME = 'buckitup-outbox-wake';
const wakeChannel: BroadcastChannel | null =
	typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(WAKE_CHANNEL_NAME) : null;
const localWakeListeners = new Set<(userHash: string) => void>();

const changeListeners = new Set<(userHash: string) => void>();

function notifyQueueChange(userHash: string): void {
	for (const handler of changeListeners) {
		try {
			handler(userHash);
		} catch (e) {
			console.warn('[outbox] onOutboxChange subscriber threw:', e);
		}
	}
}

function notifyOtherTabs(userHash: string): void {
	wakeChannel?.postMessage({ userHash });
}

function notifyLocalSubscribers(userHash: string): void {
	for (const handler of localWakeListeners) {
		try {
			handler(userHash);
		} catch (e) {
			console.warn('[outbox] onOutboxWake subscriber threw:', e);
		}
	}
}

function wakeRetry(userHash: string): void {
	notifyQueueChange(userHash);
	notifyLocalSubscribers(userHash);
	notifyOtherTabs(userHash);
}

export function onOutboxWake(handler: (userHash: string) => void): () => void {
	localWakeListeners.add(handler);
	const listener = (ev: MessageEvent<{ userHash: string }>) => {
		try {
			handler(ev.data.userHash);
		} catch (e) {
			console.warn('[outbox] onOutboxWake subscriber threw:', e);
		}
	};
	wakeChannel?.addEventListener('message', listener);
	return () => {
		localWakeListeners.delete(handler);
		wakeChannel?.removeEventListener('message', listener);
	};
}
const OUTCOME_CHANNEL_NAME = 'buckitup-outbox-outcome';
const outcomeChannel: BroadcastChannel | null =
	typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(OUTCOME_CHANNEL_NAME) : null;
const outcomeListeners = new Set<(userHash: string) => void>();

function notifyOutcomeChange(userHash: string): void {
	notifyQueueChange(userHash);
	for (const handler of outcomeListeners) {
		try {
			handler(userHash);
		} catch (e) {
			console.warn('[outbox] outcome subscriber threw:', e);
		}
	}
	outcomeChannel?.postMessage({ userHash });
}

function onOutcomeChange(handler: (userHash: string) => void): () => void {
	outcomeListeners.add(handler);
	const listener = (ev: MessageEvent<{ userHash: string }>) => {
		try {
			handler(ev.data.userHash);
		} catch (e) {
			console.warn('[outbox] outcome subscriber threw:', e);
		}
	};
	outcomeChannel?.addEventListener('message', listener);
	return () => {
		outcomeListeners.delete(handler);
		outcomeChannel?.removeEventListener('message', listener);
	};
}

export function onOutboxChange(handler: (userHash: string) => void): () => void {
	changeListeners.add(handler);
	const listener = (ev: MessageEvent<{ userHash: string }>) => {
		try {
			handler(ev.data.userHash);
		} catch (e) {
			console.warn('[outbox] onOutboxChange subscriber threw:', e);
		}
	};
	wakeChannel?.addEventListener('message', listener);
	outcomeChannel?.addEventListener('message', listener);
	return () => {
		changeListeners.delete(handler);
		wakeChannel?.removeEventListener('message', listener);
		outcomeChannel?.removeEventListener('message', listener);
	};
}

export type EntryOutcome =
	| { kind: 'accepted' }
	| { kind: 'rejected'; error: string }
	| { kind: 'discarded' };

const FAILSAFE_RECHECK_MS = 5_000;

export async function awaitEntryOutcome(id: string, userHash: string): Promise<EntryOutcome> {
	const immediate = await currentOutcome(id, userHash);
	if (immediate !== 'pending' && immediate !== 'unknown') return immediate;

	return new Promise<EntryOutcome>((resolve) => {
		let settled = false;
		const finish = (outcome: EntryOutcome) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			clearInterval(failsafeTimer);
			resolve(outcome);
		};
		const recheck = () => {
			if (settled) return;
			void currentOutcome(id, userHash).then((outcome) => {
				if (outcome !== 'pending' && outcome !== 'unknown') finish(outcome);
			});
		};
		const unsubscribe = onOutcomeChange((changedUserHash) => {
			if (changedUserHash === userHash) recheck();
		});
		const failsafeTimer = setInterval(recheck, FAILSAFE_RECHECK_MS);
		recheck(); // closes the window between the immediate check above and subscribing
	});
}

async function currentOutcome(id: string, userHash: string): Promise<EntryOutcome | 'pending' | 'unknown'> {
	const result = await readEntry(id);
	if (result.kind === 'missing' || result.kind === 'foreign' || result.kind === 'corrupt') return 'unknown';
	if (result.entry.userHash !== userHash) return 'unknown';
	if (result.entry.status === 'accepted' || result.entry.reconciledAt) return { kind: 'accepted' };
	if (result.entry.status === 'discarded') return { kind: 'discarded' };
	if (result.entry.status === 'quarantined') return { kind: 'rejected', error: result.entry.lastError ?? 'rejected by the server' };
	return 'pending';
}

export async function awaitServerAccepted(id: string, userHash: string): Promise<EntryOutcome> {
	const transportOutcome = async (): Promise<EntryOutcome | null> => {
		const outcome = await currentOutcome(id, userHash);
		if (outcome !== 'pending' && outcome !== 'unknown') return outcome;
		const result = await readEntry(id);
		const serverAccepted = result.kind === 'entry' && result.entry.userHash === userHash
			&& result.entry.status === 'server_accepted_pending_reconcile';
		return serverAccepted ? { kind: 'accepted' } : null;
	};

	const immediate = await transportOutcome();
	if (immediate) return immediate;

	return new Promise<EntryOutcome>((resolve) => {
		let settled = false;
		const recheck = () => {
			if (settled) return;
			void transportOutcome().then((outcome) => {
				if (!outcome || settled) return;
				settled = true;
				unsubscribe();
				clearInterval(failsafeTimer);
				resolve(outcome);
			});
		};
		const unsubscribe = onOutboxChange((changedUserHash) => {
			if (changedUserHash === userHash) recheck();
		});
		const failsafeTimer = setInterval(recheck, FAILSAFE_RECHECK_MS);
		recheck();
	});
}

/**
 * Test hook: swap the storage adapter (node has no IndexedDB).
 *
 * With one argument the queue behaves as unencrypted plain storage. Pass a
 * second adapter — the raw store behind the encrypted one — to exercise the
 * real encrypted path, including legacy migration.
 */
export function _setStorageForTests(adapter: StringStore, rawAdapter?: StringStore): void {
	storage = adapter;
	plainStorage = rawAdapter ?? adapter;
	encrypted = rawAdapter !== undefined;
}

let seq = 0;
// Distinguishes tabs: timestamp+seq alone collide when two tabs enqueue in
// the same millisecond (each tab counts its own seq from 0), and a collision
// is one tab's pending write silently overwriting another's.
const tabNonce = Math.random().toString(36).slice(2, 6).padStart(4, '0');
/** Sortable id: insertion order survives keys() returning in any order. */
const nextId = (): string =>
	`${Date.now().toString(36).padStart(9, '0')}-${(seq++).toString(36).padStart(4, '0')}-${tabNonce}`;

const relationOf = (mutations: unknown[]): string => {
	const first = mutations[0] as { syncMetadata?: { relation?: string } } | undefined;
	return first?.syncMetadata?.relation ?? 'unknown';
};

/**
 * Persist mutations before the send is attempted. Returns the entry id, or
 * null when storage is unavailable (private mode, or a locked vault leaving no
 * key to encrypt with) — the caller still sends, just without durability.
 * Losing durability is bad; refusing to run is worse. In practice the vault is
 * always unlocked here: these mutations were just signed with it.
 */
export interface EnqueueOptions {
	dependsOn?: string[];
	scope?: string;
	sourceIntentId?: string;
}

export async function enqueue(mutations: unknown[], userHash: string, opts: EnqueueOptions = {}): Promise<string | null> {
	if (!userHash) return null;
	try {
		const active = await activeEntryCount();
		if (active >= MAX_OUTBOX_ENTRIES) {
			console.error(
				`[outbox] ${active} active entries pending — refusing to queue more. ` +
				'The server has been unreachable for a long time, or a write is stuck.'
			);
			return null;
		}
		const entry: OutboxEntry = {
			id: nextId(),
			userHash,
			relation: relationOf(mutations),
			mutations,
			createdAt: Date.now(),
			attempts: 0,
			lastError: null,
			[DEPENDS_ON_DURABLE_MARKERS_FIELD]: true,
			...(opts.dependsOn?.length ? { dependsOn: opts.dependsOn } : {}),
			...(opts.scope ? { scope: opts.scope } : {}),
			...(opts.sourceIntentId ? { sourceIntentId: opts.sourceIntentId } : {}),
		};
		await storage.set(entry.id, JSON.stringify(entry));
		notifyOtherTabs(userHash);
		notifyQueueChange(userHash);
		return entry.id;
	} catch (e) {
		console.warn('[outbox] storage unavailable, write is not durable:', e);
		return null;
	}
}

export async function markServerAccepted(id: string | null): Promise<void> {
	if (!id) return;
	const result = await readEntry(id).catch(() => null);
	if (result?.kind !== 'entry') return;
	const entry = result.entry;
	if (entry.status === 'server_accepted_pending_reconcile' || entry.status === 'accepted') return;
	if (entry.status === 'quarantined' || entry.status === 'discarded') return; // defensive: never reachable on the success path
	entry.status = 'server_accepted_pending_reconcile';
	entry.serverAcceptedAt = Date.now();
	await storage.set(id, JSON.stringify(entry));
	notifyQueueChange(entry.userHash);
}

export async function markReconciled(id: string | null): Promise<void> {
	if (!id) return;
	const result = await readEntry(id).catch(() => null);
	if (result?.kind !== 'entry') return;
	const entry = result.entry;
	if (entry.status !== 'server_accepted_pending_reconcile') return;
	entry.reconciledAt = Date.now();
	await storage.set(id, JSON.stringify(entry));
	notifyOutcomeChange(entry.userHash);
}

export async function resolveEntry(id: string | null): Promise<void> {
	if (!id) return;
	const result = await readEntry(id).catch(() => null);
	if (result?.kind !== 'entry') return;
	const entry = result.entry;
	if (entry.status === 'server_accepted_pending_reconcile' && !entry.reconciledAt) {
		console.warn('[outbox] resolveEntry refused: reconciliation not yet durably complete (L17-10):', id);
		return;
	}
	const marker: OutboxEntry = {
		id: entry.id,
		userHash: entry.userHash,
		relation: entry.relation,
		mutations: [],
		createdAt: entry.createdAt,
		attempts: entry.attempts,
		lastError: null,
		status: 'accepted',
		acceptedAt: Date.now(),
		...(entry.sourceIntentId ? { sourceIntentId: entry.sourceIntentId } : {}),
	};
	try {
		await storage.set(id, JSON.stringify(marker));
	} catch (e) {
		console.warn('[outbox] could not durably record the terminal marker — reconciled state stays covered by reconciledAt (L17-10):', e);
		return;
	}
	notifyOutcomeChange(entry.userHash);
}

/**
 * Delivery failed. A permanent rejection quarantines the entry — kept with
 * its signed mutations and the server's verdict, out of the replay path, so
 * the user's action survives for diagnosis or an explicit retry (ADR §5:
 * user-visible mutations must not be silently deleted). Transient failures
 * stay pending with the attempt counted.
 */
export async function recordFailure(id: string | null, error: unknown): Promise<void> {
	if (!id) return;
	try {
		const result = await readEntry(id);
		if (result.kind !== 'entry') return;
		const entry = result.entry;
		if (entry.status === 'server_accepted_pending_reconcile' || entry.status === 'accepted' || entry.status === 'discarded') return;
		entry.attempts += 1;
		entry.lastError = error instanceof Error ? error.message : String(error);
		if (error instanceof IngestError && error.permanent) {
			entry.status = 'quarantined';
			entry.quarantinedAt = Date.now();
			console.warn(`[outbox] quarantined ${entry.relation} entry ${id}: ${entry.lastError}`);
		} else {
			// RETRYABLE_FAILURE carries the time of its next attempt (ADR §5),
			// persisted so a reload resumes the schedule instead of resetting
			// it. Exponential per entry, jittered so parallel clients spread.
			const backoff = Math.min(RETRY_BASE_MS * 2 ** (entry.attempts - 1), RETRY_MAX_MS);
			entry.nextAttemptAt = Date.now() + backoff + Math.floor(Math.random() * 1000);
		}
		await storage.set(id, JSON.stringify(entry));
		if (entry.status === 'quarantined') notifyOutcomeChange(entry.userHash);
		else notifyQueueChange(entry.userHash);
	} catch {
		/* diagnostics only — never let bookkeeping break the send path */
	}
}

type ReadResult =
	| { kind: 'entry'; entry: OutboxEntry; legacy: boolean }
	| { kind: 'missing' }
	/** Written by another account (or tampered with): unreadable, and not ours. */
	| { kind: 'foreign' }
	/** Readable but not a valid entry: nothing can ever replay it. */
	| { kind: 'corrupt' };

/**
 * Read one record, distinguishing the three ways it can fail.
 *
 * The distinction is the whole point: before encryption "cannot read this"
 * meant a corrupt record and the entry was deleted. Now it far more often means
 * "belongs to a different account", and deleting those would destroy another
 * user's pending writes — the exact data loss this queue exists to prevent.
 */
async function readEntry(key: string): Promise<ReadResult> {
	let stored: string | null;
	try {
		stored = await plainStorage.get(key);
	} catch {
		return { kind: 'foreign' };
	}
	if (stored === null) return { kind: 'missing' };

	// Encrypted records are base64, so a leading '{' can only be a record
	// written before the queue was encrypted.
	const legacy = encrypted && stored.startsWith('{');
	if (encrypted && !legacy) {
		try {
			stored = await storage.get(key);
		} catch {
			return { kind: 'foreign' };
		}
		if (stored === null) return { kind: 'missing' };
	}

	try {
		return { kind: 'entry', entry: JSON.parse(stored) as OutboxEntry, legacy };
	} catch {
		return { kind: 'corrupt' };
	}
}

async function activeEntryCount(): Promise<number> {
	const keys = await storage.keys();
	let active = 0;
	for (const key of keys) {
		const result = await readEntry(key);
		if (result.kind === 'entry' && (result.entry.status === 'discarded' || result.entry.status === 'accepted')) continue;
		active++;
	}
	return active;
}

/**
 * Upgrade a pre-encryption entry in place, the first time its owner sees it.
 * Entries of other accounts stay readable on disk until that account logs in —
 * we have no key to re-encrypt them with, and dropping them would lose writes.
 */
async function rewriteEncrypted(key: string, entry: OutboxEntry): Promise<void> {
	try {
		await storage.set(key, JSON.stringify(entry));
	} catch (e) {
		console.warn('[outbox] could not re-encrypt a legacy entry:', e);
	}
}

async function entriesOf(userHash: string): Promise<OutboxEntry[]> {
	const keys = await storage.keys();
	const entries: OutboxEntry[] = [];
	for (const key of keys) {
		const result = await readEntry(key);
		if (result.kind === 'corrupt') {
			await plainStorage.delete(key).catch(() => {});
			continue;
		}
		if (result.kind !== 'entry') continue;
		if (result.entry.userHash !== userHash) continue;
		if (result.legacy) await rewriteEncrypted(key, result.entry);
		entries.push(result.entry);
	}
	return entries.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function findEntryBySourceIntentId(
	userHash: string,
	sourceIntentId: string
): Promise<{ outboxId: string } | null> {
	const all = await entriesOf(userHash);
	const match = all.find((e) => e.sourceIntentId === sourceIntentId);
	return match ? { outboxId: match.id } : null;
}

export async function pendingEntries(userHash: string): Promise<OutboxEntry[]> {
	return (await entriesOf(userHash)).filter((e) => e.status !== 'quarantined' && e.status !== 'discarded' && e.status !== 'accepted');
}
export async function pendingReconciliation(userHash: string): Promise<OutboxEntry[]> {
	return (await entriesOf(userHash)).filter((e) => e.status === 'server_accepted_pending_reconcile');
}

export async function quarantinedEntries(userHash: string): Promise<OutboxEntry[]> {
	return (await entriesOf(userHash)).filter((e) => e.status === 'quarantined');
}

/**
 * Back into the replay path — the caller believes the state this write failed
 * against has changed. History (attempts, last verdict) stays on the entry.
 */
export async function requeueEntry(id: string): Promise<void> {
	const result = await readEntry(id);
	if (result.kind !== 'entry' || result.entry.status === 'discarded' || result.entry.status === 'accepted'
		|| result.entry.status === 'server_accepted_pending_reconcile') return;
	const entry = result.entry;
	entry.status = 'pending';
	delete entry.quarantinedAt;
	await storage.set(id, JSON.stringify(entry));
	wakeRetry(entry.userHash);
}


export async function discardEntry(id: string): Promise<void> {
	const result = await readEntry(id);
	if (result.kind !== 'entry' || result.entry.status === 'discarded' || result.entry.status === 'accepted'
		|| result.entry.status === 'server_accepted_pending_reconcile') return;
	const entry = result.entry;
	const marker: OutboxEntry = {
		id: entry.id,
		userHash: entry.userHash,
		relation: entry.relation,
		mutations: [],
		createdAt: entry.createdAt,
		attempts: entry.attempts,
		lastError: entry.lastError,
		status: 'discarded',
		discardedAt: Date.now(),
		...(entry.sourceIntentId ? { sourceIntentId: entry.sourceIntentId } : {}),
	};
	await storage.set(id, JSON.stringify(marker)).catch(() => {});
	notifyOutcomeChange(entry.userHash);
}

type DependencyState = 'resolved' | 'pending' | 'unresolvable';

const dependencyState = (dependent: OutboxEntry, depId: string, byId: Map<string, OutboxEntry>): DependencyState => {
	const dep = byId.get(depId);
	if (dep) return (dep.status === 'accepted' || dep.status === 'server_accepted_pending_reconcile') ? 'resolved' : 'pending';
	return dependent[DEPENDS_ON_DURABLE_MARKERS_FIELD] ? 'unresolvable' : 'resolved';
};

/**
 * Entries the coordinator may dispatch now (§7.3): pending, past their
 * scheduled attempt time, with every dependency resolved. A dependency that
 * is quarantined, discarded, still pending, or unresolvable (see
 * dependencyState) blocks its dependents — and only them; everything
 * unrelated stays ready. Order is creation order: a deterministic priority
 * among the ready, never a wait on the unready.
 */
export async function readyEntries(userHash: string, now: number = Date.now()): Promise<OutboxEntry[]> {
	const all = await entriesOf(userHash);
	const byId = new Map(all.map((e) => [e.id, e]));
	return all.filter((e) => {
		if (e.status === 'quarantined' || e.status === 'discarded' || e.status === 'accepted'
			|| e.status === 'server_accepted_pending_reconcile') return false;
		if ((e.nextAttemptAt ?? 0) > now) return false;
		return (e.dependsOn ?? []).every((dep) => dependencyState(e, dep, byId) === 'resolved');
	});
}

export function transitiveDependencyClosure(entries: OutboxEntry[], seedIds: string[]): Set<string> {
	const excluded = new Set(seedIds);
	let changed = true;
	while (changed) {
		changed = false;
		for (const e of entries) {
			if (excluded.has(e.id)) continue;
			if ((e.dependsOn ?? []).some((dep) => excluded.has(dep))) {
				excluded.add(e.id);
				changed = true;
			}
		}
	}
	return excluded;
}

/** Pending entries held back by an unresolved, quarantined, discarded, or
 * unresolvable (see dependencyState) dependency. */
export async function blockedEntries(userHash: string): Promise<OutboxEntry[]> {
	const all = await entriesOf(userHash);
	const byId = new Map(all.map((e) => [e.id, e]));
	return all.filter((e) =>
		e.status !== 'quarantined' && e.status !== 'discarded' && e.status !== 'accepted'
		&& e.status !== 'server_accepted_pending_reconcile' // L17-10: already past dispatch, never "blocked"
		&& (e.dependsOn ?? []).some((dep) => dependencyState(e, dep, byId) !== 'resolved'));
}

export interface BlockerSummary {
	id: string;
	relation: string;
	status: 'quarantined' | 'discarded' | 'unknown';
	lastError: string | null;
}

export interface BlockedDependentIssue {
	entry: { id: string; relation: string };
	blockers: BlockerSummary[];
}

export async function blockedDependentIssues(userHash: string): Promise<BlockedDependentIssue[]> {
	const all = await entriesOf(userHash);
	const byId = new Map(all.map((e) => [e.id, e]));
	const issues: BlockedDependentIssue[] = [];
	for (const e of all) {
		if (e.status === 'quarantined' || e.status === 'discarded' || e.status === 'accepted'
			|| e.status === 'server_accepted_pending_reconcile') continue;
		const blockers: BlockerSummary[] = [];
		for (const dep of e.dependsOn ?? []) {
			const state = dependencyState(e, dep, byId);
			if (state === 'resolved') continue;
			if (state === 'unresolvable') {
				blockers.push({ id: dep, relation: 'unknown', status: 'unknown', lastError: null });
				continue;
			}
			const blocker = byId.get(dep);
			if (!blocker || (blocker.status !== 'quarantined' && blocker.status !== 'discarded')) continue;
			blockers.push({ id: blocker.id, relation: blocker.relation, status: blocker.status, lastError: blocker.lastError });
		}
		if (blockers.length) issues.push({ entry: { id: e.id, relation: e.relation }, blockers });
	}
	return issues;
}

export async function pendingCount(userHash: string): Promise<number> {
	return (await pendingEntries(userHash)).length;
}

export interface DrainResult {
	sent: number;
	dropped: number;
	remaining: number;
	/** true when a transient failure stopped the drain (retry later). */
	stoppedEarly: boolean;
	/** false when another tab holds the drain lock. */
	wasLeader: boolean;
}

/**
 * Bounded parallelism for independent ready writes (v3 "Ordering of operations":
 * independent writes may dispatch concurrently, bounded, while dependent
 * chains stay serialized). Kept small and fixed rather than tuned for
 * throughput: browsers already cap same-origin connections around 6, and the
 * low end of the target range (Raspberry Pi / embedded WebView, see
 * CLAUDE.md) favors a conservative bound over maximizing parallel requests.
 * No proposal-mandated value exists; this is a deliberately conservative
 * constant, not a measured optimum.
 */
export const DRAIN_CONCURRENCY = 4;

/**
 * Entry ids with a network dispatch currently in flight — the ONE
 * authoritative ownership registry for "at most one active send per outbox
 * entry id, per tab", shared by every path that can issue that network
 * request:
 *
 *   - `drainOutbox`'s worker pool (below), for replay;
 *   - `dispatchMutations` (coordinator.ts), for the live leader-with-no-
 *     dependencies path that dispatches immediately instead of going
 *     through a drain.
 *
 * Module-level, not per-call, so the guard holds across separate
 * `drainOutbox` invocations (scheduler loops, wakeups, retries), across a
 * live send racing a concurrently triggered drain for the very same
 * freshly enqueued entry, and across a coordinator restart
 * (`stopDrainLoop`/`stopLeaderElection` do not clear it, so a new drain
 * chain still sees an older one's still-completing send as claimed).
 * `tryClaimOutboxEntry`/`releaseOutboxEntry` are the only way this set is
 * touched — never exposed directly — and every caller releases in a
 * `finally`, so an id can never be left claimed forever by an exception
 * path.
 */
const inFlightEntryIds = new Set<string>();

/**
 * Claims `id` for a network dispatch attempt. Returns true if the caller now
 * owns it — and must release with `releaseOutboxEntry`, in a `finally`, once
 * its attempt settles — or false if another path (the live send, or a drain
 * worker) already owns it right now. `null` (a mutation sent without a
 * durable outbox entry, e.g. best-effort durability) always "succeeds":
 * there is nothing to own, so it never blocks that caller.
 */
export function tryClaimOutboxEntry(id: string | null): boolean {
	if (id === null) return true;
	if (inFlightEntryIds.has(id)) return false;
	inFlightEntryIds.add(id);
	return true;
}

/** Releases a claim taken by `tryClaimOutboxEntry`. Idempotent, and a no-op
 * for `null` — safe to call unconditionally in a `finally`. */
export function releaseOutboxEntry(id: string | null): void {
	if (id === null) return;
	inFlightEntryIds.delete(id);
}

/** Test hook: in-flight claims are module state and must not leak between
 * test cases that reuse entry ids or share a module instance. */
export function _clearInFlightForTests(): void {
	inFlightEntryIds.clear();
}

/**
 * Replay pending writes for one account.
 *
 * A bounded pool of workers each repeatedly claim the next entry that is
 * ready (§7.3: past its scheduled attempt, every dependency resolved) and
 * not already claimed by another worker, dispatch it, and loop — so a
 * dependent that becomes ready only once its predecessor is accepted is
 * picked up as soon as a slot frees, without waiting for a separate drain
 * trigger. Readiness is recomputed from persisted state on every claim
 * (`readyEntries`, unchanged) rather than tracked separately here, so the
 * existing dependency graph — not a new heuristic — is what decides
 * eligibility. A transient failure only ever affects its own entry: unlike
 * the old single sequential pass, one worker's failure never stops the
 * other workers' entries from being tried in the same drain.
 *
 * Cross-tab: only the Web Locks leader drains, so two tabs never replay the
 * same entry concurrently.
 *
 * No delay before an attempt. A drain runs because something said conditions
 * changed — login, or the `online` event — and pacing the first replay would
 * only keep the user's message undelivered for seconds after the network came
 * back.
 */
async function reconcileStuckEntries(userHash: string, reconcile: (mutations: unknown[]) => Promise<void>): Promise<void> {
	for (const entry of await pendingReconciliation(userHash)) {
		try {
			await reconcile(entry.mutations);
			await markReconciled(entry.id);
			await resolveEntry(entry.id);
		} catch (e) {
			console.warn('[outbox] reconciliation still pending after server acceptance (L17-10):', entry.id, e);
		}
	}
}

export async function drainOutbox(
	userHash: string,
	send: (mutations: unknown[]) => Promise<unknown>,
	reconcile?: (mutations: unknown[], result?: unknown) => Promise<void>,
	isCurrent?: () => boolean,
): Promise<DrainResult> {
	if (reconcile) await reconcileStuckEntries(userHash, reconcile);

	const outcome = await withAcquiredLeadership(userHash, async () => {
		let sent = 0;
		let dropped = 0;
		let hadTransientFailure = false;

		const processEntry = async (entry: OutboxEntry): Promise<void> => {
			try {
				const result = await send(entry.mutations);
				await markServerAccepted(entry.id);
				sent++;

				if (!reconcile) {
					await markReconciled(entry.id);
					await resolveEntry(entry.id);
					return;
				}

				try {
					await reconcile(entry.mutations, result);
					await markReconciled(entry.id);
					await resolveEntry(entry.id);
				} catch (e) {
					console.warn('[outbox] reconciliation pending after server acceptance (L17-10):', entry.id, e);
				}
			} catch (e) {
				if (e instanceof IngestError && e.permanent) {
					// Out of the replay path but never silently gone: the entry
					// keeps its signed mutations and the server's verdict.
					await recordFailure(entry.id, e);
					dropped++;
					return;
				}
				await recordFailure(entry.id, e);
				hadTransientFailure = true;
			}
		};

		const worker = async (): Promise<void> => {
			for (;;) {
				if (isCurrent && !isCurrent()) return;
				const ready = await readyEntries(userHash);
				const next = ready.find((e) => !inFlightEntryIds.has(e.id));
				if (!next) return;
				if (!tryClaimOutboxEntry(next.id)) continue;
				try {
					await processEntry(next);
				} finally {
					releaseOutboxEntry(next.id);
				}
			}
		};

		await Promise.all(Array.from({ length: DRAIN_CONCURRENCY }, worker));
		return { sent, dropped, hadTransientFailure };
	});

	if (!outcome.acquired) {
		return { sent: 0, dropped: 0, remaining: await pendingCount(userHash), stoppedEarly: false, wasLeader: false };
	}
	return {
		sent: outcome.result.sent,
		dropped: outcome.result.dropped,
		remaining: await pendingCount(userHash),
		stoppedEarly: outcome.result.hadTransientFailure,
		wasLeader: true,
	};
}

// ---------- timed retry loop (ADR §5: RETRYABLE_FAILURE carries a time for
// the next attempt; relying only on login/'online' does not conform — a
// server can answer 5xx while connectivity never changes, and the queue
// would never move again) ----------

let loopTimer: ReturnType<typeof setTimeout> | null = null;
let loopFailures = 0;
let loopGeneration = 0;

const nextDelay = (): number => {
	const backoff = Math.min(RETRY_BASE_MS * 2 ** loopFailures, RETRY_MAX_MS);
	return backoff + Math.floor(Math.random() * 1_000); // jitter breaks tab lockstep
};

/**
 * Drains now, and keeps draining on its own timer until the queue is empty.
 *
 * External triggers (login, 'online') call this too — they reset the loop and
 * fire immediately, so a real connectivity change is never held hostage to a
 * backoff scheduled before it.
 */
export function ensureDrainLoop(
	userHash: string,
	send: (mutations: unknown[]) => Promise<unknown>,
	opts: { resetSchedules?: boolean; reconcile?: (mutations: unknown[], result?: unknown) => Promise<void> } = {},
): void {
	stopDrainLoop(); // also bumps loopGeneration, invalidating any in-flight chain from a previous call
	loopFailures = 0;
	const generation = loopGeneration;
	void (async () => {
		if (opts.resetSchedules) await clearSchedules(userHash);
		await runLoopOnce(userHash, send, opts.reconcile, generation);
	})();
}

/** An external trigger (login, 'online') invalidates backoffs computed
 * against the previous network conditions — entries become due now. */
async function clearSchedules(userHash: string): Promise<void> {
	try {
		for (const entry of await entriesOf(userHash)) {
			if (entry.status !== 'quarantined' && entry.status !== 'discarded' && entry.nextAttemptAt) {
				delete entry.nextAttemptAt;
				await storage.set(entry.id, JSON.stringify(entry));
			}
		}
	} catch { /* schedule reset is best-effort */ }
}

async function runLoopOnce(
	userHash: string,
	send: (mutations: unknown[]) => Promise<unknown>,
	reconcile: ((mutations: unknown[], result?: unknown) => Promise<void>) | undefined,
	generation: number,
): Promise<void> {
	let result: DrainResult;
	try {
		result = await drainOutbox(userHash, send, reconcile, () => generation === loopGeneration);
	} catch {
		result = { sent: 0, dropped: 0, remaining: 1, stoppedEarly: true, wasLeader: true };
	}

	if (generation !== loopGeneration) return;

	if (!result.wasLeader) {
		// Another tab is draining. Check back lazily: that tab may close with
		// entries still queued, and someone has to pick them up.
		loopTimer = setTimeout(() => void runLoopOnce(userHash, send, reconcile, generation), 30_000);
		return;
	}
	if (result.remaining === 0) {
		loopFailures = 0;
		return; // queue is empty — the next external trigger restarts the loop
	}
	loopFailures = result.stoppedEarly ? loopFailures + 1 : 0;
	// Sleep until the earliest scheduled attempt if that comes sooner than the
	// loop's own backoff — per-entry schedules are the authority (ADR §5).
	let delay = nextDelay();
	try {
		const soonest = (await entriesOf(userHash))
			.filter((e) => e.status !== 'quarantined' && e.status !== 'discarded' && e.nextAttemptAt)
			.reduce<number | null>((min, e) => (min === null || e.nextAttemptAt! < min ? e.nextAttemptAt! : min), null);
		if (soonest !== null) delay = Math.min(delay, Math.max(soonest - Date.now(), 250));
	} catch { /* pacing fallback is the loop backoff */ }
	if (generation !== loopGeneration) return; // re-checked: the entriesOf scan above awaited too
	loopTimer = setTimeout(() => void runLoopOnce(userHash, send, reconcile, generation), delay);
}

/** Call on logout: another account's entries are not this session's to send. */
export function stopDrainLoop(): void {
	loopGeneration++;
	if (loopTimer) {
		clearTimeout(loopTimer);
		loopTimer = null;
	}
}

/** Test helper: wipe the queue. */
export async function _clearOutboxForTests(): Promise<void> {
	await storage.clear().catch(() => {});
}

/* v8 ignore next -- type-only re-export for the test hook */
export type OutboxStorage = typeof storage;

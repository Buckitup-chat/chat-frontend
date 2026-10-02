// Durable outbox for signed mutations.
//
// Storage is the strict IndexedDbStore; cross-tab leadership comes from
// @tanstack/offline-transactions (WebLocksLeader). Only the domain logic lives here — what an entry is,
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
import { WebLocksLeader } from '@tanstack/offline-transactions';
import { IndexedDbStore } from './indexedDbStore';
import { IngestError } from './ingest';
import { VaultLockedError, AccountMismatchError } from './keyCustody';
import { createSecureStore, DecryptFailedError, type StringStore } from './secureStore';

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
	/** The last attempt got no answer at all (IngestError.network): its backoff ends the moment any write is answered. */
	lastErrorNetwork?: true;
	dependsOn?: string[];
	dependsOnDurableMarkers?: true;
	scope?: string;
	sourceIntentId?: string;
	discoveryBlocked?: DependencyDiscoveryBlock;
}

export type DependencyBlockReason =
	| 'storage_unavailable'
	| 'corrupt_record'
	| 'discovery_error'
	/** The queue could not even be listed: which records existed before this entry is unknown. */
	| 'boundary_unknown'
	/** A record inside the boundary is no longer stored: what it was cannot be known. */
	| 'record_missing'
	/** Admission: the write was built on a base the server has not confirmed (StaleBaseError). */
	| 'stale_base';

export type DependencyBlockKind = 'discovery' | 'admission';

export interface DependencyDiscoveryBlock {
	kind: DependencyBlockKind;
	reason: DependencyBlockReason;
	message: string;
	blockedAt: number;
	attempts: number;
	observedKeys: string[] | null;
	admission?: { scope: string; generation: number | null };
}

const DEPENDENCY_BLOCK_MESSAGES: Record<DependencyBlockReason, string> = {
	storage_unavailable: 'a queued write it may depend on could not be read from storage',
	corrupt_record: 'a queued write it may depend on is corrupt — discard that write to continue',
	discovery_error: 'its dependencies could not be determined',
	boundary_unknown: 'it was queued while storage could not be listed — discard it and send it again',
	record_missing: 'a queued write it may depend on is no longer stored — discard it and send it again',
	stale_base: 'it was built on data the server has not confirmed yet — it waits until that data is confirmed',
};

export class DependencyDiscoveryError extends Error {
	constructor(
		public readonly reason: DependencyBlockReason,
		public readonly observedKeys: string[] | null = null,
	) {
		super(`dependency discovery failed: ${reason}`);
		this.name = 'DependencyDiscoveryError';
	}
}

export function dependencyBlockFor(
	error: unknown,
	boundary: { kind: DependencyBlockKind; observedKeys: string[] | null; admission?: DependencyDiscoveryBlock['admission'] },
): DependencyDiscoveryBlock {
	let reason: DependencyBlockReason;
	if (boundary.observedKeys === null) reason = 'boundary_unknown';
	else if (error instanceof DependencyDiscoveryError) reason = error.reason;
	else if (error instanceof DecryptFailedError) reason = 'storage_unavailable';
	else if (boundary.kind === 'admission' && error === null) reason = 'stale_base';
	else reason = 'discovery_error';
	return {
		kind: boundary.kind,
		reason,
		message: DEPENDENCY_BLOCK_MESSAGES[reason],
		blockedAt: Date.now(),
		attempts: 0,
		observedKeys: boundary.observedKeys,
		...(boundary.admission ? { admission: boundary.admission } : {}),
	};
}

export type DiscoveryOutcome =
	| { kind: 'found'; dependsOn: string[] }
	| { kind: 'blocked'; block: DependencyDiscoveryBlock };

const DEPENDS_ON_DURABLE_MARKERS_FIELD = 'dependsOnDurableMarkers' as const;

/**
 * Entries are never silently dropped to make room — the oldest pending write
 * is usually the one the user cares about most. The cap catches a runaway
 * producer, and hitting it is reported, not absorbed.
 */
export const MAX_OUTBOX_ENTRIES = 1000;

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
// A missing connection is probed more often than a failing server is retried:
// the probe costs the server nothing, and it is how a reconnection nobody
// announced (no `online` event, as behind an always-on VPN) gets noticed.
const RETRY_NETWORK_MAX_MS = 30_000;

const indexedDb = new IndexedDbStore(DB_NAME);

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

let sealFor: (owner: string) => StringStore = (owner) => createSecureStore(indexedDb, {
	getKey: async () => (await import('./localCrypto')).getLocalStorageKeyFor(owner),
});

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
	fenceAttemptWaiters();
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

/**
 * Run `fn` holding the account's send lock. By default a held lock means
 * "someone else is sending" and the call gives up at once. `wait` queues for
 * the lock instead: the leader tab's drain uses it, because there the holder
 * is this tab's own live send, and giving up would leave everything queued
 * behind that send for the non-leader poll interval.
 */
export async function withAcquiredLeadership<T>(
	userHash: string,
	fn: () => Promise<T>,
	opts: { wait?: boolean } = {}
): Promise<{ acquired: true; result: T } | { acquired: false }> {
	if (leaderOverrideForTests !== null) {
		if (!leaderOverrideForTests) return { acquired: false };
		return { acquired: true, result: await fn() };
	}
	if (leaderUserHash !== userHash) return { acquired: false };
	if (WebLocksLeader.isSupported()) {
		return await navigator.locks.request(
			`${SEND_LOCK_NAME}:${userHash}`,
			opts.wait ? {} : { ifAvailable: true },
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
	if (result.kind !== 'entry') return 'unknown';
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
export function _setStorageForTests(adapter: StringStore, rawAdapter?: StringStore, opts: { sealFor?: (owner: string) => StringStore } = {}): void {
	storage = adapter;
	plainStorage = rawAdapter ?? adapter;
	encrypted = rawAdapter !== undefined;
	sealFor = opts.sealFor ?? (() => adapter);
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
	discoveryBlocked?: DependencyDiscoveryBlock;
	observeAttempt?: boolean;
}

export async function enqueue(mutations: unknown[], userHash: string, opts: EnqueueOptions = {}): Promise<string | null> {
	if (!userHash) return null;
	try {
		const active = await activeEntryCount(userHash);
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
			...(opts.discoveryBlocked ? { discoveryBlocked: opts.discoveryBlocked } : {}),
		};
		if (entry.discoveryBlocked) delete entry.dependsOn;
		if (opts.observeAttempt) preRegisteredAttempts.set(entry.id, observeAttempt(userHash, entry.id));
		try {
			await writeOwner(entry.id, userHash);
			try {
				await sealFor(entry.userHash).set(entry.id, JSON.stringify(entry));
			} catch (e) {
				await plainStorage.delete(ownerKeyFor(entry.id)).catch(() => {});
				throw e;
			}
		} catch (e) {
			if (preRegisteredAttempts.delete(entry.id)) settleAttempt(entry.id, { kind: 'deferred' });
			throw e;
		}
		notifyOtherTabs(userHash);
		notifyQueueChange(userHash);
		return entry.id;
	} catch (e) {
		console.warn('[outbox] storage unavailable, write is not durable:', e);
		return null;
	}
}

export async function markServerAccepted(id: string | null): Promise<boolean> {
	if (!id) return false;
	const result = await readEntry(id).catch(() => null);
	if (result?.kind !== 'entry') return false;
	const entry = result.entry;
	if (entry.status === 'server_accepted_pending_reconcile' || entry.status === 'accepted') return true;
	if (entry.status === 'quarantined' || entry.status === 'discarded') return false; // defensive: never reachable on the success path
	entry.status = 'server_accepted_pending_reconcile';
	entry.serverAcceptedAt = Date.now();
	delete entry.nextAttemptAt;
	delete entry.discoveryBlocked;
	await sealFor(entry.userHash).set(id, JSON.stringify(entry));
	notifyOutcomeChange(entry.userHash);
	return true;
}

export async function markReconciled(id: string | null): Promise<void> {
	if (!id) return;
	const result = await readEntry(id).catch(() => null);
	if (result?.kind !== 'entry') return;
	const entry = result.entry;
	if (entry.status !== 'server_accepted_pending_reconcile') return;
	entry.reconciledAt = Date.now();
	await sealFor(entry.userHash).set(id, JSON.stringify(entry));
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
		await sealFor(marker.userHash).set(id, JSON.stringify(marker));
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
		const network = error instanceof IngestError && error.network;
		if (network) entry.lastErrorNetwork = true;
		else delete entry.lastErrorNetwork;
		if (error instanceof IngestError && error.permanent) {
			entry.status = 'quarantined';
			entry.quarantinedAt = Date.now();
			delete entry.nextAttemptAt;
			delete entry.discoveryBlocked;
			console.warn(`[outbox] quarantined ${entry.relation} entry ${id}: ${entry.lastError}`);
		} else if (entry.status !== 'quarantined') {
			// RETRYABLE_FAILURE carries the time of its next attempt (ADR §5),
			// persisted so a reload resumes the schedule instead of resetting
			// it. Exponential per entry, jittered so parallel clients spread.
			const backoff = Math.min(RETRY_BASE_MS * 2 ** (entry.attempts - 1), network ? RETRY_NETWORK_MAX_MS : RETRY_MAX_MS);
			entry.nextAttemptAt = Date.now() + backoff + Math.floor(Math.random() * 1000);
		}
		await sealFor(entry.userHash).set(id, JSON.stringify(entry));
		if (entry.status === 'quarantined') notifyOutcomeChange(entry.userHash);
		else notifyQueueChange(entry.userHash);
	} catch {
		/* diagnostics only — never let bookkeeping break the send path */
	}
}

export type CorruptRecordFailure = 'undecodable' | 'invalid_entry' | 'undecryptable';

type ReadResult =
	| { kind: 'entry'; entry: OutboxEntry; legacy: boolean }
	| { kind: 'missing' }
	/** The read itself failed (storage error, locked vault): nothing is known about the record. */
	| { kind: 'unavailable' }
	/** Stored, but this account's key cannot decrypt it: another account's entry, or damaged ciphertext. */
	| { kind: 'foreign'; raw: string }
	/** Readable but not a valid entry: nothing can ever replay it. */
	| {
		kind: 'corrupt';
		raw: string;
		failure: Exclude<CorruptRecordFailure, 'undecryptable'>;
		message: string;
		decrypted: boolean;
	};

const ENTRY_STATUSES = new Set(['pending', 'server_accepted_pending_reconcile', 'quarantined', 'discarded', 'accepted']);
const TERMINAL_STATUSES = new Set(['accepted', 'discarded']);
const OPTIONAL_TIMESTAMPS = ['quarantinedAt', 'discardedAt', 'acceptedAt', 'serverAcceptedAt', 'reconciledAt', 'nextAttemptAt'] as const;
type LifecycleTimestamp = typeof OPTIONAL_TIMESTAMPS[number];

const LIFECYCLE: Record<string, { requires?: LifecycleTimestamp; allows: LifecycleTimestamp[] }> = {
	pending: { allows: ['nextAttemptAt'] },
	quarantined: { requires: 'quarantinedAt', allows: ['quarantinedAt'] },
	server_accepted_pending_reconcile: { requires: 'serverAcceptedAt', allows: ['serverAcceptedAt', 'reconciledAt'] },
	accepted: { requires: 'acceptedAt', allows: ['acceptedAt'] },
	discarded: { requires: 'discardedAt', allows: ['discardedAt'] },
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTimestamp = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);

function invalidMutationReason(value: unknown): string | null {
	if (!isPlainObject(value)) return 'is not an object';
	if (value.type !== 'insert' && value.type !== 'update' && value.type !== 'delete') return 'has no valid operation type';
	if (!isPlainObject(value.syncMetadata) || !isNonEmptyString(value.syncMetadata.relation)) return 'has no syncMetadata.relation';
	if (value.type === 'insert' && !isPlainObject(value.modified)) return 'is an insert without a modified row';
	if (value.type === 'update' && !(isPlainObject(value.original) && isPlainObject(value.changes))) return 'is an update without original and changes';
	if (value.type === 'delete' && !isPlainObject(value.original)) return 'is a delete without an original row';
	return null;
}

function invalidEntryReason(value: unknown, key: string): string | null {
	if (!isPlainObject(value)) return 'not an object';
	const e = value;
	if (e.id !== key) return 'id does not match its storage key';
	if (!isNonEmptyString(e.userHash)) return 'userHash is missing';
	if (!isNonEmptyString(e.relation)) return 'relation is missing';
	if (!Array.isArray(e.mutations)) return 'mutations is not a list';
	if (!isTimestamp(e.createdAt)) return 'createdAt is not a number';
	if (!(Number.isInteger(e.attempts) && (e.attempts as number) >= 0)) return 'attempts is not a non-negative integer';
	if (e.lastError !== null && typeof e.lastError !== 'string') return 'lastError is not a string';
	if (e.status !== undefined && !ENTRY_STATUSES.has(e.status as string)) return 'status is unknown';
	for (const field of OPTIONAL_TIMESTAMPS) {
		if (e[field] !== undefined && !isTimestamp(e[field])) return `${field} is not a number`;
	}
	const status = (e.status as string | undefined) ?? 'pending';
	const lifecycle = LIFECYCLE[status];
	if (lifecycle.requires && e[lifecycle.requires] === undefined) return `status ${status} has no ${lifecycle.requires}`;
	for (const field of OPTIONAL_TIMESTAMPS) {
		if (e[field] !== undefined && !lifecycle.allows.includes(field)) return `status ${status} cannot carry ${field}`;
	}
	if (e.dependsOn !== undefined && !(Array.isArray(e.dependsOn) && e.dependsOn.every(isNonEmptyString))) {
		return 'dependsOn is not a list of ids';
	}
	if (e[DEPENDS_ON_DURABLE_MARKERS_FIELD] !== undefined && e[DEPENDS_ON_DURABLE_MARKERS_FIELD] !== true) {
		return `${DEPENDS_ON_DURABLE_MARKERS_FIELD} is not true`;
	}
	if (e.scope !== undefined && typeof e.scope !== 'string') return 'scope is not a string';
	if (e.discoveryBlocked !== undefined) {
		const reason = discoveryBlockProblem(e.discoveryBlocked);
		if (reason) return `discoveryBlocked ${reason}`;
		if (status !== 'pending') return `status ${status} cannot carry discoveryBlocked`;
		if (e.dependsOn !== undefined) return 'discoveryBlocked cannot carry dependsOn';
	}
	if (e.sourceIntentId !== undefined && !isNonEmptyString(e.sourceIntentId)) return 'sourceIntentId is not an id';
	if (TERMINAL_STATUSES.has(status) && e.mutations.length > 0) return `status ${status} still carries mutations`;
	if (!TERMINAL_STATUSES.has(status) && e.mutations.length === 0) return 'mutations is empty';
	for (let i = 0; i < e.mutations.length; i++) {
		const reason = invalidMutationReason(e.mutations[i]);
		if (reason) return `mutation ${i} ${reason}`;
	}
	return null;
}

function discoveryBlockProblem(block: unknown): string | null {
	if (!isPlainObject(block)) return 'is malformed';
	const reason = block.reason as string;
	if (typeof reason !== 'string' || !Object.hasOwn(DEPENDENCY_BLOCK_MESSAGES, reason)) return 'is malformed';
	if (block.message !== DEPENDENCY_BLOCK_MESSAGES[reason as DependencyBlockReason]) return 'is malformed';
	if (!isTimestamp(block.blockedAt) || !(Number.isInteger(block.attempts) && (block.attempts as number) >= 0)) return 'is malformed';
	if (block.kind !== 'discovery' && block.kind !== 'admission') return 'has no valid kind';
	if (reason === 'stale_base' && block.kind !== 'admission') return 'reports a stale base without admission kind';
	const keys = block.observedKeys;
	if (keys !== null && !(Array.isArray(keys) && keys.every(isNonEmptyString))) return 'has malformed observedKeys';
	if ((keys === null) !== (reason === 'boundary_unknown')) return 'has a boundary that contradicts its reason';
	const admission = block.admission;
	if (block.kind === 'admission') {
		if (!isPlainObject(admission) || !isNonEmptyString(admission.scope)
			|| !(admission.generation === null || (Number.isInteger(admission.generation) && (admission.generation as number) >= 0))) {
			return 'has no admission scope';
		}
	} else if (admission !== undefined) {
		return 'carries an admission scope without admission kind';
	}
	return null;
}

/**
 * Read one record, distinguishing the ways it can fail.
 *
 * The distinction is the whole point: before encryption "cannot read this"
 * meant a corrupt record. Now it far more often means "belongs to a different
 * account", and treating those as corrupt would destroy another user's
 * pending writes — the exact data loss this queue exists to prevent.
 */
async function readEntry(key: string): Promise<ReadResult> {
	let raw: string | null;
	try {
		raw = await plainStorage.get(key);
	} catch {
		return { kind: 'unavailable' };
	}
	if (raw === null) return { kind: 'missing' };

	// Encrypted records are base64, so a leading '{' can only be a record
	// written before the queue was encrypted.
	const legacy = encrypted && raw.startsWith('{');
	const decrypted = encrypted && !legacy;
	let text = raw;
	if (decrypted) {
		let plain: string | null;
		try {
			plain = await storage.get(key);
		} catch (e) {
			return e instanceof DecryptFailedError ? { kind: 'foreign', raw } : { kind: 'unavailable' };
		}
		if (plain === null) return { kind: 'missing' };
		text = plain;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: 'corrupt', raw, failure: 'undecodable', message: 'stored value is not valid JSON', decrypted };
	}
	const invalid = invalidEntryReason(parsed, key);
	if (invalid) {
		return { kind: 'corrupt', raw, failure: 'invalid_entry', message: `decoded value is not a valid outbox entry: ${invalid}`, decrypted };
	}
	return { kind: 'entry', entry: parsed as OutboxEntry, legacy };
}

const OWNER_KEY_PREFIX = 'owner|';
const ownerKeyFor = (id: string): string => OWNER_KEY_PREFIX + id;

type OwnerProof = { kind: 'none' } | { kind: 'owner'; userHash: string } | { kind: 'other' } | { kind: 'unavailable' };

async function readOwner(id: string): Promise<OwnerProof> {
	let text: string | null;
	try {
		text = await plainStorage.get(ownerKeyFor(id));
		if (text !== null && encrypted) text = await storage.get(ownerKeyFor(id));
	} catch (e) {
		return e instanceof DecryptFailedError ? { kind: 'other' } : { kind: 'unavailable' };
	}
	if (text === null) return { kind: 'none' };
	try {
		const { userHash } = JSON.parse(text) as { userHash?: unknown };
		return isNonEmptyString(userHash) ? { kind: 'owner', userHash } : { kind: 'none' };
	} catch {
		return { kind: 'none' };
	}
}

const writeOwner = (id: string, userHash: string): Promise<void> => sealFor(userHash).set(ownerKeyFor(id), JSON.stringify({ userHash }));

type CorruptOwnership =
	| { kind: 'owned'; ownerHash: string }
	/** Proven to be another account's: it stays out of this account's view. */
	| { kind: 'other' }
	| { kind: 'unavailable' }
	/** No usable proof: a device-level record. */
	| { kind: 'unknown' };

/**
 * Who a corrupt record is proven to belong to. A userHash inside the damaged
 * payload is never evidence — anyone can write one. Proof is decryption with
 * the current account's key, or an owner record. `userHash` null asks from no
 * account's point of view (device diagnostics).
 */
async function corruptOwnership(key: string, decrypted: boolean, userHash: string | null): Promise<CorruptOwnership> {
	if (decrypted) return userHash ? { kind: 'owned', ownerHash: userHash } : { kind: 'other' };
	const owner = await readOwner(key);
	if (owner.kind === 'owner') return owner.userHash === userHash ? { kind: 'owned', ownerHash: owner.userHash } : { kind: 'other' };
	if (owner.kind === 'other') return { kind: 'other' };
	if (owner.kind === 'unavailable') return { kind: 'unavailable' };
	return { kind: 'unknown' };
}

const QUARANTINE_KEY_PREFIX = 'quarantine|';
const quarantineKeyFor = (key: string): string => QUARANTINE_KEY_PREFIX + key;
const isSidecarKey = (key: string): boolean =>
	key.startsWith(QUARANTINE_KEY_PREFIX) || key.startsWith(OWNER_KEY_PREFIX) || key.startsWith(CONFIRMATION_KEY_PREFIX)
	|| key.startsWith(CARD_CLOCK_KEY_PREFIX);

const CARD_CLOCK_KEY_PREFIX = 'clock|user_cards|';
const cardClockKeyFor = (userHash: string): string => CARD_CLOCK_KEY_PREFIX + userHash;

export async function readCardClock(userHash: string): Promise<number> {
	const key = cardClockKeyFor(userHash);
	const raw = await plainStorage.get(key);
	if (raw === null) return 0;
	const text = encrypted ? await storage.get(key) : raw;
	if (text === null) return 0;
	const { highWater } = JSON.parse(text) as { highWater?: unknown };
	if (!(Number.isInteger(highWater) && (highWater as number) >= 0)) throw new Error('card clock record is malformed');
	return highWater as number;
}

export async function writeCardClock(userHash: string, timestamp: number): Promise<void> {
	await sealFor(userHash).set(cardClockKeyFor(userHash), JSON.stringify({ highWater: timestamp }));
}

export function withAccountLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
	return withRecordLock(`account|${name}`, fn);
}

const CONFIRMATION_KEY_PREFIX = 'confirm|';
const confirmationKeyFor = (scope: string): string => CONFIRMATION_KEY_PREFIX + scope;

export async function scopeConfirmationGeneration(scope: string): Promise<number> {
	const raw = await plainStorage.get(confirmationKeyFor(scope));
	if (raw === null) return 0;
	const { generation } = JSON.parse(raw) as { generation?: unknown };
	if (!(Number.isInteger(generation) && (generation as number) >= 0)) throw new Error('confirmation record is malformed');
	return generation as number;
}

export async function recordScopeConfirmed(scope: string): Promise<void> {
	await withRecordLock(confirmationKeyFor(scope), async () => {
		const next = (await scopeConfirmationGeneration(scope)) + 1;
		await plainStorage.set(confirmationKeyFor(scope), JSON.stringify({ generation: next }));
	});
}

export interface CorruptOutboxRecord {
	key: string;
	ownerHash: string | null;
	failure: CorruptRecordFailure;
	message: string;
	detectedAt: number;
	rawSha256: string;
}

export interface CorruptOutboxRecordView extends CorruptOutboxRecord {
	raw: string;
}

const sha256Hex = async (value: string): Promise<string> => {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

async function readQuarantine(key: string): Promise<CorruptOutboxRecord | null | 'unreadable'> {
	const raw = await plainStorage.get(quarantineKeyFor(key));
	if (raw === null) return null;
	let text: string | null = raw;
	if (encrypted && !raw.startsWith('{')) {
		try {
			text = await storage.get(quarantineKeyFor(key));
		} catch {
			return 'unreadable';
		}
		if (text === null) return null;
	}
	try {
		return JSON.parse(text) as CorruptOutboxRecord;
	} catch {
		return 'unreadable';
	}
}

type CorruptFinding = Omit<CorruptOutboxRecord, 'detectedAt' | 'rawSha256'> & { raw: string };

const quarantineInFlight = new Map<string, Promise<CorruptOutboxRecordView>>();

const recordLockTails = new Map<string, Promise<void>>();

function withRecordLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = recordLockTails.get(key) ?? Promise.resolve();
	const run = previous.then(() => {
		const locks = (globalThis as { navigator?: Navigator }).navigator?.locks;
		return locks ? locks.request(`buckitup-outbox-quarantine:${key}`, fn) : fn();
	});
	const tail = run.then(() => {}, () => {});
	recordLockTails.set(key, tail);
	void tail.then(() => {
		if (recordLockTails.get(key) === tail) recordLockTails.delete(key);
	});
	return run;
}

function quarantineCorrupt(found: CorruptFinding, sealed: boolean): Promise<CorruptOutboxRecordView> {
	const inFlight = quarantineInFlight.get(found.key);
	if (inFlight) return inFlight;
	const op = withRecordLock(found.key, () => recordQuarantine(found, sealed))
		.finally(() => quarantineInFlight.delete(found.key));
	quarantineInFlight.set(found.key, op);
	return op;
}

async function recordQuarantine(found: CorruptFinding, sealed: boolean): Promise<CorruptOutboxRecordView> {
	const { raw, ...rest } = found;
	const record: CorruptOutboxRecord = { ...rest, detectedAt: Date.now(), rawSha256: '' };
	try {
		record.rawSha256 = await sha256Hex(raw);
		const existing = await readQuarantine(found.key);
		if (existing === 'unreadable') return { ...record, raw };
		if (existing && existing.rawSha256 === record.rawSha256) {
			if (existing.ownerHash === record.ownerHash) return { ...existing, raw };
			record.detectedAt = existing.detectedAt;
		}
		await (sealed ? storage : plainStorage).set(quarantineKeyFor(found.key), JSON.stringify(record));
		console.warn(`[outbox] quarantined corrupt record ${found.key} (${found.failure}): ${found.message}`);
		if (record.ownerHash) notifyQueueChange(record.ownerHash);
	} catch (e) {
		console.warn(`[outbox] corrupt record ${found.key} is retained, but its quarantine metadata could not be written:`, e);
	}
	return { ...record, raw };
}

const UNDECRYPTABLE_MESSAGE = 'stored ciphertext cannot be decrypted with this account\'s key';
const UNAVAILABLE_MESSAGE = 'stored record could not be read: storage unavailable';

interface OutboxScan {
	entries: OutboxEntry[];
	corrupt: Map<string, CorruptOutboxRecordView>;
	unavailable: Set<string>;
	otherAccount: Set<string>;
	missing: Set<string>;
}

async function scanOutbox(userHash: string, boundary?: readonly string[]): Promise<OutboxScan> {
	const keys = boundary ?? await storage.keys();
	const entries: OutboxEntry[] = [];
	const corrupt = new Map<string, CorruptOutboxRecordView>();
	const unavailable = new Set<string>();
	const otherAccount = new Set<string>();
	const missing = new Set<string>();
	const unattributed = new Map<string, string>();
	for (const key of keys) {
		if (isSidecarKey(key)) continue;
		const result = await readEntry(key);
		if (result.kind === 'unavailable') {
			unavailable.add(key);
			continue;
		}
		if (result.kind === 'missing') {
			missing.add(key);
			continue;
		}
		if (result.kind === 'corrupt') {
			const ownership = await corruptOwnership(key, result.decrypted, userHash);
			if (ownership.kind === 'unavailable') {
				unavailable.add(key);
			} else if (ownership.kind === 'other') {
				otherAccount.add(key); // that account quarantines it when it scans
			} else {
				const ownerHash = ownership.kind === 'owned' ? ownership.ownerHash : null;
				corrupt.set(key, await quarantineCorrupt(
					{ key, raw: result.raw, failure: result.failure, message: result.message, ownerHash },
					ownership.kind === 'owned',
				));
			}
			continue;
		}
		if (result.kind === 'foreign') {
			const owner = await readOwner(key);
			if (owner.kind === 'owner' && owner.userHash === userHash) {
				corrupt.set(key, await quarantineCorrupt({ key, raw: result.raw, failure: 'undecryptable', ownerHash: userHash, message: UNDECRYPTABLE_MESSAGE }, true));
			} else if (owner.kind === 'unavailable') {
				unavailable.add(key);
			} else if (owner.kind === 'none') {
				unattributed.set(key, result.raw);
			}
			continue;
		}
		if (result.kind !== 'entry') continue;
		if (result.entry.userHash !== userHash) continue;
		if (result.legacy) await rewriteEncrypted(key, result.entry);
		await repairOwner(key, userHash);
		entries.push(result.entry);
	}
	for (const entry of entries) {
		for (const dep of entry.dependsOn ?? []) {
			const raw = unattributed.get(dep);
			if (raw === undefined || corrupt.has(dep)) continue;
			corrupt.set(dep, await quarantineCorrupt({ key: dep, raw, failure: 'undecryptable', ownerHash: userHash, message: UNDECRYPTABLE_MESSAGE }, true));
		}
	}
	entries.sort((a, b) => (a.id < b.id ? -1 : 1));
	return { entries, corrupt, unavailable, otherAccount, missing };
}

async function repairOwner(id: string, userHash: string): Promise<void> {
	const owner = await readOwner(id);
	if (owner.kind === 'unavailable' || (owner.kind === 'owner' && owner.userHash === userHash)) return;
	await writeOwner(id, userHash).catch(() => {});
}

const ownedCorrupt = (scan: OutboxScan, userHash: string): CorruptOutboxRecordView[] =>
	[...scan.corrupt.values()].filter((r) => r.ownerHash === userHash).sort((a, b) => (a.key < b.key ? -1 : 1));

export async function corruptOutboxRecords(userHash: string): Promise<CorruptOutboxRecordView[]> {
	return ownedCorrupt(await scanOutbox(userHash), userHash);
}

export async function discardCorruptOutboxRecord(userHash: string, key: string): Promise<boolean> {
	const outcome = await withRecordLock(key, async (): Promise<DiscardOutcome> => {
		const stored = await readQuarantine(key);
		if (!stored || stored === 'unreadable' || stored.ownerHash !== userHash) return 'refused';
		const raw = await plainStorage.get(key);
		if (raw !== null && (await sha256Hex(raw)) !== stored.rawSha256) return 'stale';
		if (raw !== null) {
			const marker: OutboxEntry = {
				id: key,
				userHash,
				relation: 'unknown',
				mutations: [],
				createdAt: stored.detectedAt,
				attempts: 0,
				lastError: stored.message,
				status: 'discarded',
				discardedAt: Date.now(),
			};
			await sealFor(marker.userHash).set(key, JSON.stringify(marker));
		}
		await plainStorage.delete(quarantineKeyFor(key));
		return 'discarded';
	});
	if (outcome === 'stale') await scanOutbox(userHash);
	if (outcome !== 'discarded') return false;
	notifyOutcomeChange(userHash);
	return true;
}

type DiscardOutcome = 'discarded' | 'refused' | 'stale';

export type DeviceOutboxDiagnostic =
	| (CorruptOutboxRecord & { kind: 'unknown_owner' })
	/** Opaque ciphertext written before owner records existed: another account's entry, or damaged — undecidable. Never quarantined. */
	| { kind: 'unattributed_ciphertext'; key: string }
	/** The read failed on this pass; nothing is known and nothing is persisted. */
	| { kind: 'unavailable'; key: string; message: string };

export async function deviceOutboxDiagnostics(): Promise<DeviceOutboxDiagnostic[]> {
	const keys = await storage.keys();
	const present = new Set(keys);
	const diagnostics: DeviceOutboxDiagnostic[] = [];
	for (const key of keys) {
		if (isSidecarKey(key)) continue;
		const result = await readEntry(key);
		if (result.kind === 'unavailable') {
			diagnostics.push({ kind: 'unavailable', key, message: UNAVAILABLE_MESSAGE });
		} else if (result.kind === 'corrupt') {
			const ownership = await corruptOwnership(key, result.decrypted, null);
			if (ownership.kind === 'unavailable') {
				diagnostics.push({ kind: 'unavailable', key, message: UNAVAILABLE_MESSAGE });
			} else if (ownership.kind === 'unknown') {
				const record = await quarantineCorrupt({ key, raw: result.raw, failure: result.failure, message: result.message, ownerHash: null }, false);
				diagnostics.push({
					kind: 'unknown_owner', key, ownerHash: null, failure: record.failure, message: record.message,
					detectedAt: record.detectedAt, rawSha256: record.rawSha256,
				});
			}
		} else if (result.kind === 'foreign' && !present.has(ownerKeyFor(key)) && !present.has(quarantineKeyFor(key))) {
			diagnostics.push({ kind: 'unattributed_ciphertext', key });
		}
	}
	return diagnostics;
}

export async function discardUnknownOwnerOutboxRecord(key: string): Promise<boolean> {
	const outcome = await withRecordLock(key, async (): Promise<DiscardOutcome> => {
		const stored = await readQuarantine(key);
		if (!stored || stored === 'unreadable' || stored.ownerHash !== null) return 'refused';
		const raw = await plainStorage.get(key);
		if (raw !== null && (await sha256Hex(raw)) !== stored.rawSha256) return 'stale';
		if (raw !== null) await plainStorage.delete(key);
		await plainStorage.delete(quarantineKeyFor(key));
		return 'discarded';
	});
	if (outcome === 'stale') await deviceOutboxDiagnostics();
	return outcome === 'discarded';
}

async function activeEntryCount(userHash: string): Promise<number> {
	const scan = await scanOutbox(userHash);
	const live = scan.entries.filter((e) => e.status !== 'discarded' && e.status !== 'accepted').length;
	return live + ownedCorrupt(scan, userHash).length;
}

/**
 * Upgrade a pre-encryption entry in place, the first time its owner sees it.
 * Entries of other accounts stay readable on disk until that account logs in —
 * we have no key to re-encrypt them with, and dropping them would lose writes.
 */
async function rewriteEncrypted(key: string, entry: OutboxEntry): Promise<void> {
	try {
		await sealFor(entry.userHash).set(key, JSON.stringify(entry));
	} catch (e) {
		console.warn('[outbox] could not re-encrypt a legacy entry:', e);
	}
}

async function entriesOf(userHash: string): Promise<OutboxEntry[]> {
	return (await scanOutbox(userHash)).entries;
}

export async function findEntryBySourceIntentId(
	userHash: string,
	sourceIntentId: string
): Promise<{ outboxId: string } | null> {
	const scan = await scanOutbox(userHash);
	const match = scan.entries.find((e) => e.sourceIntentId === sourceIntentId);
	if (match) return { outboxId: match.id };
	if (scan.unavailable.size || scan.missing.size || ownedCorrupt(scan, userHash).length) {
		throw new Error(`findEntryBySourceIntentId: ${sourceIntentId} may be stored in a record that cannot be read — refusing to report it absent`);
	}
	return null;
}

const pendingOf = (entries: OutboxEntry[]): OutboxEntry[] =>
	entries.filter((e) => e.status !== 'quarantined' && e.status !== 'discarded' && e.status !== 'accepted');

export async function pendingEntries(userHash: string): Promise<OutboxEntry[]> {
	return pendingOf(await entriesOf(userHash));
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
	const requeued = await withRecordLock(id, async () => {
		const result = await readEntry(id);
		if (result.kind !== 'entry' || result.entry.status === 'discarded' || result.entry.status === 'accepted'
			|| result.entry.status === 'server_accepted_pending_reconcile') return null;
		const entry = result.entry;
		entry.status = 'pending';
		delete entry.quarantinedAt;
		delete entry.nextAttemptAt;
		await sealFor(entry.userHash).set(id, JSON.stringify(entry));
		return entry.userHash;
	});
	if (requeued) wakeRetry(requeued);
}


export async function discardEntry(id: string): Promise<void> {
	const discarded = await withRecordLock(id, async () => {
		const result = await readEntry(id);
		if (result.kind !== 'entry' || result.entry.status === 'discarded' || result.entry.status === 'accepted'
			|| result.entry.status === 'server_accepted_pending_reconcile') return null;
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
		await sealFor(marker.userHash).set(id, JSON.stringify(marker)).catch(() => {});
		return entry.userHash;
	});
	if (discarded) notifyOutcomeChange(discarded);
}

type DependencyState = 'resolved' | 'pending' | 'corrupt' | 'unavailable' | 'unresolvable';

interface DependencyView {
	byId: Map<string, OutboxEntry>;
	corrupt: Map<string, CorruptOutboxRecord>;
	unavailable: Set<string>;
	otherAccount: Set<string>;
}

const dependencyViewOf = (scan: OutboxScan): DependencyView => ({
	byId: new Map(scan.entries.map((e) => [e.id, e])),
	corrupt: scan.corrupt,
	unavailable: scan.unavailable,
	otherAccount: scan.otherAccount,
});

const dependencyState = (dependent: OutboxEntry, depId: string, view: DependencyView): DependencyState => {
	const dep = view.byId.get(depId);
	if (dep) return (dep.status === 'accepted' || dep.status === 'server_accepted_pending_reconcile') ? 'resolved' : 'pending';
	if (view.corrupt.has(depId)) return 'corrupt';
	if (view.unavailable.has(depId)) return 'unavailable';
	if (view.otherAccount.has(depId)) return 'unresolvable';
	return dependent[DEPENDS_ON_DURABLE_MARKERS_FIELD] ? 'unresolvable' : 'resolved';
};

/**
 * Entries the coordinator may dispatch now (§7.3): pending, past their
 * scheduled attempt time, with every dependency resolved. A dependency that
 * is quarantined, discarded, corrupt, unreadable, still pending, or unresolvable (see
 * dependencyState) blocks its dependents — and only them; everything
 * unrelated stays ready. Order is creation order: a deterministic priority
 * among the ready, never a wait on the unready.
 */
export async function readyEntries(userHash: string, now: number = Date.now()): Promise<OutboxEntry[]> {
	const scan = await scanOutbox(userHash);
	const view = dependencyViewOf(scan);
	return scan.entries.filter((e) => {
		if (e.status === 'quarantined' || e.status === 'discarded' || e.status === 'accepted'
			|| e.status === 'server_accepted_pending_reconcile') return false;
		if (e.discoveryBlocked) return false;
		if ((e.nextAttemptAt ?? 0) > now) return false;
		return (e.dependsOn ?? []).every((dep) => dependencyState(e, dep, view) === 'resolved');
	});
}

export async function dependencyCandidates(
	userHash: string,
	observed?: readonly string[],
): Promise<{ entries: OutboxEntry[]; observedKeys: string[] }> {
	const boundary = observed ? [...observed] : (await storage.keys()).filter((k) => !isSidecarKey(k));
	const scan = await scanOutbox(userHash, boundary);
	if (scan.unavailable.size) throw new DependencyDiscoveryError('storage_unavailable', boundary);
	if (ownedCorrupt(scan, userHash).length) throw new DependencyDiscoveryError('corrupt_record', boundary);
	if (scan.missing.size) throw new DependencyDiscoveryError('record_missing', boundary);
	return {
		entries: scan.entries.filter((e) => e.status !== 'discarded' && e.status !== 'accepted'),
		observedKeys: boundary,
	};
}

async function recoverDiscoveryBlocked(userHash: string, rediscover: (entry: OutboxEntry) => Promise<DiscoveryOutcome>): Promise<void> {
	for (const blocked of (await entriesOf(userHash)).filter((e) => e.discoveryBlocked)) {
		let outcome: DiscoveryOutcome;
		try {
			outcome = await rediscover(blocked);
		} catch (e) {
			outcome = { kind: 'blocked', block: dependencyBlockFor(e, blocked.discoveryBlocked!) };
		}
		const applied = await withRecordLock(blocked.id, async () => {
			const result = await readEntry(blocked.id);
			if (result.kind !== 'entry' || !result.entry.discoveryBlocked) return false;
			const entry = result.entry;
			const current = entry.discoveryBlocked!;
			if (outcome.kind === 'found') {
				delete entry.discoveryBlocked;
				if (outcome.dependsOn.length) entry.dependsOn = outcome.dependsOn;
				entry[DEPENDS_ON_DURABLE_MARKERS_FIELD] = true;
			} else {
				entry.discoveryBlocked = {
					...outcome.block,
					kind: current.kind,
					observedKeys: current.observedKeys,
					...(current.admission ? { admission: current.admission } : {}),
					...(current.observedKeys === null ? { reason: 'boundary_unknown', message: DEPENDENCY_BLOCK_MESSAGES.boundary_unknown } : {}),
					blockedAt: current.blockedAt,
					attempts: current.attempts + 1,
				};
			}
			await sealFor(entry.userHash).set(entry.id, JSON.stringify(entry));
			return true;
		});
		if (applied) notifyQueueChange(userHash);
	}
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

/** Pending entries held back by an unresolved, quarantined, discarded,
 * corrupt, unreadable, or unresolvable (see dependencyState) dependency. */
export async function blockedEntries(userHash: string): Promise<OutboxEntry[]> {
	const scan = await scanOutbox(userHash);
	const view = dependencyViewOf(scan);
	return scan.entries.filter((e) =>
		e.status !== 'quarantined' && e.status !== 'discarded' && e.status !== 'accepted'
		&& e.status !== 'server_accepted_pending_reconcile' // L17-10: already past dispatch, never "blocked"
		&& (!!e.discoveryBlocked || (e.dependsOn ?? []).some((dep) => dependencyState(e, dep, view) !== 'resolved')));
}

export interface BlockerSummary {
	id: string;
	relation: string;
	status: 'quarantined' | 'discarded' | 'corrupt' | 'unavailable' | 'unknown';
	lastError: string | null;
}

export interface BlockedDependentIssue {
	entry: { id: string; relation: string };
	blockers: BlockerSummary[];
	discovery?: { reason: DependencyBlockReason; message: string };
}

export async function blockedDependentIssues(userHash: string): Promise<BlockedDependentIssue[]> {
	return blockedIssuesOf(await scanOutbox(userHash));
}

function blockedIssuesOf(scan: OutboxScan): BlockedDependentIssue[] {
	const view = dependencyViewOf(scan);
	const { byId } = view;
	const issues: BlockedDependentIssue[] = [];
	for (const e of scan.entries) {
		if (e.status === 'quarantined' || e.status === 'discarded' || e.status === 'accepted'
			|| e.status === 'server_accepted_pending_reconcile') continue;
		if (e.discoveryBlocked) {
			const { reason, message } = e.discoveryBlocked;
			issues.push({ entry: { id: e.id, relation: e.relation }, blockers: [], discovery: { reason, message } });
			continue;
		}
		const blockers: BlockerSummary[] = [];
		for (const dep of e.dependsOn ?? []) {
			const state = dependencyState(e, dep, view);
			if (state === 'resolved') continue;
			if (state === 'unresolvable') {
				blockers.push({ id: dep, relation: 'unknown', status: 'unknown', lastError: null });
				continue;
			}
			if (state === 'corrupt') {
				blockers.push({ id: dep, relation: 'unknown', status: 'corrupt', lastError: view.corrupt.get(dep)!.message });
				continue;
			}
			if (state === 'unavailable') {
				blockers.push({ id: dep, relation: 'unknown', status: 'unavailable', lastError: UNAVAILABLE_MESSAGE });
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

export const STATE_UNCONFIRMED_MESSAGE = 'its stored state cannot be read right now — it is not sent until it can be';

export type HeldState =
	| { kind: 'held'; reason: DependencyBlockReason; message: string }
	| { kind: 'clear' }
	| { kind: 'unconfirmed'; cause: 'unavailable' | 'missing' | 'corrupt' | 'foreign' | 'other_account' };

export async function heldStateOf(id: string, userHash: string): Promise<HeldState> {
	const result = await readEntry(id);
	if (result.kind === 'unavailable') return { kind: 'unconfirmed', cause: 'unavailable' };
	if (result.kind === 'missing') return { kind: 'unconfirmed', cause: 'missing' };
	if (result.kind === 'corrupt') return { kind: 'unconfirmed', cause: 'corrupt' };
	if (result.kind === 'foreign') return { kind: 'unconfirmed', cause: 'foreign' };
	if (result.entry.userHash !== userHash) return { kind: 'unconfirmed', cause: 'other_account' };
	const block = result.entry.discoveryBlocked;
	return block ? { kind: 'held', reason: block.reason, message: block.message } : { kind: 'clear' };
}

export async function pendingCardWrites(userHash: string): Promise<OutboxEntry[]> {
	const scan = await scanOutbox(userHash);
	if (scan.unavailable.size || scan.missing.size || ownedCorrupt(scan, userHash).length) {
		throw new Error('pendingCardWrites: a record of this account cannot be read — refusing to assume it holds no card write');
	}
	return scan.entries.filter((e) => e.relation === 'user_cards' && e.status !== 'accepted' && e.status !== 'discarded');
}

export async function readableOwnEntries(userHash: string): Promise<OutboxEntry[]> {
	const scan = await scanOutbox(userHash);
	if (scan.unavailable.size || scan.missing.size || ownedCorrupt(scan, userHash).length) {
		throw new Error('readableOwnEntries: a record of this account cannot be read — refusing to assume it holds no write');
	}
	return scan.entries;
}

export type StoredWriteState =
	| { kind: 'accepted' }
	| { kind: 'pending' }
	| { kind: 'rejected'; reason: string }
	| { kind: 'unconfirmed'; cause: string };

export async function storedWriteState(id: string, userHash: string): Promise<StoredWriteState> {
	const result = await readEntry(id);
	if (result.kind !== 'entry') return { kind: 'unconfirmed', cause: result.kind };
	const entry = result.entry;
	if (entry.userHash !== userHash) return { kind: 'unconfirmed', cause: 'other_account' };
	if (entry.status === 'accepted' || entry.status === 'server_accepted_pending_reconcile') return { kind: 'accepted' };
	if (entry.status === 'quarantined') return { kind: 'rejected', reason: entry.lastError ?? 'rejected by the server' };
	if (entry.status === 'discarded') return { kind: 'rejected', reason: 'discarded' };
	return { kind: 'pending' };
}

export type DeliveryVerdict = EntryOutcome | { kind: 'retrying' };

export async function awaitDeliveryVerdict(id: string, userHash: string): Promise<DeliveryVerdict> {
	const verdict = async (): Promise<DeliveryVerdict | null> => {
		const outcome = await currentOutcome(id, userHash);
		if (outcome !== 'pending' && outcome !== 'unknown') return outcome;
		const result = await readEntry(id);
		if (result.kind !== 'entry' || result.entry.userHash !== userHash) return null;
		if (result.entry.status === 'server_accepted_pending_reconcile') return { kind: 'accepted' };
		if (result.entry.attempts > 0 || result.entry.discoveryBlocked) return { kind: 'retrying' };
		return null;
	};
	const immediate = await verdict();
	if (immediate) return immediate;
	return new Promise<DeliveryVerdict>((resolve) => {
		let settled = false;
		const recheck = () => {
			if (settled) return;
			void verdict().then((v) => {
				if (!v || settled) return;
				settled = true;
				unsubscribe();
				clearInterval(failsafeTimer);
				resolve(v);
			});
		};
		const unsubscribe = onOutboxChange((changedUserHash) => {
			if (changedUserHash === userHash) recheck();
		});
		const failsafeTimer = setInterval(recheck, FAILSAFE_RECHECK_MS);
		recheck();
	});
}

export interface AccountOutboxSnapshot {
	pending: OutboxEntry[];
	quarantined: OutboxEntry[];
	corrupt: CorruptOutboxRecordView[];
	blocked: BlockedDependentIssue[];
}

export async function accountOutboxSnapshot(userHash: string): Promise<AccountOutboxSnapshot> {
	const scan = await scanOutbox(userHash);
	return {
		pending: pendingOf(scan.entries),
		quarantined: scan.entries.filter((e) => e.status === 'quarantined'),
		corrupt: ownedCorrupt(scan, userHash),
		blocked: blockedIssuesOf(scan),
	};
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
	keysUnavailable?: boolean;
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
 * entry id, per tab", held by `drainOutbox`'s worker pool (below), for live
 * sends and replay alike.
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

export type SenderAttempt =
	| { kind: 'accepted'; result: unknown }
	/** This tab's sender's attempt failed (recorded on the entry), or the acceptance could not be recorded. */
	| { kind: 'failed'; error: unknown }
	/** The session changed before an attempt settled: nothing about the entry is reported to it. */
	| { kind: 'fenced' }
	/** Another tab or path settled the entry: its durable outcome, and no response. */
	| { kind: 'settled-elsewhere'; outcome: EntryOutcome }
	/** An attempt was expected, but this tab's sender stopped without making one (not ready when claimed, no lock or leadership): the entry stays queued. */
	| { kind: 'deferred' };

export class AcceptanceNotRecordedError extends Error {
	constructor(id: string) {
		super(`the server accepted outbox entry ${id}, but that could not be recorded durably`);
		this.name = 'AcceptanceNotRecordedError';
	}
}

const attemptWaiters = new Map<string, Set<(attempt: SenderAttempt) => void>>();

interface ObservedAttempt {
	promise: Promise<SenderAttempt>;
	settled: SenderAttempt | null;
	defer: () => void;
}
const preRegisteredAttempts = new Map<string, ObservedAttempt>();
const expectedAttempts = new Map<string, Set<string>>();

function deferUnattempted(userHash: string): void {
	const ids = expectedAttempts.get(userHash);
	if (!ids) return;
	expectedAttempts.delete(userHash);
	for (const id of ids) settleAttempt(id, { kind: 'deferred' });
}

function settleAttempt(id: string, attempt: SenderAttempt): void {
	for (const ids of expectedAttempts.values()) ids.delete(id);
	const waiters = attemptWaiters.get(id);
	if (!waiters) return;
	attemptWaiters.delete(id);
	for (const settle of waiters) settle(attempt);
}

function fenceAttemptWaiters(): void {
	const all = [...attemptWaiters.values()];
	attemptWaiters.clear();
	expectedAttempts.clear();
	for (const waiters of all) for (const settle of waiters) settle({ kind: 'fenced' });
}

const settledOutcomeOf = (entry: OutboxEntry): EntryOutcome | null => {
	if (entry.status === 'accepted' || entry.status === 'server_accepted_pending_reconcile' || entry.reconciledAt) return { kind: 'accepted' };
	if (entry.status === 'quarantined') return { kind: 'rejected', error: entry.lastError ?? 'rejected by the server' };
	if (entry.status === 'discarded') return { kind: 'discarded' };
	return null;
};

const sameSessionAs = (token: SessionToken | null): boolean => {
	const now = currentSessionToken();
	return token === null ? now === null : sameSessionToken(token, now);
};

function observeAttempt(userHash: string, id: string): ObservedAttempt {
	const observed: ObservedAttempt = { promise: null as never, settled: null, defer: () => {} };
	observed.promise = waitForAttempt(userHash, id, (finish) => { observed.defer = () => finish({ kind: 'deferred' }); })
		.then((attempt) => (observed.settled = attempt));
	return observed;
}

function waitForAttempt(userHash: string, id: string, expose: (finish: (attempt: SenderAttempt) => void) => void): Promise<SenderAttempt> {
	const token = currentSessionToken();
	if (token && token.userHash !== userHash) return Promise.resolve({ kind: 'fenced' });
	return new Promise<SenderAttempt>((resolve) => {
		let settled = false;
		const finish = (attempt: SenderAttempt) => {
			if (settled) return;
			settled = true;
			attemptWaiters.get(id)?.delete(finish);
			if (attemptWaiters.get(id)?.size === 0) attemptWaiters.delete(id);
			unsubscribe();
			clearInterval(failsafeTimer);
			resolve(sameSessionAs(token) ? attempt : { kind: 'fenced' });
		};
		const recheck = () => {
			if (settled || inFlightEntryIds.has(id)) return;
			void readEntry(id).then((read) => {
				if (settled || inFlightEntryIds.has(id) || read.kind !== 'entry' || read.entry.userHash !== userHash) return;
				const outcome = settledOutcomeOf(read.entry);
				if (outcome) finish({ kind: 'settled-elsewhere', outcome });
			});
		};
		let waiters = attemptWaiters.get(id);
		if (!waiters) attemptWaiters.set(id, (waiters = new Set()));
		waiters.add(finish);
		expose(finish);
		const unsubscribe = onOutboxChange((changedUserHash) => {
			if (changedUserHash === userHash) recheck();
		});
		const failsafeTimer = setInterval(recheck, FAILSAFE_RECHECK_MS);
		recheck();
	});
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

async function claimSenderRole(userHash: string): Promise<boolean> {
	if (leaderOverrideForTests !== null) return leaderOverrideForTests;
	if (leaderUserHash !== userHash) return false;
	if (!WebLocksLeader.isSupported()) return true;
	if (!leader) return false;
	if (leader.isLeader()) return true;
	await leader.requestLeadership();
	return leader.isLeader();
}

function stillSender(userHash: string): boolean {
	if (leaderOverrideForTests !== null) return leaderOverrideForTests;
	if (leaderUserHash !== userHash) return false;
	return WebLocksLeader.isSupported() ? leader?.isLeader() === true : fallbackIsLeader;
}

let activeRun: { userHash: string; isCurrent: () => boolean; wake: () => void } | null = null;

export async function drainOutbox(
	userHash: string,
	send: (mutations: unknown[]) => Promise<unknown>,
	reconcile?: (mutations: unknown[], result?: unknown) => Promise<void>,
	isCurrent?: () => boolean,
	rediscover?: (entry: OutboxEntry) => Promise<DiscoveryOutcome>,
	only?: string,
): Promise<DrainResult> {
	if (reconcile && only === undefined) await reconcileStuckEntries(userHash, reconcile);

	if (!(await claimSenderRole(userHash))) {
		return { sent: 0, dropped: 0, remaining: await pendingCount(userHash), stoppedEarly: false, wasLeader: false };
	}

	const outcome = await withAcquiredLeadership(userHash, async () => {
		if (rediscover && only === undefined) await recoverDiscoveryBlocked(userHash, rediscover);
		let sent = 0;
		let dropped = 0;
		let hadTransientFailure = false;
		let answered = false;
		let keysUnavailable = false;

		const processEntry = async (entry: OutboxEntry): Promise<void> => {
			let attempt: SenderAttempt;
			try {
				const result = await send(entry.mutations);
				const recorded = await markServerAccepted(entry.id);
				sent++;
				// The first answer in this drain ends every backoff that only
				// waited for a connection, so the rest go in this same pass.
				if (!answered) {
					answered = true;
					await clearNetworkSchedules(userHash);
				}

				try {
					if (reconcile) await reconcile(entry.mutations, result);
					await markReconciled(entry.id);
					await resolveEntry(entry.id);
				} catch (e) {
					console.warn('[outbox] reconciliation pending after server acceptance (L17-10):', entry.id, e);
				}
				attempt = recorded ? { kind: 'accepted', result } : { kind: 'failed', error: new AcceptanceNotRecordedError(entry.id) };
			} catch (e) {
				if (e instanceof VaultLockedError || e instanceof AccountMismatchError) {
					// The keys were not open for the request: nothing was sent. Not an
					// attempt — no failure, no count, no schedule; the stored snapshot
					// waits, as it is, for the next run with the keys open.
					keysUnavailable = true;
					attempt = { kind: 'failed', error: e };
				} else {
					// A permanent rejection leaves the replay path but is never
					// silently gone: the entry keeps its signed mutations and the
					// server's verdict.
					await recordFailure(entry.id, e);
					if (e instanceof IngestError && e.permanent) dropped++;
					else hadTransientFailure = true;
					attempt = { kind: 'failed', error: e };
				}
			}
			settleAttempt(entry.id, attempt);
		};

		let wakes = 0;
		let active = 0;
		let failure: { error: unknown } | null = null;
		let allStopped!: () => void;
		const stopped = new Promise<void>((resolve) => { allStopped = resolve; });

		const current = () => (!isCurrent || isCurrent()) && stillSender(userHash) && !keysUnavailable;
		const candidates = async () => (await readyEntries(userHash)).filter((e) => only === undefined || e.id === only);
		const worker = async (): Promise<void> => {
			for (;;) {
				if (!current()) return;
				const seen = wakes;
				const next = (await candidates()).find((e) => !inFlightEntryIds.has(e.id));
				if (!next) {
					if (wakes !== seen) continue;
					return;
				}
				if (!tryClaimOutboxEntry(next.id)) continue;
				try {
					const fresh = current() ? (await candidates()).find((e) => e.id === next.id) : undefined;
					if (fresh && current()) await processEntry(fresh);
				} finally {
					releaseOutboxEntry(next.id);
				}
			}
		};
		const run = {
			userHash,
			isCurrent: () => !isCurrent || isCurrent(),
			wake: () => {
				wakes++;
				if (active < DRAIN_CONCURRENCY) start();
			},
		};
		const start = () => {
			active++;
			void worker().catch((error) => { failure ??= { error }; }).finally(() => {
				active--;
				if (active > 0) return;
				if (activeRun === run) activeRun = null;
				allStopped();
			});
		};
		if (only === undefined) activeRun = run;
		for (let i = 0; i < (only === undefined ? DRAIN_CONCURRENCY : 1); i++) start();
		await stopped;
		if (failure) throw (failure as { error: unknown }).error;
		return { sent, dropped, hadTransientFailure, keysUnavailable };
	}, { wait: leader?.isLeader() === true });

	if (!outcome.acquired) {
		return { sent: 0, dropped: 0, remaining: await pendingCount(userHash), stoppedEarly: false, wasLeader: false };
	}
	return {
		sent: outcome.result.sent,
		dropped: outcome.result.dropped,
		remaining: await pendingCount(userHash),
		stoppedEarly: outcome.result.hadTransientFailure,
		wasLeader: true,
		keysUnavailable: outcome.result.keysUnavailable,
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
 * Starts this tab's loop afresh: drains now, and keeps draining on its own
 * timer until the queue is empty. Every stored schedule stands; with
 * `releaseNetworkBackoffs` (the connection is known to be back) the entries
 * that waited only for a connection are due first. A server's backoff is
 * never cleared here.
 */
export function ensureDrainLoop(
	userHash: string,
	send: (mutations: unknown[]) => Promise<unknown>,
	opts: { releaseNetworkBackoffs?: boolean } & DrainHooks = {},
): void {
	stopDrainLoop(); // also bumps loopGeneration, invalidating any in-flight chain from a previous call
	loopFailures = 0;
	const generation = loopGeneration;
	const hooks: DrainHooks = { reconcile: opts.reconcile, rediscover: opts.rediscover };
	loopChain = { userHash, send, hooks, generation };
	void (async () => {
		if (opts.releaseNetworkBackoffs) await clearNetworkSchedules(userHash);
		await runLoopOnce(userHash, send, hooks, generation);
	})();
}

export interface DrainHooks {
	reconcile?: (mutations: unknown[], result?: unknown) => Promise<void>;
	rediscover?: (entry: OutboxEntry) => Promise<DiscoveryOutcome>;
}

let loopChain: { userHash: string; send: (mutations: unknown[]) => Promise<unknown>; hooks: DrainHooks; generation: number } | null = null;
let loopRunning: number | null = null;
let wakeRequested = false;

/**
 * Hand this tab's sender the account's durable writes to look at now: the
 * running pool is woken, a sleeping loop runs at once, and without a loop one
 * is started. Nothing is stopped or restarted, and the loop's state is kept:
 * readiness, dependencies and schedules are the pool's, read as always.
 */
export function wakeAccountSender(userHash: string, send: (mutations: unknown[]) => Promise<unknown>, hooks: DrainHooks = {}): boolean {
	if (activeRun?.userHash === userHash && activeRun.isCurrent()) {
		activeRun.wake();
		wakeRequested = true;
		return true;
	}
	let chain = loopChain && loopChain.generation === loopGeneration ? loopChain : null;
	if (chain && chain.userHash !== userHash) {
		if (leaderUserHash !== userHash) return false;
		stopDrainLoop();
		chain = null;
	}
	if (chain && loopRunning === chain.generation) {
		wakeRequested = true;
		return true;
	}
	if (loopTimer) {
		clearTimeout(loopTimer);
		loopTimer = null;
	}
	const target = chain ?? (loopChain = { userHash, send, hooks, generation: loopGeneration });
	void runLoopOnce(target.userHash, target.send, target.hooks, target.generation);
	return true;
}

export interface SenderSubmission {
	disposition:
		| { kind: 'attempting' }
		/** `not-sender`: this tab does not lead the account's sending — the leader tab sends it. */
		| { kind: 'queued'; reason: 'not-ready' | 'not-sender'; held?: { reason: DependencyBlockReason; message: string } }
		/** Already past its attempt: accepted by the server, rejected or discarded. */
		| { kind: 'settled'; outcome: EntryOutcome };
	attempt: Promise<SenderAttempt>;
}

export async function submitEntryToSender(
	userHash: string,
	outboxId: string,
	send: (mutations: unknown[]) => Promise<unknown>,
	hooks: DrainHooks = {},
	opts: { targeted?: boolean } = {},
): Promise<SenderSubmission> {
	const stored = await readEntry(outboxId);
	if (stored.kind !== 'entry' || stored.entry.userHash !== userHash) {
		throw new Error(`submitEntryToSender: ${outboxId} is not a stored entry of this account`);
	}
	const block = stored.entry.discoveryBlocked;
	const observed = preRegisteredAttempts.get(outboxId) ?? observeAttempt(userHash, outboxId);
	preRegisteredAttempts.delete(outboxId);
	const attempt = observed.promise;
	const underWay = () => observed.settled !== null || inFlightEntryIds.has(outboxId);
	const settled = underWay() ? null : settledOutcomeOf(stored.entry);
	if (settled) return { disposition: { kind: 'settled', outcome: settled }, attempt };
	const sender = opts.targeted ? await claimSenderRole(userHash) && stillSender(userHash) : stillSender(userHash);
	const attempting = underWay()
		|| (sender && (await readyEntries(userHash)).some((e) => e.id === outboxId))
		|| underWay();
	if (!sender) notifyOtherTabs(userHash);
	if (attempting && observed.settled === null && !opts.targeted) {
		let expected = expectedAttempts.get(userHash);
		if (!expected) expectedAttempts.set(userHash, (expected = new Set()));
		expected.add(outboxId);
	}
	if (opts.targeted) {
		if (attempting && observed.settled === null) sendTargeted(userHash, outboxId, send, hooks, observed);
	} else if (!wakeAccountSender(userHash, send, hooks)) {
		deferUnattempted(userHash);
	}
	return {
		disposition: attempting
			? { kind: 'attempting' }
			: { kind: 'queued', reason: sender ? 'not-ready' : 'not-sender', ...(block ? { held: { reason: block.reason, message: block.message } } : {}) },
		attempt,
	};
}

function sendTargeted(
	userHash: string, outboxId: string, send: (mutations: unknown[]) => Promise<unknown>, hooks: DrainHooks, observed: ObservedAttempt,
): void {
	const token = currentSessionToken();
	const settleUnattempted = () => { if (observed.settled === null) observed.defer(); };
	void drainOutbox(userHash, send, hooks.reconcile, () => sameSessionToken(token, currentSessionToken()), undefined, outboxId)
		.then(settleUnattempted, settleUnattempted);
}

export async function releaseNetworkBackoffs(userHash: string): Promise<void> {
	await clearNetworkSchedules(userHash);
}

async function clearNetworkSchedules(userHash: string): Promise<void> {
	await clearSchedulesWhere(userHash, (entry) => entry.lastErrorNetwork === true);
}

async function clearSchedulesWhere(userHash: string, applies: (entry: OutboxEntry) => boolean): Promise<void> {
	const due = (entry: OutboxEntry) =>
		entry.status !== 'quarantined' && entry.status !== 'discarded' && entry.status !== 'accepted'
		&& entry.status !== 'server_accepted_pending_reconcile' && !!entry.nextAttemptAt && applies(entry);
	try {
		for (const { id } of (await entriesOf(userHash)).filter(due)) {
			// Re-read right before writing, and leave alone what a sender holds:
			// rewriting from an older read could undo an outcome just recorded.
			if (inFlightEntryIds.has(id)) continue;
			const fresh = await readEntry(id);
			if (fresh.kind !== 'entry' || !due(fresh.entry) || inFlightEntryIds.has(id)) continue;
			delete fresh.entry.nextAttemptAt;
			await sealFor(fresh.entry.userHash).set(id, JSON.stringify(fresh.entry));
		}
	} catch { /* schedule reset is best-effort */ }
}

const loopRuns = new Set<Promise<void>>();

export async function _drainLoopSettledForTests(): Promise<void> {
	while (loopRuns.size) await Promise.allSettled([...loopRuns]);
}

function runLoopOnce(
	userHash: string,
	send: (mutations: unknown[]) => Promise<unknown>,
	hooks: DrainHooks,
	generation: number,
): Promise<void> {
	const run = runLoopOnceUntracked(userHash, send, hooks, generation);
	loopRuns.add(run);
	const forget = () => { loopRuns.delete(run); };
	run.then(forget, forget);
	return run;
}

async function runLoopOnceUntracked(
	userHash: string,
	send: (mutations: unknown[]) => Promise<unknown>,
	hooks: DrainHooks,
	generation: number,
): Promise<void> {
	loopRunning = generation;
	try {
		for (;;) {
			wakeRequested = false;
			let result: DrainResult;
			try {
				result = await drainOutbox(userHash, send, hooks.reconcile, () => generation === loopGeneration, hooks.rediscover);
			} catch {
				result = { sent: 0, dropped: 0, remaining: 1, stoppedEarly: true, wasLeader: true };
			}

			if (generation !== loopGeneration) return;

			if (!result.wasLeader) {
				if (wakeRequested) continue; // woken while it asked: this tab may lead now
				// Another tab is draining. Check back lazily: that tab may close with
				// entries still queued, and someone has to pick them up.
				deferUnattempted(userHash);
				loopTimer = setTimeout(() => void runLoopOnce(userHash, send, hooks, generation), 30_000);
				return;
			}
			if (wakeRequested) continue;
			if (result.keysUnavailable) {
				// Nothing can be sent until the keys are open again: no timer. The
				// unlock (session activation) wakes the sender.
				deferUnattempted(userHash);
				return;
			}
			if (result.remaining === 0) {
				loopFailures = 0;
				// Idle now: an entry expected to go and not attempted stays queued.
				deferUnattempted(userHash);
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
			if (wakeRequested) continue;
			deferUnattempted(userHash); // asleep now: what it was expected to send and did not stays queued
			loopTimer = setTimeout(() => void runLoopOnce(userHash, send, hooks, generation), delay);
			return;
		}
	} finally {
		if (loopRunning === generation) loopRunning = null;
	}
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

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
	if (!WebLocksLeader.isSupported()) return true;
	return leader?.isLeader() ?? true;
}

let leaderOverrideForTests: boolean | null = null;
export function _setLeaderForTests(value: boolean | null): void {
	leaderOverrideForTests = value;
}

export function startLeaderElection(userHash: string, becomeLeader: () => void): void {
	if (leaderUserHash === userHash) {
		onBecomeLeader = becomeLeader;
		return;
	}
	stopLeaderElection();
	leaderUserHash = userHash;
	onBecomeLeader = becomeLeader;
	if (!WebLocksLeader.isSupported()) return;
	leader = new WebLocksLeader(`${LOCK_NAME}:${userHash}`);
	leader.onLeadershipChange((becameLeader) => {
		if (becameLeader) onBecomeLeader?.();
	});
	void leader.requestLeadership();
}

export function stopLeaderElection(): void {
	leader?.releaseLeadership();
	leader = null;
	leaderUserHash = null;
	onBecomeLeader = null;
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

const WAKE_CHANNEL_NAME = 'buckitup-outbox-wake';
const wakeChannel: BroadcastChannel | null =
	typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(WAKE_CHANNEL_NAME) : null;
const localWakeListeners = new Set<(userHash: string) => void>();

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
	try {
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
	} catch {
		return [];
	}
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
 * Replay pending writes for one account, oldest first.
 *
 * Strictly sequential, because writes depend on each other: a user card must
 * land before the profile that references it, a message before the edit that
 * supersedes it. A transient failure stops the drain — the network is down
 * and everything behind this entry would only pile up attempts. A permanent
 * failure drops that entry and continues.
 *
 * Cross-tab: only the Web Locks leader drains, so two tabs never replay the
 * same entry concurrently.
 *
 * No delay before an attempt. A drain runs because something said conditions
 * changed — login, or the `online` event — and pacing the first replay would
 * only keep the user's message undelivered for seconds after the network came
 * back. Hammering is prevented by stopping the whole drain on the first
 * transient failure: one request per trigger, at most.
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
	const hasLeadership = leaderOverrideForTests !== null
		? leaderOverrideForTests
		: WebLocksLeader.isSupported() ? await (leader?.requestLeadership() ?? Promise.resolve(true)) : true;

	if (reconcile) await reconcileStuckEntries(userHash, reconcile);

	if (!hasLeadership) {
		return { sent: 0, dropped: 0, remaining: await pendingCount(userHash), stoppedEarly: false, wasLeader: false };
	}

	// Only entries whose schedule has come due and whose dependencies are
	// resolved (§7.3). Scheduled and blocked entries stay put — they are
	// "remaining", not failures, and they hold back nobody else.
	const entries = await readyEntries(userHash);
	let sent = 0;
	let dropped = 0;
	let hadTransientFailure = false;

	for (const entry of entries) {
		if (isCurrent && !isCurrent()) break; // superseded mid-batch — see isCurrent's doc comment
		try {
			const result = await send(entry.mutations);
			await markServerAccepted(entry.id);
			sent++;

			if (!reconcile) {
				await markReconciled(entry.id);
				await resolveEntry(entry.id);
				continue;
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
				continue;
			}
			await recordFailure(entry.id, e);
			hadTransientFailure = true;
		}
	}
	return {
		sent,
		dropped,
		remaining: await pendingCount(userHash),
		stoppedEarly: hadTransientFailure,
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

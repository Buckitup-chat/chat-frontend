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
// Why replay-after-crash is safe: an entry is deleted only after the server
// confirms it, so a crash between "accepted" and "deleted" replays a write
// that already landed. The server answers with a unique-key conflict and the
// identity check (confirm.ts) proves the stored row carries our exact
// signature — reported as success, not as a duplicate.
//
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
	/**
	 * ADR states. `pending` replays; `quarantined` is a permanent rejection
	 * kept so the user's action is not silently lost — it leaves only by an
	 * explicit requeue (the state it depended on changed) or discard.
	 * Entries written before this field exist are pending.
	 */
	status?: 'pending' | 'quarantined';
	quarantinedAt?: number;
	/**
	 * Coordinator fields (ADR §7.3). The retry schedule lives on the entry,
	 * not in a loop's memory: a reload must resume the same schedule, not
	 * invent a new one. Dependencies are entry ids this one must not be
	 * dispatched before; a quarantined dependency blocks its dependents
	 * rather than letting them race ahead of a failed prerequisite.
	 */
	nextAttemptAt?: number;
	dependsOn?: string[];
	/** Read scope of the write (barrier.ts scopeForRelation) — dispatch metadata. */
	scope?: string;
}

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

const leader = new WebLocksLeader(LOCK_NAME);

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
}

export async function enqueue(mutations: unknown[], userHash: string, opts: EnqueueOptions = {}): Promise<string | null> {
	if (!userHash) return null;
	try {
		const keys = await storage.keys();
		if (keys.length >= MAX_OUTBOX_ENTRIES) {
			console.error(
				`[outbox] ${keys.length} entries pending — refusing to queue more. ` +
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
			...(opts.dependsOn?.length ? { dependsOn: opts.dependsOn } : {}),
			...(opts.scope ? { scope: opts.scope } : {}),
		};
		await storage.set(entry.id, JSON.stringify(entry));
		return entry.id;
	} catch (e) {
		console.warn('[outbox] storage unavailable, write is not durable:', e);
		return null;
	}
}

/** Delivered and confirmed — forget it. */
export async function resolveEntry(id: string | null): Promise<void> {
	if (!id) return;
	await storage.delete(id).catch(() => {});
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

export async function pendingEntries(userHash: string): Promise<OutboxEntry[]> {
	return (await entriesOf(userHash)).filter((e) => e.status !== 'quarantined');
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
	if (result.kind !== 'entry') return;
	const entry = result.entry;
	entry.status = 'pending';
	delete entry.quarantinedAt;
	await storage.set(id, JSON.stringify(entry));
}

/** The explicit user decision that ends a quarantined entry's life. */
export async function discardEntry(id: string): Promise<void> {
	await storage.delete(id).catch(() => {});
}

/**
 * Entries the coordinator may dispatch now (§7.3): pending, past their
 * scheduled attempt time, with every dependency resolved. A dependency that
 * is quarantined or still pending blocks its dependents — and only them;
 * everything unrelated stays ready. Order is creation order: a deterministic
 * priority among the ready, never a wait on the unready.
 */
export async function readyEntries(userHash: string, now: number = Date.now()): Promise<OutboxEntry[]> {
	const all = await entriesOf(userHash);
	const byId = new Map(all.map((e) => [e.id, e]));
	return all.filter((e) => {
		if (e.status === 'quarantined') return false;
		if ((e.nextAttemptAt ?? 0) > now) return false;
		// a dependency absent from storage was resolved and forgotten
		return (e.dependsOn ?? []).every((dep) => !byId.has(dep));
	});
}

/** Pending entries held back by an unresolved or quarantined dependency. */
export async function blockedEntries(userHash: string): Promise<OutboxEntry[]> {
	const all = await entriesOf(userHash);
	const byId = new Map(all.map((e) => [e.id, e]));
	return all.filter((e) =>
		e.status !== 'quarantined' && (e.dependsOn ?? []).some((dep) => byId.has(dep)));
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
export async function drainOutbox(
	userHash: string,
	send: (mutations: unknown[]) => Promise<unknown>
): Promise<DrainResult> {
	const isLeader = WebLocksLeader.isSupported() ? await leader.requestLeadership() : true;
	if (!isLeader) {
		return { sent: 0, dropped: 0, remaining: await pendingCount(userHash), stoppedEarly: false, wasLeader: false };
	}

	try {
		// Only entries whose schedule has come due and whose dependencies are
		// resolved (§7.3). Scheduled and blocked entries stay put — they are
		// "remaining", not failures, and they hold back nobody else.
		const entries = await readyEntries(userHash);
		let sent = 0;
		let dropped = 0;

		for (const entry of entries) {
			try {
				await send(entry.mutations);
				await resolveEntry(entry.id);
				sent++;
			} catch (e) {
				if (e instanceof IngestError && e.permanent) {
					// Out of the replay path but never silently gone: the entry
					// keeps its signed mutations and the server's verdict.
					await recordFailure(entry.id, e);
					dropped++;
					continue;
				}
				await recordFailure(entry.id, e);
				return {
					sent,
					dropped,
					remaining: entries.length - sent - dropped,
					stoppedEarly: true,
					wasLeader: true,
				};
			}
		}
		return {
			sent,
			dropped,
			remaining: await pendingCount(userHash),
			stoppedEarly: false,
			wasLeader: true,
		};
	} finally {
		if (WebLocksLeader.isSupported()) leader.releaseLeadership();
	}
}

// ---------- timed retry loop (ADR §5: RETRYABLE_FAILURE carries a time for
// the next attempt; relying only on login/'online' does not conform — a
// server can answer 5xx while connectivity never changes, and the queue
// would never move again) ----------

let loopTimer: ReturnType<typeof setTimeout> | null = null;
let loopFailures = 0;


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
	opts: { resetSchedules?: boolean } = {},
): void {
	stopDrainLoop();
	loopFailures = 0;
	void (async () => {
		if (opts.resetSchedules) await clearSchedules(userHash);
		await runLoopOnce(userHash, send);
	})();
}

/** An external trigger (login, 'online') invalidates backoffs computed
 * against the previous network conditions — entries become due now. */
async function clearSchedules(userHash: string): Promise<void> {
	try {
		for (const entry of await entriesOf(userHash)) {
			if (entry.status !== 'quarantined' && entry.nextAttemptAt) {
				delete entry.nextAttemptAt;
				await storage.set(entry.id, JSON.stringify(entry));
			}
		}
	} catch { /* schedule reset is best-effort */ }
}

async function runLoopOnce(
	userHash: string,
	send: (mutations: unknown[]) => Promise<unknown>,
): Promise<void> {
	let result: DrainResult;
	try {
		result = await drainOutbox(userHash, send);
	} catch {
		result = { sent: 0, dropped: 0, remaining: 1, stoppedEarly: true, wasLeader: true };
	}

	if (!result.wasLeader) {
		// Another tab is draining. Check back lazily: that tab may close with
		// entries still queued, and someone has to pick them up.
		loopTimer = setTimeout(() => void runLoopOnce(userHash, send), 30_000);
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
			.filter((e) => e.status !== 'quarantined' && e.nextAttemptAt)
			.reduce<number | null>((min, e) => (min === null || e.nextAttemptAt! < min ? e.nextAttemptAt! : min), null);
		if (soonest !== null) delay = Math.min(delay, Math.max(soonest - Date.now(), 250));
	} catch { /* pacing fallback is the loop backoff */ }
	loopTimer = setTimeout(() => void runLoopOnce(userHash, send), delay);
}

/** Call on logout: another account's entries are not this session's to send. */
export function stopDrainLoop(): void {
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

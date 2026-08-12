// Durable outbox for signed mutations.
//
// Storage, cross-tab leadership and retry pacing come from
// @tanstack/offline-transactions (IndexedDBAdapter, WebLocksLeader,
// BackoffCalculator). Only the domain logic lives here — what an entry is,
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
import { IndexedDBAdapter, WebLocksLeader, BackoffCalculator } from '@tanstack/offline-transactions';
import { IngestError } from './ingest';

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
}

/**
 * Entries are never silently dropped to make room — the oldest pending write
 * is usually the one the user cares about most. The cap catches a runaway
 * producer, and hitting it is reported, not absorbed.
 */
export const MAX_OUTBOX_ENTRIES = 1000;

let storage = new IndexedDBAdapter(DB_NAME);
const leader = new WebLocksLeader(LOCK_NAME);
const backoff = new BackoffCalculator(true);

/** Test hook: swap the storage adapter (node has no IndexedDB). */
export function _setStorageForTests(adapter: typeof storage): void {
	storage = adapter;
}

let seq = 0;
/** Sortable id: insertion order survives keys() returning in any order. */
const nextId = (): string =>
	`${Date.now().toString(36).padStart(9, '0')}-${(seq++).toString(36).padStart(4, '0')}`;

const relationOf = (mutations: unknown[]): string => {
	const first = mutations[0] as { syncMetadata?: { relation?: string } } | undefined;
	return first?.syncMetadata?.relation ?? 'unknown';
};

/**
 * Persist mutations before the send is attempted. Returns the entry id, or
 * null when storage is unavailable (private mode) — the caller still sends,
 * just without durability. Losing durability is bad; refusing to run is worse.
 */
export async function enqueue(mutations: unknown[], userHash: string): Promise<string | null> {
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

/** Delivery failed. Permanent failures die here; transient ones stay. */
export async function recordFailure(id: string | null, error: unknown): Promise<void> {
	if (!id) return;
	try {
		if (error instanceof IngestError && error.permanent) {
			// The server will never accept this mutation; replaying it forever
			// would block every entry behind it in the FIFO drain.
			await storage.delete(id);
			return;
		}
		const raw = await storage.get(id);
		if (!raw) return;
		const entry = JSON.parse(raw) as OutboxEntry;
		entry.attempts += 1;
		entry.lastError = error instanceof Error ? error.message : String(error);
		await storage.set(id, JSON.stringify(entry));
	} catch {
		/* diagnostics only — never let bookkeeping break the send path */
	}
}

export async function pendingEntries(userHash: string): Promise<OutboxEntry[]> {
	try {
		const keys = await storage.keys();
		const entries: OutboxEntry[] = [];
		for (const key of keys) {
			const raw = await storage.get(key);
			if (!raw) continue;
			try {
				const entry = JSON.parse(raw) as OutboxEntry;
				if (entry.userHash === userHash) entries.push(entry);
			} catch {
				// Unreadable entry: nothing can ever replay it.
				await storage.delete(key);
			}
		}
		return entries.sort((a, b) => (a.id < b.id ? -1 : 1));
	} catch {
		return [];
	}
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
		const entries = await pendingEntries(userHash);
		let sent = 0;
		let dropped = 0;

		for (const entry of entries) {
			if (entry.attempts > 0) {
				// Pace replays of previously failed entries; first attempts go
				// straight through.
				await new Promise((r) => setTimeout(r, backoff.calculate(entry.attempts)));
			}
			try {
				await send(entry.mutations);
				await resolveEntry(entry.id);
				sent++;
			} catch (e) {
				if (e instanceof IngestError && e.permanent) {
					console.warn(`[outbox] dropping ${entry.relation} entry ${entry.id}: ${e.message}`);
					await resolveEntry(entry.id);
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
		return { sent, dropped, remaining: 0, stoppedEarly: false, wasLeader: true };
	} finally {
		if (WebLocksLeader.isSupported()) leader.releaseLeadership();
	}
}

/** Test helper: wipe the queue. */
export async function _clearOutboxForTests(): Promise<void> {
	await storage.clear().catch(() => {});
}

/* v8 ignore next -- type-only re-export for the test hook */
export type OutboxStorage = typeof storage;

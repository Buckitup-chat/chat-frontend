// IndexedDB fallback for previously-seen rows (§3.13 + §3.4).
//
// The official warm-start path is persistence.ts's SQLite/OPFS layer. This
// module exists for when that is unavailable (no OPFS support, private
// window, target Pi/WebView not yet validated — docs/backlog.md §4): without
// it, a collection with no persistence degrades straight to in-memory,
// full-refetch, and an offline reload shows nothing until the network
// answers, even for a dialog the user was just looking at.
//
// touchedKeys is the hydration-race guard (§3.4, main:dialogCache.ts/
// userCache.ts's `touchedKeys`, generalized): a key that has received live
// data this session — from Electric, or from persistence.ts's own SQLite
// warm-start — must never be overwritten by this cache, because this cache
// is by definition a lagging copy of whatever the live collection already
// knows. Unlike main's version this needs no time-windowing: once a key is
// touched, disk here can never again be fresher than what is already showing.
import { IndexedDBAdapter } from '@tanstack/offline-transactions';
import type { StringStore } from './secureStore';

const DB_NAME = 'buckitup-read-cache';

// Not encrypted, unlike outbox.ts/intents.ts: this mirrors already-replicated
// server rows (verified or verifiable independently), not signed local
// intent — and local storage need not hide metadata (CTO decision,
// 2026-08-19, docs/invariants.md §1). Content fields arrive already
// end-to-end encrypted (content_b64, refs_map_b64, value_b64) regardless.
let storage: StringStore = new IndexedDBAdapter(DB_NAME);

export function _setReadCacheStorageForTests(adapter: StringStore): void {
	storage = adapter;
}

const cacheKey = (table: string, key: string): string => `${table}:${key}`;

const touchedKeys = new Set<string>();

/** A live source (Electric, or a warm SQLite start) now knows this row —
 * the disk fallback must never be applied over it again this session. */
export function markTouched(table: string, key: string): void {
	touchedKeys.add(cacheKey(table, key));
}

export function isTouched(table: string, key: string): boolean {
	return touchedKeys.has(cacheKey(table, key));
}

/** Test seam: a fresh session has touched nothing yet. */
export function _resetTouchedForTests(): void {
	touchedKeys.clear();
}

export async function setCachedRow(table: string, key: string, row: Record<string, unknown>): Promise<void> {
	try {
		await storage.set(cacheKey(table, key), JSON.stringify(row));
	} catch (e) {
		// Best-effort by design: this cache is a fallback, not a durability
		// guarantee (that is outbox.ts's job) — losing a mirror write degrades
		// a future cold start, it does not lose a user action.
		console.warn(`[readCache] could not cache ${table}:${key}:`, e);
	}
}

export async function deleteCachedRow(table: string, key: string): Promise<void> {
	await storage.delete(cacheKey(table, key)).catch(() => {});
}

export async function getCachedRow(table: string, key: string): Promise<Record<string, unknown> | null> {
	if (isTouched(table, key)) return null; // live data already supersedes it
	try {
		const raw = await storage.get(cacheKey(table, key));
		if (raw === null) return null;
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * All cached rows of a table, optionally narrowed by predicate (e.g. a
 * specific dialog_hash) — rows already superseded by live data are excluded,
 * not just filtered at display time, so a caller cannot accidentally show a
 * stale duplicate next to the real thing.
 */
export async function getCachedRows(
	table: string,
	predicate?: (row: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>[]> {
	const prefix = `${table}:`;
	let keys: string[];
	try {
		keys = await storage.keys();
	} catch {
		return [];
	}
	const rows: Record<string, unknown>[] = [];
	for (const fullKey of keys) {
		if (!fullKey.startsWith(prefix)) continue;
		const key = fullKey.slice(prefix.length);
		if (isTouched(table, key)) continue;
		const raw = await storage.get(fullKey).catch(() => null);
		if (raw === null) continue;
		try {
			const row = JSON.parse(raw) as Record<string, unknown>;
			if (!predicate || predicate(row)) rows.push(row);
		} catch {
			/* corrupt entry — not this cache's job to repair, just skip it */
		}
	}
	return rows;
}

interface MirrorableCollection {
	subscribeChanges(
		callback: (changes: Array<{ key: unknown; value?: Record<string, unknown>; type: string }>) => void,
		options?: { includeInitialState?: boolean }
	): { unsubscribe(): void };
}

/**
 * Keep the fallback cache current for one collection: every row it ever
 * knows about (initial state included) is mirrored here and marked touched,
 * so this cache never re-serves a row the live collection already has —
 * whether that arrived from Electric or from persistence.ts's own
 * SQLite warm-start.
 *
 * Returns the unsubscribe function — call it when the collection is torn
 * down (e.g. a dialog leaving the LRU warm set) to release the listener.
 */
export function mirrorInto(collection: MirrorableCollection, table: string): () => void {
	// Defensive, not load-bearing: this fallback must never be able to break
	// the primary collection it mirrors — a test double or a future
	// collection type without subscribeChanges just goes unmirrored.
	if (typeof collection?.subscribeChanges !== 'function') return () => {};

	// Keys THIS subscription touched — tracked so teardown can undo exactly
	// them. Without this, a dialog evicted from the LRU warm set (or a
	// user_storage collection torn down on account switch) leaves its keys
	// touched forever: reopening the same dialog later builds a brand-new,
	// cold collection, but the fallback would still refuse to serve rows for
	// keys it once saw, defeating the exact "reopen while offline" case this
	// module exists for.
	const ownKeys = new Set<string>();

	const sub = collection.subscribeChanges(
		(changes) => {
			for (const change of changes) {
				const key = String(change.key);
				ownKeys.add(key);
				markTouched(table, key);
				if (change.type === 'delete') {
					void deleteCachedRow(table, key);
				} else if (change.value) {
					void setCachedRow(table, key, change.value);
				}
			}
		},
		{ includeInitialState: true }
	);
	return () => {
		sub.unsubscribe();
		for (const key of ownKeys) touchedKeys.delete(cacheKey(table, key));
	};
}

/** Logout/account switch: previously-cached rows are not this session's to
 * keep showing (§3.11 discipline — read-cache gets the same treatment as
 * outbox.ts/intents.ts even though it holds replicated, not signed, data). */
export async function clearReadCache(): Promise<void> {
	touchedKeys.clear();
	await storage.clear().catch(() => {});
}

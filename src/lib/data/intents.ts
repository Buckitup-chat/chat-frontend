// Durable intent: the moment a user action becomes durable, *before* it is
// canonicalized and signed (main-tanstack-proposal-v3.md, "Момент signing"):
//
//   durable intent (mutable) → resolve construction requirements →
//   canonicalize → sign → durable immutable snapshot (outbox.ts) → dispatch
//
// This lives separately from outbox.ts on purpose. An intent has nothing a
// transport can send yet — no signature, often no resolved base — and must
// never be picked up by the drain loop that scans outbox.ts's entries for
// dispatch. Keeping the two stores apart means the already-reviewed
// signed-snapshot path in outbox.ts needs no change to support this.
//
// Lifecycle a caller is expected to follow:
//   1. enqueueIntent(payload, userHash) — durable the moment the user acted,
//      independent of vault/key availability.
//   2. (optionally, while still unsigned) updateIntent — the user kept
//      editing before anything was signed; replace the payload in place
//      rather than creating a second durable record for the same action.
//   3. once construction requirements resolve and the vault is unlocked:
//      build and sign the mutation, then outbox.ts's enqueue() with the
//      signed result — THIS is the immutable snapshot from here on.
//   4. resolveIntent(id) only after step 3's enqueue() has returned — never
//      before. A crash between 3 and 4 must find both records on recovery
//      and treat the intent as already resolved by its snapshot; discarding
//      the intent first would lose the action if the crash lands between them.
import { IndexedDBAdapter } from '@tanstack/offline-transactions';
import { createSecureStore, type StringStore } from './secureStore';

const DB_NAME = 'buckitup-intents';

export interface IntentEntry<T = unknown> {
	id: string;
	/** The account this intent belongs to; only it may read or resume it. */
	userHash: string;
	relation: string;
	/**
	 * Whatever the caller needs to construct and sign the mutation later
	 * without re-deriving a fresher — and wrong — scope. For a new message
	 * this is the captured causal tails; for an edit, the content and the
	 * revision it targets. Opaque to this module by design.
	 */
	intent: T;
	createdAt: number;
}

const indexedDb = new IndexedDBAdapter(DB_NAME);

/** Same per-account encryption discipline as outbox.ts (§3.11): an intent is
 * as sensitive as the signed mutation it becomes. */
let storage: StringStore = createSecureStore(indexedDb, {
	getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
});

export function _setIntentStorageForTests(adapter: StringStore): void {
	storage = adapter;
}

let seq = 0;
const nextId = (): string => `intent-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Persist a not-yet-signed intent. Returns null when storage is unavailable —
 * same contract as outbox.ts's enqueue(): the caller decides whether that is
 * fatal (ADR §11 — a user-visible mutation must fail visibly rather than
 * proceed as if it were durably queued).
 */
export async function enqueueIntent<T>(intent: T, userHash: string, relation: string): Promise<string | null> {
	if (!userHash) return null;
	try {
		const entry: IntentEntry<T> = { id: nextId(), userHash, relation, intent, createdAt: Date.now() };
		await storage.set(entry.id, JSON.stringify(entry));
		return entry.id;
	} catch (e) {
		console.warn('[intents] storage unavailable, intent is not durable:', e);
		return null;
	}
}

export async function getIntent<T = unknown>(id: string): Promise<IntentEntry<T> | null> {
	try {
		const raw = await storage.get(id);
		if (raw === null) return null;
		return JSON.parse(raw) as IntentEntry<T>;
	} catch {
		return null;
	}
}

/**
 * Replace the payload of a still-unsigned intent in place (§3.12 coalescing:
 * the boundary is the signing moment, not the domain type — once an intent
 * has been promoted to a signed snapshot it no longer exists here to update).
 * A no-op if the intent is gone (already resolved, or never existed).
 */
export async function updateIntent<T>(id: string, intent: T): Promise<void> {
	const existing = await getIntent<T>(id);
	if (!existing) return;
	existing.intent = intent;
	await storage.set(id, JSON.stringify(existing)).catch(() => {});
}

/**
 * The intent has done its job — a signed snapshot now carries it forward.
 * Call only after that snapshot is durable (see the module-level ordering
 * note); never as a way to discard an intent that was never signed — an
 * explicit user cancellation is a domain decision, not this module's.
 */
export async function resolveIntent(id: string): Promise<void> {
	await storage.delete(id).catch(() => {});
}

/** All durable intents of one account, oldest first — recovery scans this on
 * reload the same way outbox.ts scans its own entries. */
export async function intentsOf(userHash: string): Promise<IntentEntry[]> {
	try {
		const keys = await storage.keys();
		const entries: IntentEntry[] = [];
		for (const key of keys) {
			const raw = await storage.get(key).catch(() => null);
			if (raw === null) continue;
			try {
				const entry = JSON.parse(raw) as IntentEntry;
				if (entry.userHash === userHash) entries.push(entry);
			} catch {
				/* unreadable — belongs to another account's key, or corrupt; either
				 * way not ours to touch (outbox.ts's foreign/corrupt distinction
				 * applies here too, but a corrupt intent has no signed snapshot
				 * anywhere to protect, so leaving it be is enough for now) */
			}
		}
		return entries.sort((a, b) => (a.id < b.id ? -1 : 1));
	} catch {
		return [];
	}
}

/** Test helper: wipe the intent store. */
export async function _clearIntentsForTests(): Promise<void> {
	await storage.clear().catch(() => {});
}

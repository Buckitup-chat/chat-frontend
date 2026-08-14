// Shared persistence layer for TanStack DB collections.
//
// Official stack, no hand-rolled storage: wa-sqlite over OPFS via
// @tanstack/browser-db-sqlite-persistence, wrapped around each Electric
// collection with persistedCollectionOptions. Two things follow from this
// choice:
//
//  - Warm start: collections rehydrate rows from SQLite before the network
//    answers, so a reload (or a Pi with no uplink) shows data immediately.
//  - Delta resume: @tanstack/electric-db-collection stores its shape cursor
//    (`electric:resume` — offset + handle + shape id) in the persisted
//    collection metadata and continues the stream from there instead of
//    re-fetching the whole shape.
//
// Availability is a runtime question, not a build-time one: OPFS needs a
// secure context, Worker support and a browser that implements
// navigator.storage.getDirectory. When any of that is missing (private
// windows, old WebKit, jsdom/node tests) the app must still run — collections
// then behave exactly as before this module existed: in-memory, full shape
// fetch on start.
import {
	createBrowserWASQLitePersistence,
	openBrowserWASQLiteOPFSDatabase,
	BrowserCollectionCoordinator,
} from '@tanstack/browser-db-sqlite-persistence';
import type { PersistedCollectionPersistence } from '@tanstack/browser-db-sqlite-persistence';

const DB_NAME = 'buckitup-shapes';

// Off by default, and this is deliberate. wa-sqlite writes the OPFS file in
// clear text — the package takes a database name and a VFS name, and offers no
// key. Row *contents* are still end-to-end encrypted before they reach a
// collection (content_b64, refs_map_b64, type_b64, value_b64), but the
// metadata around them is not: user_hash, dialog_hash, sender_hash,
// owner_timestamp, signatures, and contact display names. That is the social
// graph and the timing of every conversation, readable by anyone with access
// to the device — which conflicts with the requirement that local user data be
// encrypted (product decision, 2026-08-12).
//
// The code stays and stays working; only the switch is off, so it can be
// turned on the moment an encrypting VFS exists. Until then, enable it with
// VITE_SHAPE_PERSISTENCE=1 at build time, or, for a quick manual check on a
// deployed build, localStorage.buckitup_shape_persistence = '1'.
const FLAG_KEY = 'buckitup_shape_persistence';

const persistenceEnabled = (): boolean => {
	if (import.meta.env?.VITE_SHAPE_PERSISTENCE === '1') return true;
	try {
		return localStorage.getItem(FLAG_KEY) === '1';
	} catch {
		return false;
	}
};

let persistence: PersistedCollectionPersistence | null = null;
let initStarted = false;

/**
 * Open the shared OPFS database. Call once, before the first collection is
 * built — collections created earlier simply stay in-memory. Safe to call
 * from environments without OPFS; resolves false and the app runs as before.
 *
 * Resolves false when the feature flag is off, which is the default — see the
 * note on the flag above.
 */
export async function initPersistence(): Promise<boolean> {
	if (initStarted) return persistence !== null;
	initStarted = true;

	if (!persistenceEnabled()) return false;

	try {
		const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: DB_NAME });
		persistence = createBrowserWASQLitePersistence({
			database,
			// Cross-tab: one tab leads writes to SQLite, the rest follow over
			// BroadcastChannel. Without this, two tabs would race the same
			// OPFS file.
			coordinator: new BrowserCollectionCoordinator({ dbName: DB_NAME }),
		});
		console.log('[data] shape persistence active (wa-sqlite over OPFS)');
		return true;
	} catch (e) {
		console.warn('[data] shape persistence unavailable, running in-memory:', e);
		persistence = null;
		return false;
	}
}

/** The shared persistence instance, or null when running in-memory. */
export function getPersistence(): PersistedCollectionPersistence | null {
	return persistence;
}

/** Test helper. */
export function _setPersistenceForTests(p: PersistedCollectionPersistence | null): void {
	persistence = p;
	initStarted = p !== null;
}

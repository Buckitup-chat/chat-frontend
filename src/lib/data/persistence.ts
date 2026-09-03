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

// On by default. wa-sqlite writes the OPFS file in clear text; that is
// acceptable — row contents are end-to-end encrypted by the protocol before
// they reach a collection (content_b64, refs_map_b64, type_b64, value_b64),
// and hiding the envelope around them on the client is not a requirement:
// access control for metadata starts at the backend (CTO decision,
// 2026-08-19).
//
// Opt-out exists for debugging a sync problem without the cache in the way:
// VITE_SHAPE_PERSISTENCE=0 at build time, or, on a deployed build,
// localStorage.buckitup_shape_persistence = '0'.
const FLAG_KEY = 'buckitup_shape_persistence';

const persistenceEnabled = (): boolean => {
	if (import.meta.env?.VITE_SHAPE_PERSISTENCE === '0') return false;
	try {
		return localStorage.getItem(FLAG_KEY) !== '0';
	} catch {
		return true;
	}
};

let persistence: PersistedCollectionPersistence | null = null;
let initStarted = false;

/**
 * Open the shared OPFS database. Call once, before the first collection is
 * built — collections created earlier simply stay in-memory. Safe to call
 * from environments without OPFS; resolves false and the app runs as before.
 *
 * Resolves false when the opt-out flag is set — see the note above.
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

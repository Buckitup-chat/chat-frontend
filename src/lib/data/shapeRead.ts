// One-shot reads of an Electric shape.
//
// Distinct from the collections in ./collections: those subscribe and stay
// live. These answer a single question at a point in time — which chunks does
// the device already hold, is there a vault at this locator — and there is
// nobody to keep the subscription for afterwards.
//
// Both facts below were paid for once and belong in one place rather than at
// every call site.

declare const ELECTRIC_API_URL: string; // build-time define (vite.config.js)

/** Absolute URL for an Electric path, tolerating a missing define and a
 * relative base (a dev server proxying `/api`). */
export const electricUrl = (path: string): string => {
	const base = typeof ELECTRIC_API_URL !== 'undefined' ? ELECTRIC_API_URL : '/api';
	const u = `${base}${path}`;
	if (u.startsWith('http')) return u;
	const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost';
	return `${origin}${u}`;
};

/**
 * Snapshot of every row matching `where`, unwrapped out of the shape log.
 *
 * The where clause gets a no-op condition appended. Shapes are cached per
 * (table, where), and one with no live subscriber does not advance its log — a
 * plain re-read can miss rows committed seconds earlier (verified against
 * staging: a same-where read missed a fresh insert for 30s+ while a fresh-where
 * read saw it instantly). A where nobody is subscribed to forces a fresh
 * snapshot.
 *
 * Random plus a counter, not the clock: `Date.now() % 100000` repeats every
 * 100 seconds, so a caller polling on any interval that divides that cycle
 * re-asks for the very shape it is trying to get out of — and a recovery screen
 * waiting for a row to appear is exactly such a caller. The counter covers two
 * calls landing on the same random draw.
 *
 * One value, used on both sides of the comparison: computing it twice can emit
 * a predicate that is false for every row, which every caller here would report
 * as "no rows".
 */
let probe = 0;

export const readShapeOnce = async <T>(table: string, where: string, signal?: AbortSignal): Promise<T[]> => {
	const salt = `${Math.floor(Math.random() * 1e9)}${++probe}`;
	const query = encodeURIComponent(`${where} AND ${salt}=${salt}`);
	const res = await fetch(electricUrl(`/shapes?table=${table}&where=${query}&offset=-1`), { signal });
	if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status}`);
	return ((await res.json()) as Array<{ value?: T }>)
		.map((r) => r.value)
		.filter((v): v is T => v !== null && v !== undefined);
};

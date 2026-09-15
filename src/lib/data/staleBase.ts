// Read scopes whose latest accepted write has not become visible.
//
// A shape barrier that times out leaves the client in a state the ADR names
// explicitly: SERVER_ACCEPTED but not SHAPE_VISIBLE. The write must not be
// resent — the server committed it — but the read model is known to be behind,
// so nothing may be built on it.
//
// This is the smallest honest expression of that: the scope is flagged, and a
// write that would extend a row in that scope refuses instead of signing
// against a tip it knows may be stale. Independent writes — a new message, a
// receipt — are untouched: they record what the author saw and depend on no
// confirmed state (ADR §7.2).

/** A write refused because its base is known to be behind the server. */
export class StaleBaseError extends Error {
	readonly scope: string;
	constructor(scope: string) {
		super(`base for ${scope} is not confirmed visible yet`);
		this.name = 'StaleBaseError';
		this.scope = scope;
	}
}

const unconfirmed = new Set<string>();

/** The scope's accepted write never showed up in the shape. */
export const markUnconfirmed = (scope: string): void => { unconfirmed.add(scope); };

/** The scope caught up — a later barrier for it succeeded. */
export const clearUnconfirmed = (scope: string): void => { unconfirmed.delete(scope); };

export const isUnconfirmed = (scope: string): boolean => unconfirmed.has(scope);

/**
 * Guard for a chained write (ADR §7.1): a new version carries the
 * predecessor's `sign_hash` and a greater `owner_timestamp`, both read from
 * the local snapshot. If that snapshot is knowingly behind, the chain built on
 * it would be wrong — fail loudly instead.
 */
export const assertFreshBase = (scope: string): void => {
	if (unconfirmed.has(scope)) throw new StaleBaseError(scope);
};

/** Test seam. */
export const _resetStaleBase = (): void => { unconfirmed.clear(); };

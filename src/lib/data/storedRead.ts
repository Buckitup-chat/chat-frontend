export type StoredRead<T> =
	| { kind: 'present'; row: T }
	| { kind: 'missing' }
	| { kind: 'locked' }
	| { kind: 'corrupt'; failure: 'undecryptable' | 'undecodable' | 'invalid' | 'foreign_owner' }
	| { kind: 'unavailable'; failure: 'io' | 'listing' | 'shape_failed' | 'shape_not_live' };

export function assertNever(value: never): never {
	throw new Error(`unhandled case: ${(value as { kind?: unknown })?.kind}`);
}

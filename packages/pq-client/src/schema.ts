// Signable field lists, mirroring the server's Signable protocol.
//
// The payload must be built from the columns the server signs — named
// explicitly, with their types — not from whatever keys a row object happens
// to carry. A row reaches the verifier through several layers (shape JSON,
// TanStack collection, wa-sqlite persistence), and each is free to add
// bookkeeping keys, drop nulls, or round-trip a boolean as 0/1. Any of those
// silently changes a payload built by enumeration, and the row then fails
// verification for a reason that looks like forgery.
//
// The lists themselves are generated from the backend Ecto schemas — see
// scripts/gen-pq-schema.mjs — so the contract has one source of truth.

import { SIGNABLE, type FieldType, type SignableSchema } from './schema.generated';

export { SIGNABLE, type FieldType, type SignableSchema };

/**
 * What a Postgres boolean means after a trip through the wire.
 *
 * SQLite has no boolean, so a persisted `deleted_flag` returns as 0/1, and the
 * shape endpoint hands back Postgres's own `'t'`. Any reader that accepts a
 * narrower set than this one reads a tombstone as a live row.
 */
export const wireBool = (value: unknown): boolean =>
	typeof value === 'boolean' ? value : value === 1 || value === '1' || value === 't' || value === 'true';

/**
 * Coerces a value back to what the column means.
 *
 * A boolean encoded as "0" where the signer wrote "false" is the
 * single-character difference that makes an honest row look forged.
 */
const coerce = (value: unknown, type: FieldType): unknown => {
	if (value === null || value === undefined) return null;
	switch (type) {
		case 'bool':
			return wireBool(value);
		case 'int':
			return typeof value === 'number' ? value : Number(value);
		default:
			return value;
	}
};

/**
 * The exact signable fields of a row, typed and normalized. Returns null when
 * a signed column is absent: a payload missing a field the signer included
 * cannot verify, and guessing at it would turn a data-shape bug into a
 * spurious "bad signature".
 */
export const signableFields = (
	relation: keyof typeof SIGNABLE | string,
	row: Record<string, unknown>,
): Record<string, unknown> | null => {
	const schema = SIGNABLE[relation];
	if (!schema) return null;
	const out: Record<string, unknown> = {};
	for (const [field, type] of Object.entries(schema)) {
		if (!(field in row)) return null;
		out[field] = coerce(row[field], type);
	}
	return out;
};

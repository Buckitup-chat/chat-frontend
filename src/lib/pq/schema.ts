// Signable field lists, mirroring the server's Signable protocol.
//
// The payload must be built from the columns the server signs — named
// explicitly, with their types — not from whatever keys a row object happens
// to carry. A row reaches the verifier through several layers (shape JSON,
// TanStack collection, wa-sqlite persistence), and each is free to add
// bookkeeping keys, drop nulls, or round-trip a boolean as 0/1. Any of those
// silently changes a payload built by enumeration, and the row then fails
// verification for a reason that looks like forgery.

export type FieldType = 'text' | 'int' | 'bool' | 'binary';

/** Column name → type. sign_b64 and sign_hash are never signable. */
export type SignableSchema = Record<string, FieldType>;

const MESSAGE_FIELDS: SignableSchema = {
	message_id: 'text',
	dialog_hash: 'text',
	sender_hash: 'text',
	content_b64: 'binary',
	deleted_flag: 'bool',
	refs_map_b64: 'binary',
	parent_sign_hash: 'text',
	owner_timestamp: 'int',
};

export const SIGNABLE: Record<string, SignableSchema> = {
	user_cards: {
		user_hash: 'text',
		sign_pkey: 'binary',
		contact_pkey: 'binary',
		contact_cert: 'binary',
		crypt_pkey: 'binary',
		crypt_cert: 'binary',
		name: 'text',
		deleted_flag: 'bool',
		owner_timestamp: 'int',
	},
	dialog_messages: MESSAGE_FIELDS,
	dialog_messages_versions: MESSAGE_FIELDS,
	dialog_message_reactions: {
		reaction_hash: 'text',
		dialog_hash: 'text',
		message_id: 'text',
		message_sign_hash: 'text',
		reactor_hash: 'text',
		type_b64: 'binary',
		deleted_flag: 'bool',
		owner_timestamp: 'int',
	},
	dialog_message_receipts: {
		receipt_hash: 'text',
		dialog_hash: 'text',
		message_id: 'text',
		peer_hash: 'text',
		type: 'text',
		message_sign_hash: 'text',
		owner_timestamp: 'int',
	},
};

/**
 * Coerces a value back to what the column means.
 *
 * SQLite has no boolean, so a persisted `deleted_flag` returns as 0/1 and
 * would encode as "0" where the signer wrote "false" — the single-character
 * difference that makes an honest row look forged.
 */
const coerce = (value: unknown, type: FieldType): unknown => {
	if (value === null || value === undefined) return null;
	switch (type) {
		case 'bool':
			if (typeof value === 'boolean') return value;
			return value === 1 || value === '1' || value === 't' || value === 'true';
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

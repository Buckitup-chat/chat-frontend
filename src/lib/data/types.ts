// Row types for Electric-synced tables, mirroring the backend schema
// (chat repo: priv/repo/migrations, frontend legacy: src/utils/db/schemaV4.sql).
// Only server-side columns — local sync bookkeeping (modified_columns,
// sent_to_server, created_at, updated_at) does not exist in this layer.

export interface UserCardRow {
	user_hash: string;
	sign_pkey: string | null;
	crypt_pkey: string | null;
	crypt_cert: string | null;
	contact_pkey: string | null;
	contact_cert: string | null;
	name: string;
	deleted_flag: boolean;
	owner_timestamp: number | null;
	sign_b64: string | null;
}

// Exactly the server schema (chat: lib/chat/data/schemas/user_storage.ex).
// No `version`, no `hash_b64` — those were client inventions; comparing a
// synthetic local counter against Electric rows silently preferred stale
// local data (third-party review, finding 4). Local-only metadata lives in
// src/lib/data/userStorage.ts, never in this row type.
export interface UserStorageRow {
	user_hash: string;
	uuid: string;
	value_b64: string | null;
	deleted_flag: boolean;
	parent_sign_hash: string | null;
	sign_hash: string | null;
	owner_timestamp: number | null;
	sign_b64: string | null;
}

export interface DialogKeyRow {
	dialog_hash: string;
	sender_hash: string;
	peer_hash: string | null;
	peer_kem_wrap_key_b64: string | null;
	peer_wrapped_msg_key_b64: string | null;
	owner_timestamp: number | null;
	deleted_flag: boolean;
	sign_b64: string | null;
}

export interface DialogMessageRow {
	message_id: string;
	dialog_hash: string;
	sender_hash: string;
	content_b64: string | null;
	deleted_flag: boolean;
	refs_map_b64: string | null;
	parent_sign_hash: string | null;
	owner_timestamp: number;
	sign_b64: string | null;
	sign_hash: string | null;
}

export interface DialogMessageVersionRow {
	message_id: string;
	sign_hash: string;
	dialog_hash: string;
	sender_hash: string;
	content_b64: string | null;
	deleted_flag: boolean;
	refs_map_b64: string | null;
	parent_sign_hash: string | null;
	owner_timestamp: number;
	sign_b64: string | null;
}

export interface DialogMessageReactionRow {
	reaction_hash: string;
	dialog_hash: string;
	message_id: string;
	message_sign_hash: string | null;
	reactor_hash: string;
	type_b64: string | null;
	deleted_flag: boolean;
	owner_timestamp: number;
	sign_b64: string | null;
}

export interface DialogMessageReceiptRow {
	receipt_hash: string;
	dialog_hash: string;
	message_id: string;
	peer_hash: string;
	type: string | null;
	message_sign_hash: string | null;
	owner_timestamp: number;
	sign_b64: string | null;
}

/** Per-row outcome of POST /ingest_each. */
export interface IngestRowResult {
	index: number;
	status: 'ok' | 'error';
	txid?: number;
	error?: string;
	details?: Record<string, string[]>;
}

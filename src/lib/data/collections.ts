// Electric shape → TanStack DB collection registry.
//
// user_cards syncs as a whole-table shape — it is the public directory and
// every row is needed to verify anyone. Everything else is filtered to the
// scope that needs it: user_storage to the signed-in account, dialog tables
// to the dialog being viewed, both opened lazily. Collections
// with no subscribers stop syncing and free memory after `gcTime`.
import { createCollection } from '@tanstack/db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence';
import { getPersistence } from './persistence';
import { alwaysActiveVisibility } from './visibility';
import type {
	UserCardRow,
	UserStorageRow,
	DialogKeyRow,
	DialogMessageRow,
	DialogMessageVersionRow,
	DialogMessageReactionRow,
	DialogMessageReceiptRow,
} from './types';

declare const ELECTRIC_API_URL: string; // build-time define (vite.config.js)

const electricUrl = (path: string): string => {
	const base = typeof ELECTRIC_API_URL !== 'undefined' ? ELECTRIC_API_URL : '/api';
	const u = `${base}${path}`;
	if (u.startsWith('http')) return u;
	const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost';
	return `${origin}${u}`;
};

// Electric serializes Postgres bigint (int8) as string; timestamps fit in 2^53.
const parser = { int8: (v: string) => Number(v) };

const DIALOG_GC_MS = 60_000; // keep closed dialogs warm for quick back-navigation

// Validation, not sanitization: the dialog hash format is fixed by the
// protocol (chat docs: pq_dialogs.md §Identifiers). Anything else is a bug at
// the call site and must fail loudly, not be silently rewritten into a
// different (still wrong) shape filter.
const DIALOG_HASH_RE = /^di_[0-9a-f]{128}$/;
const assertDialogHash = (value: string): string => {
	if (!DIALOG_HASH_RE.test(value)) {
		throw new Error(`Invalid dialog_hash: ${JSON.stringify(value)}`);
	}
	return value;
};

const USER_HASH_RE = /^u_[0-9a-f]{128}$/;
const assertUserHash = (value: string): string => {
	if (!USER_HASH_RE.test(value)) {
		throw new Error(`Invalid user_hash: ${JSON.stringify(value)}`);
	}
	return value;
};

const shapeDefaults = { parser, runtimeVisibility: alwaysActiveVisibility };

// Wrap an Electric collection config with the shared SQLite persistence when
// it is available (initPersistence() ran and OPFS exists). Electric stores its
// shape cursor in the persisted metadata, so a wrapped collection warm-starts
// from disk and resumes the stream from the stored offset instead of
// re-fetching the shape. Without persistence the config passes through
// untouched — same in-memory behaviour as before.
//
// Bump SCHEMA_VERSION when a row type changes shape; mismatched local data is
// then dropped and re-synced from the server (the server is always the source
// of truth — local SQLite is only a cache plus outbox).
const SCHEMA_VERSION = 1;

// The wrapped config's generics survive at runtime; typing the passthrough
// exactly would just duplicate the library's own overloads.
const persisted = <C extends { id?: string }>(config: C): C => {
	const persistence = getPersistence();
	if (!persistence) return config;
	return persistedCollectionOptions({
		...(config as C & Parameters<typeof persistedCollectionOptions>[0]),
		persistence,
		schemaVersion: SCHEMA_VERSION,
	}) as unknown as C;
};

// ---------- global collections ----------

let userCards: ReturnType<typeof buildUserCards> | null = null;
const buildUserCards = () =>
	createCollection(
		persisted(electricCollectionOptions<UserCardRow>({
			id: 'user_cards',
			shapeOptions: {
				// /shapes is the sanctioned endpoint going forward (backend team,
				// 2026-07-31); the legacy guarded /user_card proxy needs a special
				// offset dance and is being phased out.
				url: electricUrl('/shapes'),
				params: { table: 'user_cards' },
				...shapeDefaults,
			},
			getKey: (r) => r.user_hash,
		}))
	);

export function getUserCardsCollection() {
	if (!userCards) userCards = buildUserCards();
	return userCards;
}

// Scoped to one account. user_storage reads are public, so an unfiltered
// shape streams every account's rows to every client — bandwidth we do not
// need and metadata we should not hold. Every caller here addresses its own
// user_hash, so the filter costs nothing. This makes the collection lazy
// (built after login) the way the dialog collections already are.
let userStorage: ReturnType<typeof buildUserStorage> | null = null;
let userStorageOwner: string | null = null;

const buildUserStorage = (userHash: string) =>
	createCollection(
		persisted(electricCollectionOptions<UserStorageRow>({
			id: `us-${userHash.slice(0, 24)}`,
			shapeOptions: {
				url: electricUrl('/shapes'),
				params: { table: 'user_storage', where: `user_hash = '${assertUserHash(userHash)}'` },
				...shapeDefaults,
			},
			getKey: (r) => `${r.user_hash}|${r.uuid}`,
		}))
	);

/**
 * Storage collection for the signed-in account.
 *
 * Requires the account: there is no meaningful account-less view of
 * user_storage, and falling back to an unfiltered shape would quietly restore
 * the network-wide sync this replaced.
 */
export function getUserStorageCollection(userHash?: string) {
	const owner = userHash ?? userStorageOwner;
	if (!owner) {
		throw new Error('user_storage collection requires a user_hash; is anyone signed in?');
	}
	if (!userStorage || userStorageOwner !== owner) {
		userStorage = buildUserStorage(owner);
		userStorageOwner = owner;
	}
	return userStorage;
}

/** Drops the per-account collection on logout. */
export function resetUserStorageCollection() {
	userStorage = null;
	userStorageOwner = null;
}

// ---------- per-dialog collections ----------

export interface DialogCollections {
	keys: ReturnType<typeof buildDialogCollections>['keys'];
	messages: ReturnType<typeof buildDialogCollections>['messages'];
	versions: ReturnType<typeof buildDialogCollections>['versions'];
	reactions: ReturnType<typeof buildDialogCollections>['reactions'];
	receipts: ReturnType<typeof buildDialogCollections>['receipts'];
}

const dialogShape = (table: string, dialogHash: string) => ({
	url: electricUrl('/shapes'),
	params: { table, where: `dialog_hash = '${assertDialogHash(dialogHash)}'` },
	...shapeDefaults,
});

const buildDialogCollections = (dialogHash: string) => {
	const suffix = dialogHash.slice(0, 24);
	return {
		keys: createCollection(
			persisted(electricCollectionOptions<DialogKeyRow>({
				id: `dk-${suffix}`,
				shapeOptions: dialogShape('dialog_keys', dialogHash),
				getKey: (r) => `${r.dialog_hash}|${r.sender_hash}`,
				gcTime: DIALOG_GC_MS,
			}))
		),
		messages: createCollection(
			persisted(electricCollectionOptions<DialogMessageRow>({
				id: `dm-${suffix}`,
				shapeOptions: dialogShape('dialog_messages', dialogHash),
				getKey: (r) => r.message_id,
				gcTime: DIALOG_GC_MS,
			}))
		),
		versions: createCollection(
			persisted(electricCollectionOptions<DialogMessageVersionRow>({
				id: `dmv-${suffix}`,
				shapeOptions: dialogShape('dialog_messages_versions', dialogHash),
				getKey: (r) => `${r.message_id}|${r.sign_hash}`,
				gcTime: DIALOG_GC_MS,
			}))
		),
		reactions: createCollection(
			persisted(electricCollectionOptions<DialogMessageReactionRow>({
				id: `dmr-${suffix}`,
				shapeOptions: dialogShape('dialog_message_reactions', dialogHash),
				getKey: (r) => r.reaction_hash,
				gcTime: DIALOG_GC_MS,
			}))
		),
		receipts: createCollection(
			persisted(electricCollectionOptions<DialogMessageReceiptRow>({
				id: `dmc-${suffix}`,
				shapeOptions: dialogShape('dialog_message_receipts', dialogHash),
				getKey: (r) => r.receipt_hash,
				gcTime: DIALOG_GC_MS,
			}))
		),
	};
};

// LRU: the collections themselves stop syncing once unused (gcTime), but the
// registry would otherwise keep a strong reference to every dialog bundle
// visited in the session. Keep the current dialog plus a small warm set for
// quick back-navigation, and drop the rest.
const MAX_WARM_DIALOGS = 8;
const dialogRegistry = new Map<string, DialogCollections>();

export function getDialogCollections(dialogHash: string): DialogCollections {
	const existing = dialogRegistry.get(dialogHash);
	if (existing) {
		// refresh recency: re-insert moves the key to the end of Map order
		dialogRegistry.delete(dialogHash);
		dialogRegistry.set(dialogHash, existing);
		return existing;
	}

	const entry = buildDialogCollections(dialogHash);
	dialogRegistry.set(dialogHash, entry);

	while (dialogRegistry.size > MAX_WARM_DIALOGS) {
		const oldest = dialogRegistry.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		dialogRegistry.delete(oldest);
	}
	return entry;
}

/** Drop a dialog's collections immediately (e.g. after deleting a dialog). */
export function releaseDialogCollections(dialogHash: string): void {
	dialogRegistry.delete(dialogHash);
}

/** Test/inspection helper. */
export function _dialogRegistrySize(): number {
	return dialogRegistry.size;
}

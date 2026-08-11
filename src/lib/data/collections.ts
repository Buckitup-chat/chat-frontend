// Electric shape → TanStack DB collection registry.
//
// Global tables (user_cards, user_storage) sync whole-table shapes through
// the guarded per-table endpoints, same as the legacy PGlite engine did.
// Dialog tables sync per-dialog filtered shapes through the client-controlled
// /shapes endpoint, opened lazily for the dialog being viewed. Collections
// with no subscribers stop syncing and free memory after `gcTime`.
import { createCollection } from '@tanstack/db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
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

const shapeDefaults = { parser, runtimeVisibility: alwaysActiveVisibility };

// ---------- global collections ----------

let userCards: ReturnType<typeof buildUserCards> | null = null;
const buildUserCards = () =>
	createCollection(
		electricCollectionOptions<UserCardRow>({
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
		})
	);

export function getUserCardsCollection() {
	if (!userCards) userCards = buildUserCards();
	return userCards;
}

let userStorage: ReturnType<typeof buildUserStorage> | null = null;
const buildUserStorage = () =>
	createCollection(
		electricCollectionOptions<UserStorageRow>({
			id: 'user_storage',
			shapeOptions: {
				url: electricUrl('/shapes'),
				params: { table: 'user_storage' },
				...shapeDefaults,
			},
			getKey: (r) => `${r.user_hash}|${r.uuid}`,
		})
	);

export function getUserStorageCollection() {
	if (!userStorage) userStorage = buildUserStorage();
	return userStorage;
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
			electricCollectionOptions<DialogKeyRow>({
				id: `dk-${suffix}`,
				shapeOptions: dialogShape('dialog_keys', dialogHash),
				getKey: (r) => `${r.dialog_hash}|${r.sender_hash}`,
				gcTime: DIALOG_GC_MS,
			})
		),
		messages: createCollection(
			electricCollectionOptions<DialogMessageRow>({
				id: `dm-${suffix}`,
				shapeOptions: dialogShape('dialog_messages', dialogHash),
				getKey: (r) => r.message_id,
				gcTime: DIALOG_GC_MS,
			})
		),
		versions: createCollection(
			electricCollectionOptions<DialogMessageVersionRow>({
				id: `dmv-${suffix}`,
				shapeOptions: dialogShape('dialog_messages_versions', dialogHash),
				getKey: (r) => `${r.message_id}|${r.sign_hash}`,
				gcTime: DIALOG_GC_MS,
			})
		),
		reactions: createCollection(
			electricCollectionOptions<DialogMessageReactionRow>({
				id: `dmr-${suffix}`,
				shapeOptions: dialogShape('dialog_message_reactions', dialogHash),
				getKey: (r) => r.reaction_hash,
				gcTime: DIALOG_GC_MS,
			})
		),
		receipts: createCollection(
			electricCollectionOptions<DialogMessageReceiptRow>({
				id: `dmc-${suffix}`,
				shapeOptions: dialogShape('dialog_message_receipts', dialogHash),
				getKey: (r) => r.receipt_hash,
				gcTime: DIALOG_GC_MS,
			})
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

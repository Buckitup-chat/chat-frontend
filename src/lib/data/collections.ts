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
const q = (v: string) => v.replace(/'/g, ""); // hashes are hex + prefix; strip quotes defensively

const shapeDefaults = { parser, runtimeVisibility: alwaysActiveVisibility };

// ---------- global collections ----------

let userCards: ReturnType<typeof buildUserCards> | null = null;
const buildUserCards = () =>
	createCollection(
		electricCollectionOptions<UserCardRow>({
			id: 'user_cards',
			shapeOptions: {
				// NOTE: the guarded /user_card proxy currently returns an empty shape
				// (observed 2026-07-31 against staging); the client-controlled /shapes
				// endpoint serves the table correctly.
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
	params: { table, where: `dialog_hash = '${q(dialogHash)}'` },
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

const dialogRegistry = new Map<string, DialogCollections>();

export function getDialogCollections(dialogHash: string): DialogCollections {
	let entry = dialogRegistry.get(dialogHash);
	if (!entry) {
		entry = buildDialogCollections(dialogHash);
		dialogRegistry.set(dialogHash, entry);
	}
	return entry;
}

/** Test/inspection helper. */
export function _dialogRegistrySize(): number {
	return dialogRegistry.size;
}

import { IndexedDbStore } from './indexedDbStore';
import { createSecureStore, DecryptFailedError, type StringStore } from './secureStore';
import { AccountMismatchError, VaultLockedError } from './keyCustody';
import { assertNever, type StoredRead } from './storedRead';
import type { UserCardRow, UserStorageRow } from './types';

const DB_NAME = 'buckitup-accepted-snapshot';

const rawIndexedDb = new IndexedDbStore(DB_NAME);
let rawStorage: StringStore = rawIndexedDb;
let storage: StringStore = createSecureStore(rawStorage, {
	getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
});
let bypassPinning = false;

export function _setAcceptedSnapshotStorageForTests(adapter: StringStore): void {
	storage = adapter;
	rawStorage = adapter;
	bypassPinning = true;
}

export function _setRawAcceptedSnapshotStorageForTests(adapter: StringStore): void {
	rawStorage = adapter;
	bypassPinning = false;
	storage = createSecureStore(rawStorage, {
		getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
	});
}

function pinnedStorage(ownerHash?: string): StringStore {
	if (bypassPinning || !ownerHash) return storage;
	return createSecureStore(rawStorage, {
		getKey: async () => (await import('./localCrypto')).getLocalStorageKeyFor(ownerHash),
	});
}

const cacheKey = (relation: string, entityKey: string): string => `${relation}:${entityKey}`;

export function freshestOf<T extends { owner_timestamp?: unknown }>(
	a: T | null | undefined,
	b: T | null | undefined
): T | null {
	if (!a) return b ?? null;
	if (!b) return a;
	return Number(b.owner_timestamp ?? 0) > Number(a.owner_timestamp ?? 0) ? b : a;
}

type StoredText =
	| { kind: 'text'; text: string }
	| { kind: 'missing' }
	| { kind: 'locked'; error: unknown }
	| { kind: 'undecryptable' }
	| { kind: 'unavailable'; error: unknown };

async function readStoredText(key: string, ownerHash?: string): Promise<StoredText> {
	let raw: string | null;
	try {
		raw = await pinnedStorage(ownerHash).get(key);
	} catch (e) {
		if (e instanceof AccountMismatchError) throw e;
		if (e instanceof VaultLockedError) return { kind: 'locked', error: e };
		if (e instanceof DecryptFailedError) return { kind: 'undecryptable' };
		return { kind: 'unavailable', error: e };
	}
	return raw === null ? { kind: 'missing' } : { kind: 'text', text: raw };
}

type StoredObject = { kind: 'object'; value: Record<string, unknown> } | { kind: 'undecodable' } | { kind: 'invalid' };

function parseStoredObject(text: string): StoredObject {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { kind: 'undecodable' };
	}
	return value && typeof value === 'object' && !Array.isArray(value)
		? { kind: 'object', value: value as Record<string, unknown> }
		: { kind: 'invalid' };
}

type BaseRelation = 'user_cards' | 'user_storage';
type BaseRow<R extends BaseRelation> = R extends 'user_cards' ? UserCardRow : UserStorageRow;

const isText = (v: unknown): v is string => typeof v === 'string';
const isTimestamp = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const CARD_TEXT_FIELDS = ['user_hash', 'sign_pkey', 'contact_pkey', 'contact_cert', 'crypt_pkey', 'crypt_cert', 'name', 'sign_b64'] as const;

function classifyBaseRow<R extends BaseRelation>(
	relation: R, entityKey: string, ownerHash: string, row: Record<string, unknown>
): StoredRead<BaseRow<R>> {
	const invalid = { kind: 'corrupt', failure: 'invalid' } as const;
	if (!isText(row.user_hash) || typeof row.deleted_flag !== 'boolean' || !isTimestamp(row.owner_timestamp)) return invalid;
	if (row.user_hash !== ownerHash) return { kind: 'corrupt', failure: 'foreign_owner' };
	if (relation === 'user_cards') {
		if (!CARD_TEXT_FIELDS.every((field) => isText(row[field]))) return invalid;
		if (row.user_hash !== entityKey) return invalid;
	} else {
		if (!isText(row.uuid) || !isText(row.value_b64) || !isText(row.sign_b64) || !isText(row.sign_hash)) return invalid;
		if (!(row.parent_sign_hash === null || row.parent_sign_hash === undefined || isText(row.parent_sign_hash))) return invalid;
		if (entityKey !== `${row.user_hash}|${row.uuid}`) return invalid;
	}
	return { kind: 'present', row: row as BaseRow<R> };
}

export async function readAcceptedBase<R extends BaseRelation>(
	relation: R, entityKey: string, ownerHash: string
): Promise<StoredRead<BaseRow<R>>> {
	return baseReadOf(relation, entityKey, ownerHash, await readStoredText(cacheKey(relation, entityKey), ownerHash));
}

function storedReadOf<T>(stored: StoredText, classify: (row: Record<string, unknown>) => StoredRead<T>): StoredRead<T> {
	switch (stored.kind) {
		case 'missing': return { kind: 'missing' };
		case 'locked': return { kind: 'locked' };
		case 'unavailable': return { kind: 'unavailable', failure: 'io' };
		case 'undecryptable': return { kind: 'corrupt', failure: 'undecryptable' };
		case 'text': {
			const parsed = parseStoredObject(stored.text);
			if (parsed.kind === 'undecodable') return { kind: 'corrupt', failure: 'undecodable' };
			if (parsed.kind === 'invalid') return { kind: 'corrupt', failure: 'invalid' };
			return classify(parsed.value);
		}
		default: return assertNever(stored);
	}
}

function baseReadOf<R extends BaseRelation>(
	relation: R, entityKey: string, ownerHash: string, stored: StoredText
): StoredRead<BaseRow<R>> {
	return storedReadOf(stored, (row) => classifyBaseRow(relation, entityKey, ownerHash, row));
}

export interface AcceptedRowIdentity {
	ownerOf(row: Record<string, unknown>): string | null;
	entityKeyOf(row: Record<string, unknown>): string | null;
}

function classifyAcceptedRow(
	identity: AcceptedRowIdentity, entityKey: string, ownerHash: string, row: Record<string, unknown>
): StoredRead<Record<string, unknown>> {
	const owner = identity.ownerOf(row);
	if (!owner) return { kind: 'corrupt', failure: 'invalid' };
	if (owner !== ownerHash) return { kind: 'corrupt', failure: 'foreign_owner' };
	if (identity.entityKeyOf(row) !== entityKey) return { kind: 'corrupt', failure: 'invalid' };
	return { kind: 'present', row };
}

export async function readAcceptedRecord(
	relation: string, entityKey: string, ownerHash: string, identity: AcceptedRowIdentity
): Promise<StoredRead<Record<string, unknown>>> {
	if (isBaseRelation(relation)) return readAcceptedBase(relation, entityKey, ownerHash) as Promise<StoredRead<Record<string, unknown>>>;
	const stored = await readStoredText(cacheKey(relation, entityKey), ownerHash);
	return storedReadOf(stored, (row) => classifyAcceptedRow(identity, entityKey, ownerHash, row));
}

const isBaseRelation = (relation: string): relation is BaseRelation => relation === 'user_cards' || relation === 'user_storage';

export async function recordAccepted(
	relation: string, entityKey: string, row: Record<string, unknown>, ownerHash?: string
): Promise<void> {
	const key = cacheKey(relation, entityKey);
	if (isBaseRelation(relation)) {
		if (!ownerHash) throw new Error(`[acceptedSnapshot] an accepted ${relation} row is recorded only for a named owner`);
		const incoming = classifyBaseRow(relation, entityKey, ownerHash, row);
		if (incoming.kind !== 'present') throw new Error(`[acceptedSnapshot] refusing to record an accepted ${relation} row that is not this owner's valid row (${incoming.kind === 'corrupt' ? incoming.failure : incoming.kind})`);
		const stored = await readStoredText(key, ownerHash);
		if (stored.kind === 'locked' || stored.kind === 'unavailable') throw stored.error;
		const existing = baseReadOf(relation, entityKey, ownerHash, stored);
		if (existing.kind === 'present' && freshestOf<Record<string, unknown>>(existing.row, row) !== row) return;
		if (existing.kind !== 'present' && existing.kind !== 'missing') {
			throw new Error(`[acceptedSnapshot] the stored accepted ${relation} row is not readable as this owner's row (${existing.kind === 'corrupt' ? existing.failure : existing.kind}); it is kept, not overwritten`);
		}
		await pinnedStorage(ownerHash).set(key, JSON.stringify(row));
		return;
	}
	const stored = await readStoredText(key, ownerHash);
	switch (stored.kind) {
		case 'missing': break;
		case 'locked':
		case 'unavailable': throw stored.error;
		case 'undecryptable': throw new Error('[acceptedSnapshot] the stored accepted row cannot be decrypted; it is kept, not overwritten');
		case 'text': {
			const parsed = parseStoredObject(stored.text);
			if (parsed.kind !== 'object') throw new Error('[acceptedSnapshot] the stored accepted row is not readable; it is kept, not overwritten');
			if (freshestOf(parsed.value, row) !== row) return;
			break;
		}
		default: assertNever(stored);
	}
	await pinnedStorage(ownerHash).set(key, JSON.stringify(row));
}

export async function getAccepted(relation: string, entityKey: string, ownerHash?: string): Promise<Record<string, unknown> | null> {
	const stored = await readStoredText(cacheKey(relation, entityKey), ownerHash);
	switch (stored.kind) {
		case 'missing':
		case 'undecryptable': return null;
		case 'locked':
		case 'unavailable': throw stored.error;
		case 'text': return JSON.parse(stored.text) as Record<string, unknown>;
		default: return assertNever(stored);
	}
}

export type AcceptedState =
	| { kind: 'clear'; row: Record<string, unknown> }
	| { kind: 'absent' }
	| { kind: 'unconfirmed' };

export async function acceptedState(relation: 'user_cards', entityKey: string, ownerHash: string): Promise<AcceptedState> {
	const read = await readAcceptedBase(relation, entityKey, ownerHash);
	switch (read.kind) {
		case 'present': return { kind: 'clear', row: read.row };
		case 'missing': return { kind: 'absent' };
		case 'locked':
		case 'corrupt':
		case 'unavailable': return { kind: 'unconfirmed' };
		default: return assertNever(read);
	}
}

export async function getAllAcceptedForRelation(relation: string): Promise<Record<string, unknown>[]> {
	const prefix = `${relation}:`;
	const keys = await storage.keys();
	const rows: Record<string, unknown>[] = [];
	for (const key of keys) {
		if (!key.startsWith(prefix)) continue;
		const stored = await readStoredText(key);
		if (stored.kind === 'missing' || stored.kind === 'undecryptable') continue;
		if (stored.kind !== 'text') throw stored.error;
		rows.push(JSON.parse(stored.text) as Record<string, unknown>);
	}
	return rows;
}

import { IndexedDBAdapter } from '@tanstack/offline-transactions';
import { createSecureStore, DecryptFailedError, type StringStore } from './secureStore';

const DB_NAME = 'buckitup-accepted-snapshot';

const rawIndexedDb = new IndexedDBAdapter(DB_NAME);
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

export async function recordAccepted(
	relation: string, entityKey: string, row: Record<string, unknown>, ownerHash?: string
): Promise<void> {
	const key = cacheKey(relation, entityKey);
	const store = pinnedStorage(ownerHash);
	let existing: Record<string, unknown> | null = null;
	try {
		const existingRaw = await store.get(key);
		existing = existingRaw !== null ? (JSON.parse(existingRaw) as Record<string, unknown>) : null;
	} catch (e) {
		if (!(e instanceof DecryptFailedError)) throw e;
		existing = null;
	}
	if (freshestOf(existing, row) !== row) return;
	await store.set(key, JSON.stringify(row));
}

export async function getAccepted(relation: string, entityKey: string, ownerHash?: string): Promise<Record<string, unknown> | null> {
	let raw: string | null;
	try {
		raw = await pinnedStorage(ownerHash).get(cacheKey(relation, entityKey));
	} catch (e) {
		if (e instanceof DecryptFailedError) return null;
		throw e;
	}
	if (raw === null) return null;
	return JSON.parse(raw) as Record<string, unknown>;
}

export async function clearAcceptedSnapshots(): Promise<void> {
	await storage.clear().catch(() => {});
}

export async function getAllAcceptedForRelation(relation: string): Promise<Record<string, unknown>[]> {
	const prefix = `${relation}:`;
	const keys = await storage.keys();
	const rows: Record<string, unknown>[] = [];
	for (const key of keys) {
		if (!key.startsWith(prefix)) continue;
		let raw: string | null;
		try {
			raw = await storage.get(key);
		} catch (e) {
			if (e instanceof DecryptFailedError) continue;
			throw e;
		}
		if (raw === null) continue;
		rows.push(JSON.parse(raw) as Record<string, unknown>);
	}
	return rows;
}

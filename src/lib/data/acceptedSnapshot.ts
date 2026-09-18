import { IndexedDBAdapter } from '@tanstack/offline-transactions';
import { createSecureStore, type StringStore } from './secureStore';

const DB_NAME = 'buckitup-accepted-snapshot';

const rawIndexedDb = new IndexedDBAdapter(DB_NAME);
let rawStorage: StringStore = rawIndexedDb;
let storage: StringStore = createSecureStore(rawStorage, {
	getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
});

export function _setAcceptedSnapshotStorageForTests(adapter: StringStore): void {
	storage = adapter;
	rawStorage = adapter;
}

export function _setRawAcceptedSnapshotStorageForTests(adapter: StringStore): void {
	rawStorage = adapter;
	storage = createSecureStore(rawStorage, {
		getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
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

export async function recordAccepted(relation: string, entityKey: string, row: Record<string, unknown>): Promise<void> {
	const key = cacheKey(relation, entityKey);
	let existing: Record<string, unknown> | null = null;
	try {
		const existingRaw = await storage.get(key);
		existing = existingRaw !== null ? (JSON.parse(existingRaw) as Record<string, unknown>) : null;
	} catch {
		existing = null;
	}
	if (freshestOf(existing, row) !== row) return;
	await storage.set(key, JSON.stringify(row));
}

export async function getAccepted(relation: string, entityKey: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await storage.get(cacheKey(relation, entityKey));
		if (raw === null) return null;
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export async function clearAcceptedSnapshots(): Promise<void> {
	await storage.clear().catch(() => {});
}

export async function getAllAcceptedForRelation(relation: string): Promise<Record<string, unknown>[]> {
	const prefix = `${relation}:`;
	try {
		const keys = await storage.keys();
		const rows: Record<string, unknown>[] = [];
		for (const key of keys) {
			if (!key.startsWith(prefix)) continue;
			const raw = await storage.get(key).catch(() => null);
			if (raw === null) continue;
			try {
				rows.push(JSON.parse(raw) as Record<string, unknown>);
			} catch {
				
			}
		}
		return rows;
	} catch {
		return [];
	}
}

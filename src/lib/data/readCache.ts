import { IndexedDBAdapter } from '@tanstack/offline-transactions';
import type { StringStore } from './secureStore';

const DB_NAME = 'buckitup-read-cache';

let storage: StringStore = new IndexedDBAdapter(DB_NAME);

export function _setReadCacheStorageForTests(adapter: StringStore): void {
	storage = adapter;
}

const cacheKey = (table: string, key: string): string => `${table}:${key}`;

const touchedKeys = new Set<string>();

export function markTouched(table: string, key: string): void {
	touchedKeys.add(cacheKey(table, key));
}

export function isTouched(table: string, key: string): boolean {
	return touchedKeys.has(cacheKey(table, key));
}

export function _resetTouchedForTests(): void {
	touchedKeys.clear();
}

export async function setCachedRow(table: string, key: string, row: Record<string, unknown>): Promise<void> {
	try {
		await storage.set(cacheKey(table, key), JSON.stringify(row));
	} catch (e) {
		console.warn(`[readCache] could not cache ${table}:${key}:`, e);
	}
}

export async function deleteCachedRow(table: string, key: string): Promise<void> {
	await storage.delete(cacheKey(table, key)).catch(() => {});
}

export async function getCachedRow(table: string, key: string): Promise<Record<string, unknown> | null> {
	if (isTouched(table, key)) return null;
	try {
		const raw = await storage.get(cacheKey(table, key));
		if (raw === null) return null;
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export async function getCachedRows(
	table: string,
	predicate?: (row: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>[]> {
	const prefix = `${table}:`;
	let keys: string[];
	try {
		keys = await storage.keys();
	} catch {
		return [];
	}
	const rows: Record<string, unknown>[] = [];
	for (const fullKey of keys) {
		if (!fullKey.startsWith(prefix)) continue;
		const key = fullKey.slice(prefix.length);
		if (isTouched(table, key)) continue;
		const raw = await storage.get(fullKey).catch(() => null);
		if (raw === null) continue;
		try {
			const row = JSON.parse(raw) as Record<string, unknown>;
			if (!predicate || predicate(row)) rows.push(row);
		} catch {
		}
	}
	return rows;
}

interface MirrorableCollection {
	subscribeChanges(
		callback: (changes: Array<{ key: unknown; value?: Record<string, unknown>; type: string }>) => void,
		options?: { includeInitialState?: boolean }
	): { unsubscribe(): void };
}

export function mirrorInto(collection: MirrorableCollection, table: string): () => void {
	if (typeof collection?.subscribeChanges !== 'function') return () => {};

	const ownKeys = new Set<string>();

	const sub = collection.subscribeChanges(
		(changes) => {
			for (const change of changes) {
				const key = String(change.key);
				ownKeys.add(key);
				markTouched(table, key);
				if (change.type === 'delete') {
					void deleteCachedRow(table, key);
				} else if (change.value) {
					void setCachedRow(table, key, change.value);
				}
			}
		},
		{ includeInitialState: true }
	);
	return () => {
		sub.unsubscribe();
		for (const key of ownKeys) touchedKeys.delete(cacheKey(table, key));
	};
}

export async function clearReadCache(): Promise<void> {
	touchedKeys.clear();
	await storage.clear().catch(() => {});
}

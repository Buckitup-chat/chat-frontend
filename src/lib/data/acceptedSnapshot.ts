import { IndexedDBAdapter } from '@tanstack/offline-transactions';
import type { StringStore } from './secureStore';

const DB_NAME = 'buckitup-accepted-snapshot';

let storage: StringStore = new IndexedDBAdapter(DB_NAME);

export function _setAcceptedSnapshotStorageForTests(adapter: StringStore): void {
	storage = adapter;
}

const cacheKey = (relation: string, entityKey: string): string => `${relation}:${entityKey}`;

export async function recordAccepted(relation: string, entityKey: string, row: Record<string, unknown>): Promise<void> {
	try {
		await storage.set(cacheKey(relation, entityKey), JSON.stringify(row));
	} catch (e) {
		console.warn(`[acceptedSnapshot] could not record ${relation}:${entityKey}:`, e);
	}
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

export function freshestOf<T extends { owner_timestamp?: unknown }>(
	a: T | null | undefined,
	b: T | null | undefined
): T | null {
	if (!a) return b ?? null;
	if (!b) return a;
	return Number(b.owner_timestamp ?? 0) > Number(a.owner_timestamp ?? 0) ? b : a;
}

export async function clearAcceptedSnapshots(): Promise<void> {
	await storage.clear().catch(() => {});
}

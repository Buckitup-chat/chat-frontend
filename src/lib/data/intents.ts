import { IndexedDBAdapter } from '@tanstack/offline-transactions';
import { createSecureStore, type StringStore } from './secureStore';

const DB_NAME = 'buckitup-intents';

export interface IntentEntry<T = unknown> {
	id: string;
	userHash: string;
	relation: string;
	intent: T;
	createdAt: number;
}

const indexedDb = new IndexedDBAdapter(DB_NAME);

let storage: StringStore = createSecureStore(indexedDb, {
	getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
});

export function _setIntentStorageForTests(adapter: StringStore): void {
	storage = adapter;
}

let seq = 0;
const nextId = (): string => `intent-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export async function enqueueIntent<T>(intent: T, userHash: string, relation: string): Promise<string | null> {
	if (!userHash) return null;
	try {
		const entry: IntentEntry<T> = { id: nextId(), userHash, relation, intent, createdAt: Date.now() };
		await storage.set(entry.id, JSON.stringify(entry));
		return entry.id;
	} catch (e) {
		console.warn('[intents] storage unavailable, intent is not durable:', e);
		return null;
	}
}

export async function getIntent<T = unknown>(id: string): Promise<IntentEntry<T> | null> {
	try {
		const raw = await storage.get(id);
		if (raw === null) return null;
		return JSON.parse(raw) as IntentEntry<T>;
	} catch {
		return null;
	}
}

export async function updateIntent<T>(id: string, intent: T): Promise<void> {
	const existing = await getIntent<T>(id);
	if (!existing) return;
	existing.intent = intent;
	await storage.set(id, JSON.stringify(existing)).catch(() => {});
}

export async function resolveIntent(id: string): Promise<void> {
	await storage.delete(id).catch(() => {});
}

export async function intentsOf(userHash: string): Promise<IntentEntry[]> {
	try {
		const keys = await storage.keys();
		const entries: IntentEntry[] = [];
		for (const key of keys) {
			const raw = await storage.get(key).catch(() => null);
			if (raw === null) continue;
			try {
				const entry = JSON.parse(raw) as IntentEntry;
				if (entry.userHash === userHash) entries.push(entry);
			} catch {
			}
		}
		return entries.sort((a, b) => (a.id < b.id ? -1 : 1));
	} catch {
		return [];
	}
}

export async function _clearIntentsForTests(): Promise<void> {
	await storage.clear().catch(() => {});
}

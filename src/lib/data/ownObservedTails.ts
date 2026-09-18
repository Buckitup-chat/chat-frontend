import { IndexedDBAdapter } from '@tanstack/offline-transactions';
import { createSecureStore, type StringStore } from './secureStore';

const DB_NAME = 'buckitup-own-observed-tails';

const rawIndexedDb = new IndexedDBAdapter(DB_NAME);
let rawStorage: StringStore = rawIndexedDb;
let storage: StringStore = createSecureStore(rawStorage, {
	getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
});

let bypassPinning = false;

export function _setOwnObservedTailsStorageForTests(adapter: StringStore): void {
	storage = adapter;
	rawStorage = adapter;
	bypassPinning = true;
}

export function _setRawOwnObservedTailsStorageForTests(adapter: StringStore): void {
	rawStorage = adapter;
	bypassPinning = false;
	storage = createSecureStore(rawStorage, {
		getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
	});
}

export async function recordOwnObservedTails(messageId: string, observedTails: Record<string, string>, ownerHash: string): Promise<void> {
	const writeStore = bypassPinning
		? storage
		: createSecureStore(rawStorage, { getKey: async () => (await import('./localCrypto')).getLocalStorageKeyFor(ownerHash) });
	await writeStore.set(messageId, JSON.stringify(observedTails));
}

export async function discardOwnObservedTails(messageId: string, ownerHash: string): Promise<void> {
	try {
		const writeStore = bypassPinning
			? storage
			: createSecureStore(rawStorage, { getKey: async () => (await import('./localCrypto')).getLocalStorageKeyFor(ownerHash) });
		await writeStore.delete(messageId);
	} catch (e) {
		console.warn('[ownObservedTails] could not clean up an orphaned tails record for', messageId, e);
	}
}

export async function getOwnObservedTails(messageId: string): Promise<Record<string, string> | null> {
	try {
		const raw = await storage.get(messageId);
		return raw !== null ? (JSON.parse(raw) as Record<string, string>) : null;
	} catch {
		return null;
	}
}

export async function clearOwnObservedTails(): Promise<void> {
	await storage.clear().catch(() => { });
}

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

const rawIndexedDb = new IndexedDBAdapter(DB_NAME);
let rawStorage: StringStore = rawIndexedDb;
let storage: StringStore = createSecureStore(rawStorage, {
	getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
});
let bypassPinning = false;

export function _setIntentStorageForTests(adapter: StringStore): void {
	storage = adapter;
	rawStorage = adapter;
	bypassPinning = true;
}
export function _setRawIntentStorageForTests(adapter: StringStore): void {
	rawStorage = adapter;
	bypassPinning = false;
	storage = createSecureStore(rawStorage, {
		getKey: async () => (await import('./localCrypto')).getLocalStorageKey(),
	});
}

async function pinnedWriteStorage(expectedUserHash: string): Promise<StringStore> {
	if (bypassPinning) return storage;
	const { getLocalStorageKeyFor } = await import('./localCrypto');
	return createSecureStore(rawStorage, { getKey: () => getLocalStorageKeyFor(expectedUserHash) });
}
const CHANGE_CHANNEL_NAME = 'buckitup-intents-change';
const changeChannel: BroadcastChannel | null =
	typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANGE_CHANNEL_NAME) : null;
const changeListeners = new Set<(userHash: string) => void>();

function notifyIntentChange(userHash: string): void {
	for (const handler of changeListeners) {
		try {
			handler(userHash);
		} catch (e) {
			console.warn('[intents] onIntentChange subscriber threw:', e);
		}
	}
	changeChannel?.postMessage({ userHash });
}

export function onIntentChange(handler: (userHash: string) => void): () => void {
	changeListeners.add(handler);
	const listener = (ev: MessageEvent<{ userHash: string }>) => {
		try {
			handler(ev.data.userHash);
		} catch (e) {
			console.warn('[intents] onIntentChange subscriber threw:', e);
		}
	};
	changeChannel?.addEventListener('message', listener);
	return () => {
		changeListeners.delete(handler);
		changeChannel?.removeEventListener('message', listener);
	};
}

const tabNonce = Math.random().toString(36).slice(2, 6).padStart(4, '0');
let seq = 0;
const nextId = (): string => `intent-${Date.now().toString(36)}-${(seq++).toString(36)}-${tabNonce}`;

export async function enqueueIntent<T>(intent: T, userHash: string, relation: string): Promise<string | null> {
	if (!userHash) return null;
	try {
		const entry: IntentEntry<T> = { id: nextId(), userHash, relation, intent, createdAt: Date.now() };
		const writeStore = await pinnedWriteStorage(userHash);
		await writeStore.set(entry.id, JSON.stringify(entry));
		notifyIntentChange(userHash);
		return entry.id;
	} catch (e) {
		console.warn('[intents] intent is not durable (storage unavailable or the active account no longer matches its owner):', e);
		return null;
	}
}
export async function getIntent<T = unknown>(id: string): Promise<IntentEntry<T> | null> {
	const raw = await storage.get(id);
	if (raw === null) return null;
	return JSON.parse(raw) as IntentEntry<T>;
}
export interface ResolvedIntentMarker {
	resolved: true;
	outcome: string;
	ref?: string | null;
	resolvedAt: number;
}

const isResolvedMarker = (intent: unknown): intent is ResolvedIntentMarker =>
	!!intent && typeof intent === 'object' && (intent as { resolved?: unknown }).resolved === true;
export async function updateIntent<T>(id: string, intent: T): Promise<boolean> {
	let existing: IntentEntry<T> | null;
	try {
		existing = await getIntent<T>(id);
	} catch (e) {
		console.warn('[intents] could not read intent before update — refusing to guess its current state:', id, e);
		return false;
	}
	if (!existing || isResolvedMarker(existing.intent)) return false;
	existing.intent = intent;
	try {
		const writeStore = await pinnedWriteStorage(existing.userHash);
		await writeStore.set(id, JSON.stringify(existing));
		notifyIntentChange(existing.userHash);
		return true;
	} catch (e) {
		console.warn('[intents] update is not durable (storage unavailable or the active account no longer matches its owner):', e);
		return false;
	}
}

export interface ResolvedIntentOutcome {
	outcome: string;
	ref?: string | null;
}

export async function resolveIntent(id: string, outcome: ResolvedIntentOutcome): Promise<boolean> {
	if (outcome.outcome === 'durably-dispatched' && !outcome.ref) {
		console.warn('[intents] refusing to mark durably-dispatched with no outbox reference — leaving the intent as it was:', id);
		return false;
	}
	let existing: IntentEntry<unknown> | null;
	try {
		existing = await getIntent(id);
	} catch (e) {
		console.warn('[intents] could not read intent before resolving — leaving it for the next recovery pass:', id, e);
		return false;
	}
	if (!existing) return true;
	if (isResolvedMarker(existing.intent)) return true;

	const marker: IntentEntry<ResolvedIntentMarker> = {
		id: existing.id,
		userHash: existing.userHash,
		relation: existing.relation,
		createdAt: existing.createdAt,
		intent: { resolved: true, outcome: outcome.outcome, ref: outcome.ref ?? null, resolvedAt: Date.now() },
	};
	try {
		const writeStore = await pinnedWriteStorage(existing.userHash);
		await writeStore.set(id, JSON.stringify(marker));
		notifyIntentChange(existing.userHash);
		return true;
	} catch (e) {
		console.warn('[intents] could not durably write the terminal marker — retried by the next recovery pass:', id, e);
		return false;
	}
}

export interface IntentScanIssue {
	key: string;
	kind: 'foreign' | 'corrupt';
	error: string;
}

export interface IntentScanResult {
	entries: IntentEntry[];
	issues: IntentScanIssue[];
}
export async function intentsOf(userHash: string): Promise<IntentScanResult> {
	const keys = await storage.keys();
	const entries: IntentEntry[] = [];
	const issues: IntentScanIssue[] = [];
	for (const key of keys) {
		let raw: string | null;
		try {
			raw = await storage.get(key);
		} catch (e) {
			issues.push({ key, kind: 'foreign', error: String((e as Error)?.message ?? e) });
			continue;
		}
		if (raw === null) continue; // genuinely nothing at this key right now
		try {
			const entry = JSON.parse(raw) as IntentEntry;
			if (entry.userHash === userHash && !isResolvedMarker(entry.intent)) entries.push(entry);
		} catch (e) {
			issues.push({ key, kind: 'corrupt', error: String((e as Error)?.message ?? e) });
		}
	}
	return { entries: entries.sort((a, b) => (a.id < b.id ? -1 : 1)), issues };
}

export async function _clearIntentsForTests(): Promise<void> {
	await storage.clear().catch(() => {});
}

import { IndexedDbStore } from './indexedDbStore';
import { createSecureStore, DecryptFailedError, type StringStore } from './secureStore';

const DB_NAME = 'buckitup-intents';

export interface IntentEntry<T = unknown> {
	id: string;
	userHash: string;
	relation: string;
	intent: T;
	createdAt: number;
	awaiting?: { phase: 'AWAITING_UNLOCK'; since: number };
}

const rawIndexedDb = new IndexedDbStore(DB_NAME);
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

const OWNER_KEY_PREFIX = 'owner|';
const ownerKeyFor = (id: string): string => OWNER_KEY_PREFIX + id;

export async function enqueueIntent<T>(intent: T, userHash: string, relation: string): Promise<string | null> {
	if (!userHash) return null;
	const entry: IntentEntry<T> = { id: nextId(), userHash, relation, intent, createdAt: Date.now() };
	let writeStore: StringStore;
	try {
		writeStore = await pinnedWriteStorage(userHash);
		await writeStore.set(ownerKeyFor(entry.id), JSON.stringify({ userHash }));
	} catch (e) {
		console.warn('[intents] intent is not durable (storage unavailable or the active account no longer matches its owner):', e);
		return null;
	}
	try {
		await writeStore.set(entry.id, JSON.stringify(entry));
	} catch (e) {
		await writeStore.delete(ownerKeyFor(entry.id)).catch(() => {});
		console.warn('[intents] intent is not durable (storage unavailable or the active account no longer matches its owner):', e);
		return null;
	}
	notifyIntentChange(userHash);
	return entry.id;
}

export type IntentOwner = 'current' | 'other' | 'unknown';

async function intentOwner(id: string, userHash: string): Promise<IntentOwner> {
	let raw: string | null;
	try {
		raw = await storage.get(ownerKeyFor(id));
	} catch (e) {
		return e instanceof DecryptFailedError ? 'other' : 'unknown';
	}
	if (raw === null) return 'unknown';
	try {
		const owner = (JSON.parse(raw) as { userHash?: unknown }).userHash;
		if (typeof owner !== 'string' || !owner) return 'unknown';
		return owner === userHash ? 'current' : 'other';
	} catch {
		return 'unknown';
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
	purpose?: string;
}

const purposeOf = (intent: unknown): string | undefined => {
	const purpose = (intent as { purpose?: unknown } | null)?.purpose;
	return typeof purpose === 'string' && purpose ? purpose : undefined;
};

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
	delete existing.awaiting;
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

export async function markIntentAwaitingUnlock(id: string, userHash: string): Promise<boolean> {
	let existing: IntentEntry<unknown> | null;
	try {
		existing = await getIntent(id);
	} catch (e) {
		console.warn('[intents] could not read intent to mark it awaiting unlock:', id, e);
		return false;
	}
	if (!existing || existing.userHash !== userHash || isResolvedMarker(existing.intent)) return false;
	if (existing.awaiting?.phase === 'AWAITING_UNLOCK') return true;
	existing.awaiting = { phase: 'AWAITING_UNLOCK', since: Date.now() };
	try {
		const writeStore = await pinnedWriteStorage(existing.userHash);
		await writeStore.set(id, JSON.stringify(existing));
		notifyIntentChange(existing.userHash);
		return true;
	} catch (e) {
		console.warn('[intents] could not durably mark an intent awaiting unlock — left as it was:', id, e);
		return false;
	}
}

export async function resumeIntentAfterUnlock(id: string, userHash: string): Promise<boolean> {
	let existing: IntentEntry<unknown> | null;
	try {
		existing = await getIntent(id);
	} catch (e) {
		console.warn('[intents] could not read intent to resume it after unlock:', id, e);
		return false;
	}
	if (!existing || existing.userHash !== userHash || isResolvedMarker(existing.intent)) return false;
	if (!existing.awaiting) return true;
	delete existing.awaiting;
	try {
		const writeStore = await pinnedWriteStorage(existing.userHash);
		await writeStore.set(id, JSON.stringify(existing));
		notifyIntentChange(existing.userHash);
		return true;
	} catch (e) {
		console.warn('[intents] could not durably resume an intent after unlock — it stays waiting:', id, e);
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
		intent: {
			resolved: true, outcome: outcome.outcome, ref: outcome.ref ?? null, resolvedAt: Date.now(),
			...(purposeOf(existing.intent) ? { purpose: purposeOf(existing.intent) } : {}),
		},
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
	kind: 'foreign' | 'corrupt' | 'unavailable';
	error: string;
	owner: IntentOwner;
}

export interface IntentScanResult {
	entries: IntentEntry[];
	issues: IntentScanIssue[];
}
export async function intentsOf(userHash: string, opts: { includeResolved?: boolean } = {}): Promise<IntentScanResult> {
	const keys = await storage.keys();
	const present = new Set(keys);
	const entries: IntentEntry[] = [];
	const issues: IntentScanIssue[] = [];
	for (const key of keys) {
		if (key.startsWith(OWNER_KEY_PREFIX)) continue;
		let raw: string | null;
		try {
			raw = await storage.get(key);
		} catch (e) {
			const owner = e instanceof DecryptFailedError ? 'other' : await intentOwner(key, userHash);
			issues.push({ key, kind: e instanceof DecryptFailedError ? 'foreign' : 'unavailable', error: String((e as Error)?.message ?? e), owner });
			continue;
		}
		if (raw === null) continue; // genuinely nothing at this key right now
		let entry: IntentEntry;
		try {
			entry = JSON.parse(raw) as IntentEntry;
		} catch (e) {
			const owner = bypassPinning ? await intentOwner(key, userHash) : 'current';
			issues.push({ key, kind: 'corrupt', error: String((e as Error)?.message ?? e), owner });
			continue;
		}
		if (entry.userHash !== userHash) continue;
		if (!present.has(ownerKeyFor(key))) {
			await pinnedWriteStorage(userHash).then((store) => store.set(ownerKeyFor(key), JSON.stringify({ userHash }))).catch(() => {});
		}
		if (opts.includeResolved || !isResolvedMarker(entry.intent)) entries.push(entry);
	}
	return { entries: entries.sort((a, b) => (a.id < b.id ? -1 : 1)), issues };
}

export async function _clearIntentsForTests(): Promise<void> {
	await storage.clear().catch(() => {});
}

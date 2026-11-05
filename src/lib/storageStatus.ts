// Whether the browser may clear this account's local data, as far as the page
// can tell.
//
// Part of the account exists only in this origin's storage — the vault, the
// outbox, captured intents, unaccepted text (docs/persistence-encryption.md).
// A browser deletes it without asking under storage pressure unless the origin
// holds persistent storage, Safari also after seven days of browsing without a
// visit, and a private window when it closes. The status says which of these
// applies:
//
//  - `persistent`  — `navigator.storage.persisted()` is true;
//  - `best-effort` — it is false;
//  - `ephemeral`   — a private window, detected heuristically (below);
//  - `unknown`     — the Storage API is missing (an insecure context, an old
//                    browser) or did not answer.
//
// Private windows cannot be asked about directly, and browsers work to keep it
// that way, so the check collects signals and reports them:
//
//  - the quota from `estimate()` is very small (below SMALL_QUOTA_BYTES);
//  - the Origin Private File System refuses to open (Firefox private windows
//    reject `getDirectory()` with a SecurityError, Safari private windows with
//    "unknown transient reason").
//
// A refused localStorage write is not one of them: storage blocked in the
// browser's settings or the origin's full localStorage area refuses it too,
// and the private windows of current browsers take the write. It is reported
// on its own.
//
// A browser does not grant persistent storage to a private window, so a
// `persisted()` of true outranks every signal: the signals are then read as
// something else (a nearly full disk shrinks the quota too).
//
// Nothing here asks for persistence: the probe calls `persisted()`,
// `estimate()` and `getDirectory()`, and writes and removes one localStorage key.

export type StorageStatus = 'persistent' | 'best-effort' | 'ephemeral' | 'unknown';

/** Whether the account has a community backup, as far as this device can read (storageStatus.store.ts). */
export type CommunityBackupState = 'yes' | 'not found' | 'unknown';

/** Below this quota a window is suspected private. Normal profiles get a share of the free disk, gigabytes on most devices. */
export const SMALL_QUOTA_BYTES = 120 * 1024 * 1024;

/** What the probe reads from: the browser's globals by default, a fake in tests. */
export interface StorageEnv {
	storage?: Partial<Pick<StorageManager, 'persisted' | 'persist' | 'estimate' | 'getDirectory'>>;
	matchMedia?: (query: string) => { matches: boolean };
	/** iOS Safari's own flag for an app opened from the Home Screen. */
	standalone?: boolean;
	localStorage?: () => Pick<Storage, 'setItem' | 'removeItem'>;
	userAgent: string;
	platform: string;
}

export interface StorageProbe {
	status: StorageStatus;
	/** `persisted()`, or null when the browser has no such call or it failed. */
	persisted: boolean | null;
	usage: number | null;
	quota: number | null;
	/** Runs as an installed app (Home Screen, Dock, desktop window). */
	installed: boolean;
	/** Why this looks like a private window; empty when nothing does. */
	privateSignals: string[];
	/** What localStorage did with a test write: 'accepts writes', 'refused (…)', or 'unavailable' when there is none to ask. */
	localStorage: string;
	userAgent: string;
	platform: string;
}

export interface PersistRequest {
	before: boolean | null;
	/** What `persist()` resolved to, or null when it is missing or failed. */
	granted: boolean | null;
	after: boolean | null;
	error?: string;
}

const messageOf = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

const browserEnv = (): StorageEnv => {
	const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & { standalone?: boolean; userAgentData?: { platform?: string } };
	const win = typeof window !== 'undefined' ? window : undefined;
	return {
		storage: nav.storage,
		matchMedia: win?.matchMedia?.bind(win),
		standalone: nav.standalone,
		localStorage: () => win!.localStorage,
		userAgent: nav.userAgent ?? '',
		platform: nav.userAgentData?.platform || nav.platform || '',
	};
};

/** Opened as an installed app rather than in a browser tab. */
export const isInstalled = (env: Pick<StorageEnv, 'matchMedia' | 'standalone'> = browserEnv()): boolean =>
	env.matchMedia?.('(display-mode: standalone)').matches === true || env.standalone === true;

/** The status from what `persisted()` said and what looks private. */
export const statusOf = (persisted: boolean | null, privateSignals: readonly string[]): StorageStatus => {
	if (persisted === true) return 'persistent';
	if (privateSignals.length > 0) return 'ephemeral';
	if (persisted === false) return 'best-effort';
	return 'unknown';
};

const readPersisted = async (env: StorageEnv): Promise<boolean | null> => {
	if (typeof env.storage?.persisted !== 'function') return null;
	try {
		return (await env.storage.persisted()) === true;
	} catch {
		return null;
	}
};

const readEstimate = async (env: StorageEnv): Promise<{ usage: number | null; quota: number | null }> => {
	if (typeof env.storage?.estimate !== 'function') return { usage: null, quota: null };
	try {
		const { usage, quota } = await env.storage.estimate();
		return { usage: typeof usage === 'number' ? usage : null, quota: typeof quota === 'number' ? quota : null };
	} catch {
		return { usage: null, quota: null };
	}
};

/** The file system's refusal to open, a private-window signal; null when it opens or is missing. */
const fileSystemRefusal = async (env: StorageEnv): Promise<string | null> => {
	// Missing is not refusing: OPFS arrived in Safari 15.2 and Firefox 111.
	if (typeof env.storage?.getDirectory !== 'function') return null;
	try {
		await env.storage.getDirectory();
		return null;
	} catch (e) {
		return `file system refused (${messageOf(e)})`;
	}
};

/** Whether localStorage takes a write; not a private-window signal (above). */
const localStorageWrite = (env: StorageEnv): string => {
	if (!env.localStorage) return 'unavailable';
	const key = 'buckitup:storage-probe';
	try {
		const store = env.localStorage();
		store.setItem(key, '1');
		store.removeItem(key);
		return 'accepts writes';
	} catch (e) {
		return `refused (${messageOf(e)})`;
	}
};

/** Reads the storage state; asks for nothing. */
export const probeStorage = async (env: StorageEnv = browserEnv()): Promise<StorageProbe> => {
	const [persisted, { usage, quota }, fileSystem] = await Promise.all([readPersisted(env), readEstimate(env), fileSystemRefusal(env)]);
	const privateSignals = [
		...(quota !== null && quota < SMALL_QUOTA_BYTES ? [`quota ${formatBytes(quota)} is below ${formatBytes(SMALL_QUOTA_BYTES)}`] : []),
		...(fileSystem ? [fileSystem] : []),
	];
	return {
		status: statusOf(persisted, privateSignals),
		persisted,
		usage,
		quota,
		installed: isInstalled(env),
		privateSignals,
		localStorage: localStorageWrite(env),
		userAgent: env.userAgent,
		platform: env.platform,
	};
};

/** Asks the browser for persistent storage and reports `persisted()` before and after. Firefox may show a prompt. */
export const requestPersistence = async (env: StorageEnv = browserEnv()): Promise<PersistRequest> => {
	const before = await readPersisted(env);
	if (typeof env.storage?.persist !== 'function') return { before, granted: null, after: before, error: 'navigator.storage.persist is missing' };
	let granted: boolean | null = null;
	let error: string | undefined;
	try {
		granted = (await env.storage.persist()) === true;
	} catch (e) {
		error = messageOf(e);
	}
	const after = await readPersisted(env);
	return { before, granted, after, error };
};

export const formatBytes = (bytes: number): string => {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	// The unit moves on by the figure shown: 1023.99 KB would print "1024 KB".
	const shown = (v: number, u: number): string => (u === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0));
	let value = bytes;
	let unit = 0;
	while (Number(shown(value, unit)) >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${shown(value, unit)} ${units[unit]}`;
};

const yesNo = (v: boolean | null): string => (v === null ? 'unavailable' : v ? 'yes' : 'no');
const bytes = (v: number | null): string => (v === null ? 'unavailable' : formatBytes(v));

/** The probe as label/value rows: the Details table, and the text Copy puts on the clipboard. */
export const probeRows = (p: StorageProbe, request: PersistRequest | null, communityBackup: CommunityBackupState | null): [string, string][] => {
	const rows: [string, string][] = [
		['Status', p.status],
		['persisted()', yesNo(p.persisted)],
		['Usage', bytes(p.usage)],
		['Quota', bytes(p.quota)],
		['Installed (standalone)', p.installed ? 'yes' : 'no'],
		['Private window', p.privateSignals.length ? `suspected: ${p.privateSignals.join('; ')}` : 'not detected'],
		['localStorage', p.localStorage],
	];
	if (communityBackup) rows.push(['Community backup', communityBackup]);
	if (request) {
		rows.push(['persisted() before persist()', yesNo(request.before)]);
		rows.push(['persist() answered', request.error ? `failed: ${request.error}` : yesNo(request.granted)]);
		rows.push(['persisted() after persist()', yesNo(request.after)]);
	}
	rows.push(['Platform', p.platform || 'unavailable']);
	rows.push(['User agent', p.userAgent || 'unavailable']);
	return rows;
};

export const probeText = (rows: [string, string][]): string => rows.map(([k, v]) => `${k}: ${v}`).join('\n');

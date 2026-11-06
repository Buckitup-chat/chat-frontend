// "Wipe all" on the login page removes what the app's origin keeps in this
// browser: every IndexedDB database, the Origin Private File System and
// localStorage. It runs at the start of the next load, before anything opens a
// database, since the page that asks holds connections it cannot close
// (docs/persistence-encryption.md, "Wiping the device").

import { withBudget } from '@/lib/withBudget';

/** The request, kept until the wipe is done: whichever tab of the app loads next finishes it. */
const FLAG = 'buckitup:wipe';

/**
 * How long a delete may stay silent. A delete queued behind another pending
 * request on the same database gets no event at all until that one ends.
 */
const DELETE_WAIT_MS = 3000;

export type WipeOutcome = 'done' | 'blocked' | 'failed';

export type WipeEnv = {
	indexedDB?: IDBFactory;
	storage?: Pick<StorageManager, 'getDirectory'>;
	localStorage?: Storage;
	/** Marks the tab that asked, which finishes the wipe without asking again. */
	sessionStorage?: Storage;
	locks?: Pick<LockManager, 'request'>;
	waitMs?: number;
};

// A getter that throws (storage blocked in the browser's settings) leaves the part out.
const read = <T>(get: () => T): T | undefined => {
	try {
		return get();
	} catch {
		return undefined;
	}
};

const browserEnv = (): WipeEnv => ({
	indexedDB: read(() => globalThis.indexedDB),
	storage: read(() => globalThis.navigator?.storage),
	localStorage: read(() => globalThis.localStorage),
	sessionStorage: read(() => globalThis.sessionStorage),
	locks: read(() => globalThis.navigator?.locks),
});

/** Asks for a wipe on the next load. Throws where localStorage is unavailable: nothing would run it. */
export const requestWipe = ({ localStorage: local, sessionStorage: session } = browserEnv()) => {
	if (!local) throw new Error('This browser does not let the app keep a note across a reload, so it cannot wipe itself.');
	local.setItem(FLAG, '1');
	read(() => session?.setItem(FLAG, '1'));
};

export const wipePending = (local = browserEnv().localStorage) => read(() => local?.getItem(FLAG)) === '1';

// A connection still open makes the app's next open of that database wait,
// so a blocked part outranks a failed one: it decides whether the app may start.
const worst = (outcomes: WipeOutcome[]): WipeOutcome =>
	outcomes.includes('blocked') ? 'blocked' : outcomes.includes('failed') ? 'failed' : 'done';

const step = async (label: string, run: () => WipeOutcome | Promise<WipeOutcome>): Promise<WipeOutcome> => {
	try {
		return await run();
	} catch (e) {
		console.error(`[wipe] ${label}`, e);
		return 'failed';
	}
};

// Settles at success, failure or the first sign of a connection that does not
// close; the request itself stays queued and finishes once that connection goes.
const deleteDatabase = async (factory: IDBFactory, name: string, waitMs: number): Promise<WipeOutcome> => {
	const deletion = new Promise<WipeOutcome>((resolve) => {
		const req = factory.deleteDatabase(name);
		req.onsuccess = () => resolve('done');
		req.onerror = () => resolve('failed');
		req.onblocked = () => resolve('blocked');
	}).catch((): WipeOutcome => 'failed');
	// Silent past the limit: still queued, or still running on a large database.
	const outcome = await withBudget(deletion, waitMs, 'delete').catch((): WipeOutcome => 'blocked');
	if (outcome !== 'done') console.warn(`[wipe] ${name}: ${outcome}`);
	return outcome;
};

const databases = async (factory: IDBFactory, waitMs: number) => {
	const names = (await factory.databases()).flatMap((db) => (db.name ? [db.name] : []));
	return worst(await Promise.all(names.map((name) => deleteDatabase(factory, name, waitMs))));
};

// An open sync access handle (the collection cache's worker in another tab)
// refuses the removal of its file.
const HELD = new Set(['NoModificationAllowedError', 'InvalidModificationError']);

const fileSystem = async (storage: WipeEnv['storage']) => {
	// No file system here (a private window): nothing to remove.
	const root = await storage?.getDirectory?.().catch(() => undefined);
	if (!root) return 'done';
	const names: string[] = [];
	for await (const name of root.keys()) names.push(name);
	return worst(await Promise.all(names.map(async (name): Promise<WipeOutcome> => {
		try {
			await root.removeEntry(name, { recursive: true });
			return 'done';
		} catch (e) {
			console.warn(`[wipe] file system entry ${name}`, e);
			return HELD.has((e as DOMException)?.name) ? 'blocked' : 'failed';
		}
	})));
};

// Everything but the request itself, which goes once the wipe is done.
const clearLocalStorage = (store: Storage): WipeOutcome => {
	const keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter((key) => key !== null && key !== FLAG);
	for (const key of keys) store.removeItem(key as string);
	return 'done';
};

/**
 * Removes the app's data from this browser. 'blocked' means part of it is
 * still held open, by another tab of the app, or still being removed; 'failed'
 * that the browser refused or could not say what it holds. Never rejects.
 */
export async function wipeDevice(env: WipeEnv = browserEnv()): Promise<WipeOutcome> {
	const { indexedDB: factory, storage, localStorage: local, waitMs = DELETE_WAIT_MS } = env;
	return worst(await Promise.all([
		step('IndexedDB', () => (factory ? databases(factory, waitMs) : 'done')),
		step('file system', () => fileSystem(storage)),
		step('localStorage', () => (local ? clearLocalStorage(local) : 'done')),
	]));
}

/**
 * What the person is asked, resolving true to go ahead:
 * - 'unfinished': a wipe asked for in another tab is pending here. Wipe, or keep what is left?
 * - 'blocked': nothing to choose; the tab reloads to try again once the prompt is closed.
 * - 'failed': try again, or open the app with what is left?
 */
export type WipePrompt = (kind: 'unfinished' | 'blocked' | 'failed') => Promise<boolean>;

/**
 * Runs a requested wipe, and resolves once the app may start: the wipe is
 * done, or the person chose to go on without it. Trying again reloads. While a
 * part is blocked there is no going on: the app's first open of that database
 * would wait behind the queued delete.
 */
export async function finishPendingWipe(prompt: WipePrompt, env: WipeEnv = browserEnv(), reload = () => location.reload()): Promise<void> {
	const { localStorage: local, sessionStorage: session, locks } = env;
	if (!wipePending(local)) return;
	const forget = () => {
		read(() => local?.removeItem(FLAG));
		read(() => session?.removeItem(FLAG));
	};
	const run = async (): Promise<'start' | 'reload'> => {
		// Another tab finished it, or let it go, while this one waited.
		if (!wipePending(local)) return 'start';
		if (read(() => session?.getItem(FLAG)) !== '1' && !(await prompt('unfinished'))) {
			forget();
			return 'start';
		}
		const outcome = await wipeDevice(env);
		if (outcome === 'blocked') {
			await prompt('blocked');
			return 'reload';
		}
		if (outcome === 'failed' && (await prompt('failed'))) return 'reload';
		forget();
		return 'start';
	};
	// One tab at a time: a tab that finished and started must not be wiped under by another.
	const next = locks ? await locks.request(FLAG, run) : await run();
	if (next === 'reload') {
		reload();
		return new Promise(() => {}); // the page goes; nothing may start meanwhile
	}
}

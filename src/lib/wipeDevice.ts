// "Wipe all" on the login page removes what the app's origin keeps in this
// browser: every IndexedDB database, the Origin Private File System and
// localStorage. It runs at the start of the next load, before anything opens a
// database, since the page that asks holds connections it cannot close; the
// app's other tabs are told to end their sessions and reload into it
// (docs/persistence-encryption.md, "Wiping the device").

import { withBudget } from '@/lib/withBudget';
import { refuseOpens } from '@/lib/data/openDatabase';

/**
 * The request, kept until the wipe is done: whichever tab of the app loads next
 * finishes it. Also the name of the lock one tab wipes under, and of the
 * channel the tabs tell each other on.
 */
const FLAG = 'buckitup:wipe';

/** What the other tabs and the service worker are told. */
const WIPE = { type: 'wipe' } as const;

/**
 * How long a delete may wait: for a connection in a tab that was told to go to
 * close as that tab unloads, or behind another pending request on the same
 * database, which gets the delete no event at all until it ends.
 */
const DELETE_WAIT_MS = 3000;

/** How long a tab told to go waits for its session to end before it reloads anyway: well inside the delete's wait. */
const LEAVE_WAIT_MS = 1000;

/**
 * The app's databases, removed by name where the browser cannot list them
 * (`indexedDB.databases()` is missing in Firefox before 126). A store that
 * opens a new database adds its name here; tests/wipeDevice.test.ts checks.
 */
export const APP_DATABASES = [
	'keyval-store', // the vault: idb-keyval's default store
	'buckitup-local-store',
	'buckitup-outbox',
	'buckitup-outbox-leader-lease',
	'buckitup-intents',
	'buckitup-accepted-snapshot',
	'buckitup-own-observed-tails',
	'buckitup-message-projections',
	'dialog-synced-cache',
	'user-synced-cache',
	'buckitup-chunks',
	'buckitup-kept-files',
	'buckitup-pending-uploads',
	'buckitup-upload-reuse',
	'buckitup-avatars',
];

export type WipeOutcome = 'done' | 'blocked' | 'failed';

export type WipeEnv = {
	indexedDB?: IDBFactory;
	storage?: Pick<StorageManager, 'getDirectory'>;
	localStorage?: Storage;
	/** Marks a tab that finishes the wipe without asking again: the one that asked, and those it told to go. */
	sessionStorage?: Storage;
	locks?: Pick<LockManager, 'request'>;
	/** This tab's end of the channel the tabs of the app tell each other about a wipe on. */
	channel?: Pick<BroadcastChannel, 'postMessage' | 'addEventListener'>;
	/** The service worker that plays videos holds their keys in memory. */
	serviceWorker?: Pick<ServiceWorkerContainer, 'controller'>;
	/** How long a delete waits, or a tab told to go waits for its session to end. */
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

// One per page: a channel does not hear its own messages, so the tab that asks is not told to go.
let pageChannel: BroadcastChannel | undefined;

const browserEnv = (): WipeEnv => ({
	indexedDB: read(() => globalThis.indexedDB),
	storage: read(() => globalThis.navigator?.storage),
	localStorage: read(() => globalThis.localStorage),
	sessionStorage: read(() => globalThis.sessionStorage),
	locks: read(() => globalThis.navigator?.locks),
	get channel() {
		return (pageChannel ??= read(() => new BroadcastChannel(FLAG)));
	},
	serviceWorker: read(() => globalThis.navigator?.serviceWorker),
});

// The worker keeps each playing video's key and decrypted chunks until it is
// stopped, and reloading the pages does not stop it.
const tellWorker = (worker: WipeEnv['serviceWorker']) => read(() => worker?.controller?.postMessage(WIPE));

/**
 * Asks for a wipe on the next load, tells the app's other tabs to end their
 * sessions and reload into it, and the service worker to forget the videos it
 * plays. Throws where localStorage is unavailable: nothing would run the wipe.
 */
export const requestWipe = (env: WipeEnv = browserEnv()) => {
	const { localStorage: local, sessionStorage: session } = env;
	if (!local) throw new Error('This browser does not let the app keep a note across a reload, so it cannot wipe itself.');
	local.setItem(FLAG, '1');
	refuseOpens();
	read(() => session?.setItem(FLAG, '1'));
	read(() => env.channel?.postMessage(WIPE));
	tellWorker(env.serviceWorker);
};

/**
 * Makes this tab go when another tab asks for a wipe. Reloading closes what the
 * app cannot close while it runs (the vault's connection, the collection
 * cache's file handle), so the wipe is not blocked by this tab; the tab then
 * finishes the wipe the person asked for without asking again.
 */
export function leaveOnWipe(endSession: () => Promise<unknown>, env: WipeEnv = browserEnv(), reload = () => location.reload()): void {
	const { sessionStorage: session, channel, serviceWorker, waitMs = LEAVE_WAIT_MS } = env;
	let leaving = false;
	channel?.addEventListener('message', (event) => {
		if (leaving || event.data?.type !== WIPE.type) return;
		leaving = true;
		refuseOpens();
		read(() => session?.setItem(FLAG, '1'));
		tellWorker(serviceWorker);
		void withBudget(Promise.resolve().then(endSession), waitMs, 'end session')
			.catch((e) => console.error('[wipe] the session did not end cleanly', e))
			.finally(reload);
	});
}

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

// Settles at success or failure. A `blocked` event is not an answer: the
// request stays queued and finishes once the connection goes, as it does when
// the tab holding it unloads.
const deleteDatabase = async (factory: IDBFactory, name: string, waitMs: number): Promise<WipeOutcome> => {
	const deletion = new Promise<WipeOutcome>((resolve) => {
		const req = factory.deleteDatabase(name);
		req.onsuccess = () => resolve('done');
		req.onerror = () => resolve('failed');
	}).catch((): WipeOutcome => 'failed');
	// Still waiting past the limit: held open, queued, or still running on a large database.
	const outcome = await withBudget(deletion, waitMs, 'delete').catch((): WipeOutcome => 'blocked');
	if (outcome !== 'done') console.warn(`[wipe] ${name}: ${outcome}`);
	return outcome;
};

const databases = async (factory: IDBFactory, waitMs: number) => {
	const names = typeof factory.databases === 'function'
		? (await factory.databases()).flatMap((db) => (db.name ? [db.name] : []))
		: APP_DATABASES;
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
	// This tab's mark goes when no wipe is pending (another tab finished it):
	// a later one must not run here unasked. The request stays: another tab
	// may have just made it.
	const forgetMark = () => read(() => session?.removeItem(FLAG));
	const forget = () => {
		read(() => local?.removeItem(FLAG));
		forgetMark();
	};
	if (!wipePending(local)) {
		forgetMark();
		return;
	}
	const run = async (): Promise<'start' | 'reload'> => {
		// Another tab finished it, or let it go, while this one waited.
		if (!wipePending(local)) {
			forgetMark();
			return 'start';
		}
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

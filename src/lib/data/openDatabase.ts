// How the app's stores open an IndexedDB database. A connection is opened once
// and kept until something else needs the database: on `versionchange` (a
// delete, as "Wipe all" does, or an upgrade, from this tab or another) it
// closes and is forgotten, so it never blocks that request, and the next call
// opens the database again. A failed open is not kept either, unless it is a
// VersionError: a newer build has raised the version, and this one never opens it.

type Upgrade = (db: IDBDatabase) => void;

// A connection belongs to the factory that opened it.
const kept = new WeakMap<IDBFactory, Map<string, Promise<IDBDatabase>>>();

// Once this page asks for a wipe, or is told to go for one, an open would
// create again a database the wipe deletes; the page reloads soon after.
let refusing = false;

/** Every later open in this page rejects. */
export const refuseOpens = (): void => {
	refusing = true;
};

/** For the openers that do not go through openDatabase (the chunk cache). */
export const opensRefused = (): boolean => refusing;

export const _allowOpensForTests = (): void => {
	refusing = false;
};

export function openDatabase(name: string, version: number, upgrade: Upgrade): Promise<IDBDatabase> {
	if (refusing) return Promise.reject(new Error(`IndexedDB: ${name} is not opened, this device is being wiped`));
	let factory: IDBFactory;
	try {
		factory = indexedDB;
		if (!factory) throw new Error('IndexedDB is not available');
	} catch (e) {
		return Promise.reject(e); // no IndexedDB here (node), or storage blocked in the browser's settings
	}
	let open = kept.get(factory);
	if (!open) kept.set(factory, (open = new Map()));
	const known = open.get(name);
	if (known) return known;

	const forget = () => {
		if (open.get(name) === opening) open.delete(name);
	};
	const opening = new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(name, version);
		request.onupgradeneeded = () => upgrade(request.result);
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => {
				db.close();
				forget();
			};
			db.onclose = forget;
			resolve(db);
		};
		request.onerror = () => reject(request.error ?? new Error(`IndexedDB: ${name} could not be opened`));
	});
	open.set(name, opening);
	opening.catch((e) => {
		if ((e as DOMException)?.name !== 'VersionError') forget();
	});
	return opening;
}

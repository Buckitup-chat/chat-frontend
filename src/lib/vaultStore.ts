// The vault libraries (@lo-fi/local-vault, @lo-fi/local-data-lock) keep the
// local accounts in idb-keyval's default store: object store 'keyval' in the
// database 'keyval-store'. idb-keyval creates that store only together with
// the database, so a 'keyval-store' that exists without it is never repaired:
// every vault read and write throws NotFoundError, and no account can be
// opened, created or restored on that browser profile.
//
// The repair has to start before the first vault access. idb-keyval keeps
// its connection open and ignores versionchange, so once it has opened the
// broken database, the upgrade below waits until the page goes away.

const DB = 'keyval-store';
const STORE = 'keyval';
// The longest the repair holds startup: an open queued behind another tab's
// pending upgrade waits for that tab. Vault access queues behind it anyway.
export const STARTUP_WAIT_MS = 3000;

type Probe = { version: number; hasStore: boolean };

// Opens the database (an upgrade creates the store) and closes it again.
// Resolves null when another tab's connection blocks the upgrade: the request
// stays queued and runs once that tab is closed.
const probe = (version?: number) =>
	new Promise<Probe | null>((resolve, reject) => {
		const req = indexedDB.open(DB, version);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
		};
		req.onsuccess = () => {
			const db = req.result;
			resolve({ version: db.version, hasStore: db.objectStoreNames.contains(STORE) });
			db.close();
		};
		req.onerror = () => reject(req.error);
		req.onblocked = () => resolve(null);
	});

async function repair(): Promise<boolean> {
	try {
		const found = await probe();
		if (!found || found.hasStore) return false;
		console.warn(`[vault] database '${DB}' has no '${STORE}' store; creating it`);
		if (await probe(found.version + 1)) return false;
		console.warn('[vault] the repair waits for the other connections to the database to close');
		return true;
	} catch (err) {
		console.error('[vault] storage check failed', err);
		return false;
	}
}

/**
 * Creates the vault store when its database lacks it. Resolves true when
 * the repair waits for another tab to close. Never rejects: startup goes on
 * either way.
 */
export const repairVaultStore = (): Promise<boolean> =>
	Promise.race([repair(), new Promise<boolean>((resolve) => setTimeout(resolve, STARTUP_WAIT_MS, false))]);

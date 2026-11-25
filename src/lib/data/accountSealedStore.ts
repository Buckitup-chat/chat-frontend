// One IndexedDB database of records kept per account: each record is keyed
// `<owner>|<id>` and sealed with its owner's local key, so an account opens
// only its own (docs/invariants.md §1).

import { IndexedDbStore } from './indexedDbStore';
import { createSecureStore, type StringStore } from './secureStore';

type KeyFor = (owner: string) => Promise<CryptoKey>;

export interface AccountSealedStore {
	/** The database as stored: keys in the clear, values sealed. */
	readonly raw: StringStore;
	/** The owner's records, opened with the owner's key; `inner` stands in for `raw` under the seal. */
	sealed(owner: string, inner?: StringStore): StringStore;
	keyOf(owner: string, id: string): string;
	isOwners(owner: string, key: string): boolean;
	/** Removes every record of the account. */
	forgetAccount(owner: string): Promise<void>;
	setForTests(store: StringStore, key?: KeyFor): void;
}

export const accountSealedStore = (dbName: string): AccountSealedStore => {
	let raw: StringStore = new IndexedDbStore(dbName);
	let keyFor: KeyFor = async (owner) => (await import('./localCrypto')).getLocalStorageKeyFor(owner);
	const prefix = (owner: string) => `${owner}|`;
	return {
		get raw() { return raw; },
		sealed: (owner, inner = raw) => createSecureStore(inner, { getKey: () => keyFor(owner) }),
		keyOf: (owner, id) => prefix(owner) + id,
		isOwners: (owner, key) => key.startsWith(prefix(owner)),
		async forgetAccount(owner) {
			for (const key of await raw.keys()) if (key.startsWith(prefix(owner))) await raw.delete(key);
		},
		setForTests(store, key) {
			raw = store;
			if (key) keyFor = key;
		},
	};
};

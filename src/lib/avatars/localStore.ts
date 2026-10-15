// What this device keeps about profile photos, per account, sealed under the
// account's local storage key like the outbox and the intents:
// - a small thumbnail of each contact's current photo, for the lists;
// - the dialogs still owed a delivery of the account's gallery
//   (lib/avatars/delivery): a change or a first message whose dialog could
//   not be read, or whose send did not get stored.
//
// Record names carry the account and contact hashes in the clear — local
// metadata need not be hidden (docs/invariants.md §1) — and let an account's
// records be found and removed with the account.

import { IndexedDbStore } from '@/lib/data/indexedDbStore';
import { createSecureStore, type StringStore } from '@/lib/data/secureStore';
import { serialized } from '@/lib/data/serialized';

let raw: StringStore = new IndexedDbStore('buckitup-avatars');
let keyFor = async (owner: string): Promise<CryptoKey> => (await import('@/lib/data/localCrypto')).getLocalStorageKeyFor(owner);

export const _setAvatarLocalStoreForTests = (store: StringStore, key?: (owner: string) => Promise<CryptoKey>): void => {
	raw = store;
	if (key) keyFor = key;
};

const sealed = (owner: string): StringStore => createSecureStore(raw, { getKey: () => keyFor(owner) });
const prefix = (owner: string) => `${owner}|`;
const thumbKey = (owner: string, peerHash: string) => `${owner}|thumb|${peerHash}`;
const owedKey = (owner: string) => `${owner}|owed`;

export interface StoredThumb {
	avatarId: string;
	/** A small JPEG data URL. */
	thumb: string;
}

export const getThumb = async (owner: string, peerHash: string): Promise<StoredThumb | null> => {
	const value = await sealed(owner).get(thumbKey(owner, peerHash));
	return value ? (JSON.parse(value) as StoredThumb) : null;
};

/** One per contact: a new photo's thumbnail replaces the old one's. */
export const putThumb = (owner: string, peerHash: string, thumb: StoredThumb): Promise<void> =>
	sealed(owner).set(thumbKey(owner, peerHash), JSON.stringify(thumb));

export const forgetThumb = (owner: string, peerHash: string): Promise<void> => raw.delete(thumbKey(owner, peerHash));

/** A dialog owed a delivery: `change` — one or more changes did not reach it; `removed` — ids taken out meanwhile. */
export interface Owed {
	change?: boolean;
	/** Its first message's dialog could not be read: it may need the whole gallery. */
	first?: boolean;
	removed?: string[];
}
export type OwedMap = Record<string, Owed>;

export const loadOwed = async (owner: string): Promise<OwedMap> => {
	const value = await sealed(owner).get(owedKey(owner));
	return value ? (JSON.parse(value) as OwedMap) : {};
};

const owedLocks = new Map<string, Promise<unknown>>();

/** Changes the owed set under a per-account lock, so concurrent deliveries do not drop each other's entries. */
export const updateOwed = (owner: string, change: (owed: OwedMap) => void): Promise<OwedMap> =>
	serialized(owedLocks, owner, async () => {
		const owed = await loadOwed(owner);
		change(owed);
		for (const [peer, entry] of Object.entries(owed)) if (!entry.change && !entry.first) delete owed[peer];
		await sealed(owner).set(owedKey(owner), JSON.stringify(owed));
		return owed;
	});

/** Removes everything kept for an account: called when the account leaves this device. */
export const forgetAccountAvatars = async (owner: string): Promise<void> => {
	for (const key of await raw.keys()) if (key.startsWith(prefix(owner))) await raw.delete(key);
};

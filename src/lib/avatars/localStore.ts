// What this device keeps about profile photos, per account, sealed under the
// account's local storage key like the outbox and the intents:
// - a small thumbnail of each contact's current photo, for the lists;
// - the dialogs given the account's gallery grant (lib/avatars/galleryGrants);
// - each contact's grant and current photo, as last verified.
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
const grantedKey = (owner: string) => `${owner}|granted`;
const peerGrantKey = (owner: string, peerHash: string) => `${owner}|grant|${peerHash}`;
const peerAvatarKey = (owner: string, peerHash: string) => `${owner}|avatar|${peerHash}`;

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

export interface StoredPeerAvatar {
	id: string;
	photo: unknown;
}

export const getPeerAvatar = async (owner: string, peerHash: string): Promise<StoredPeerAvatar | null | undefined> => {
	const value = await sealed(owner).get(peerAvatarKey(owner, peerHash));
	return value ? (JSON.parse(value) as StoredPeerAvatar | null) : undefined;
};

export const putPeerAvatar = (owner: string, peerHash: string, avatar: StoredPeerAvatar | null): Promise<void> =>
	sealed(owner).set(peerAvatarKey(owner, peerHash), JSON.stringify(avatar));

export type GrantedMap = Record<string, string>;

export const loadGranted = async (owner: string): Promise<GrantedMap> => {
	const value = await sealed(owner).get(grantedKey(owner));
	return value ? (JSON.parse(value) as GrantedMap) : {};
};

const grantedLocks = new Map<string, Promise<unknown>>();

export const markGranted = (owner: string, peerHash: string, galleryUuid: string): Promise<void> =>
	serialized(grantedLocks, owner, async () => {
		const granted = await loadGranted(owner);
		granted[peerHash] = galleryUuid;
		await sealed(owner).set(grantedKey(owner), JSON.stringify(granted));
	});

export interface StoredPeerGrant {
	galleryUuid: string;
	galleryKeyB64: string;
	messageId: string;
}

export const getPeerGrant = async (owner: string, peerHash: string): Promise<StoredPeerGrant | null> => {
	const value = await sealed(owner).get(peerGrantKey(owner, peerHash));
	return value ? (JSON.parse(value) as StoredPeerGrant) : null;
};

export const putPeerGrant = (owner: string, peerHash: string, grant: StoredPeerGrant): Promise<void> =>
	sealed(owner).set(peerGrantKey(owner, peerHash), JSON.stringify(grant));

/** Removes everything kept for an account: called when the account leaves this device. */
export const forgetAccountAvatars = async (owner: string): Promise<void> => {
	for (const key of await raw.keys()) if (key.startsWith(prefix(owner))) await raw.delete(key);
};

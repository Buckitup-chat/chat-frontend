import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { ChangeMessage, WithVirtualProps } from "@tanstack/db";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { UserCardFields, UserStorageFields, QueueEntry } from "./userQueue";

type UserCardRow = UserCardFields & Record<string, unknown>;
type UserStorageRow = UserStorageFields & Record<string, unknown>;

import {
  pendingUserCardsCollection,
  pendingUserStorageCollection,
  putPendingUserCard,
  putPendingUserStorage,
  ensureRehydrated,
  flushPendingUserChanges,
  setUserAuthProvider,
  triggerUserFlush,
  setRemoteReaders,
  checkAllAwaitingRemote,
  removeSupersededLegacyStorageEntry,
  purgeUserQueueEntries,
} from "./userQueue";
import {
  cachedUserCardsCollection,
  cachedUserStorageCollection,
  recordSynced,
  forgetSynced,
  ensureCacheHydrated,
  isCacheHydrated,
  purgeUserCacheEntries,
} from "./userCache";

const absUrl = (p: string) => {
  const u = `${ELECTRIC_API_URL}${p}`;
  return u.startsWith("http") ? u : `${location.origin}${u}`;
};

const storageKey = (userHash: string, uuid: string)=> `${userHash}:${uuid}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown) {
  return typeof value === "string" && UUID_RE.test(value);
}

export function deriveStorageUuid(logicalUuid: string) {
  if (isValidUuid(logicalUuid)) return logicalUuid;
  const hash = sha256(new TextEncoder().encode(`user_storage:${logicalUuid}`));
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8 (custom, RFC 9562)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const userCardsCollection = createCollection(
  electricCollectionOptions<UserCardRow>({
    id: "user_cards",
    shapeOptions: {
      url: absUrl("/user_card"),
      params: { table: "user_cards" },
    },
    getKey: (item) => item.user_hash,
  })
);

export const userStorageCollection = createCollection(
  electricCollectionOptions<UserStorageRow>({
    id: "user_storage",
    shapeOptions: {
      url: absUrl("/user_storage"),
      params: { table: "user_storage" },
    },
    getKey: (item) => storageKey(item.user_hash, item.uuid),
  })
);

export const previewUserCardsCollection = createCollection(
  localOnlyCollectionOptions<UserCardFields>({
    id: "user_cards_preview",
    getKey: (item) => item.user_hash,
  })
);

export function previewUserCard(card: UserCardFields | null | undefined) {
  if (!card?.user_hash) return;
  if (previewUserCardsCollection.has(card.user_hash)) {
    previewUserCardsCollection.update(card.user_hash, (draft) => Object.assign(draft, card));
  } else {
    previewUserCardsCollection.insert(card);
  }
}

export function clearPreviewOnAuthoritativeEvent(key: string) {
  if (previewUserCardsCollection.has(key)) previewUserCardsCollection.delete(key);
}

export async function purgeUserData(userHash: string) {
  if (!userHash) return { queueRemoved: 0, cacheRemoved: 0 };
  if (previewUserCardsCollection.has(userHash)) previewUserCardsCollection.delete(userHash);
  const { removed: cacheRemoved } = purgeUserCacheEntries(userHash);
  const { removed: queueRemoved } = await purgeUserQueueEntries(userHash);
  return { queueRemoved, cacheRemoved };
}

export {
  cachedUserCardsCollection,
  cachedUserStorageCollection,
  isCacheHydrated,
  pendingUserCardsCollection,
  pendingUserStorageCollection,
  flushPendingUserChanges,
  setUserAuthProvider,
  triggerUserFlush,
};

setRemoteReaders({
  user_cards: {
    get: (key) => userCardsCollection.get(key),
    isReady: () => userCardsCollection.status === "ready",
  },
  user_storage: {
    get: (key) => userStorageCollection.get(key),
    isReady: () => userStorageCollection.status === "ready",
  },
});

type UserCardChange = ChangeMessage<WithVirtualProps<UserCardRow, string | number>, string | number>;
type UserStorageChange = ChangeMessage<WithVirtualProps<UserStorageRow, string | number>, string | number>;

export function handleUserCardChanges(changes: UserCardChange[]) {
  for (const change of changes) {
    const key = String(change.key);
    clearPreviewOnAuthoritativeEvent(key);
    if (change.type === "delete") forgetSynced("user_cards", key);
    else recordSynced("user_cards", key, change.value);
  }
  checkAllAwaitingRemote("user_cards");
}

userCardsCollection.subscribeChanges(handleUserCardChanges, { includeInitialState: true });

const LEGACY_STORAGE_SLOTS = ["profile", "contacts"];

export function handleUserStorageChanges(changes: UserStorageChange[]) {
  const pending: Array<Promise<unknown>> = [];
  for (const change of changes) {
    const key = String(change.key);
    if (change.type === "delete") {
      forgetSynced("user_storage", key);
      continue;
    }
    recordSynced("user_storage", key, change.value);
    const userHash = change.value?.user_hash;
    const physicalUuid = change.value?.uuid;
    if (userHash && physicalUuid) {
      for (const logicalUuid of LEGACY_STORAGE_SLOTS) {
        if (physicalUuid === deriveStorageUuid(logicalUuid)) {
          pending.push(removeSupersededLegacyStorageEntry(userHash, logicalUuid));
        }
      }
    }
  }
  pending.push(checkAllAwaitingRemote("user_storage"));
  return Promise.all(pending);
}

userStorageCollection.subscribeChanges(handleUserStorageChanges, { includeInitialState: true });

async function ready() {
  userCardsCollection.preload().then(() => triggerUserFlush());
  await Promise.all([ensureRehydrated(), ensureCacheHydrated()]);
}

async function storageReady() {
  userStorageCollection.preload().then(() => triggerUserFlush());
  await Promise.all([ensureRehydrated(), ensureCacheHydrated()]);
}

export async function getUsers() {
  await ready();

  const byHash = new Map<string, UserCardFields>();

  for (const u of cachedUserCardsCollection.toArray) byHash.set(u.user_hash, u);
  for (const u of previewUserCardsCollection.toArray) byHash.set(u.user_hash, u);
  for (const u of userCardsCollection.toArray) byHash.set(u.user_hash, u);
  for (const u of pendingUserCardsCollection.toArray) byHash.set(u.user_hash, u);

  const result = Array.from(byHash.values()).filter((u) => !u.deleted_flag);
  result.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return result;
}

export async function getUser(userHash: string) {
  await ready();
  const user =
    pendingUserCardsCollection.get(userHash) ||
    userCardsCollection.get(userHash) ||
    previewUserCardsCollection.get(userHash) ||
    cachedUserCardsCollection.get(userHash);
  return user && !user.deleted_flag ? user : null;
}

export async function getUserStorage(userHash: string, uuid: string) {
  await storageReady();
  const physicalUuid = deriveStorageUuid(uuid);
  const key = storageKey(userHash, physicalUuid);
  const record = pendingUserStorageCollection.get(key) || userStorageCollection.get(key) || cachedUserStorageCollection.get(key);
  if (!record || record.deleted_flag) return null;
  return { ...record, uuid };
}

export async function upsertUser(user: Partial<UserCardFields> & { user_hash: string }) {
  if (!user?.user_hash) throw new Error("upsertUser: user_hash is required");

  await ready();
  const key = user.user_hash;
  const base = pendingUserCardsCollection.get(key) || userCardsCollection.get(key) || previewUserCardsCollection.get(key) || cachedUserCardsCollection.get(key);
  const merged: UserCardFields = { deleted_flag: false, ...base, ...user };

  return putPendingUserCard(merged, user);
}

export interface UpsertUserStorageInput {
  userHash: string;
  uuid: string;
  valueB64?: string | null;
  hashB64?: string | null;
  deletedFlag?: boolean;
  parentSignHash?: string | null;
  signHash?: string | null;
  ownerTimestamp?: number | null;
  signB64?: string | null;
}

export async function upsertUserStorage(record: UpsertUserStorageInput) {
  const { userHash, uuid, valueB64, hashB64 = null, deletedFlag = false, parentSignHash = null, signHash = null, ownerTimestamp = null, signB64 = null } = record;

  if (!userHash || !uuid) {
    throw new Error("upsertUserStorage: userHash and uuid are required");
  }

  await storageReady();
  const physicalUuid = deriveStorageUuid(uuid);
  const key = storageKey(userHash, physicalUuid);
  const base = pendingUserStorageCollection.get(key) || userStorageCollection.get(key) || cachedUserStorageCollection.get(key);
  const version = base ? Number(base.version) + 1 : 0;

  const merged: UserStorageFields = {
    user_hash: userHash,
    uuid: physicalUuid,
    version,
    value_b64: valueB64,
    hash_b64: hashB64,
    deleted_flag: deletedFlag,
    parent_sign_hash: parentSignHash,
    sign_hash: signHash,
    owner_timestamp: ownerTimestamp || Math.floor(Date.now() / 1000),
    sign_b64: signB64,
  };

  return putPendingUserStorage(merged);
}

import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import { ref, type Ref } from "vue";
import type { UserTable, UserCardFields, UserStorageFields, UserRecordFields } from "./userQueue";

const DB_NAME = "user-synced-cache";
const DB_VERSION = 1;
const STORE_NAMES: Record<UserTable, string> = { user_cards: "user_cards", user_storage: "user_storage" };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORE_NAMES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: "__key" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.error("[userCache] Failed to open IndexedDB:", req.error);
      resolve(null);
    };
  });
  return dbPromise;
}

async function withStore<T>(table: UserTable, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => T | Promise<T>): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES[table], mode);
    const store = tx.objectStore(STORE_NAMES[table]);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const cachedUserCardsCollection = createCollection(
  localOnlyCollectionOptions<UserCardFields>({
    id: "user_cards_cache",
    getKey: (item) => item.user_hash,
  })
);

export const cachedUserStorageCollection = createCollection(
  localOnlyCollectionOptions<UserStorageFields>({
    id: "user_storage_cache",
    getKey: (item) => `${item.user_hash}:${item.uuid}`,
  })
);

function collectionFor(table: UserTable) {
  return table === "user_cards" ? cachedUserCardsCollection : cachedUserStorageCollection;
}

function applyToCache(table: UserTable, key: string, record: UserRecordFields) {
  const collection = collectionFor(table) as unknown as Collection<UserRecordFields>;
  if (collection.has(key)) {
    collection.update(key, (draft) => Object.assign(draft, record));
  } else {
    collection.insert(record);
  }
}

const touchedKeys = new Set<string>();

export function recordSynced(table: UserTable, key: string, record: UserRecordFields) {
  touchedKeys.add(`${table}:${key}`);
  applyToCache(table, key, record);
  withStore(table, "readwrite", (store) => store.put({ ...record, __key: key })).catch((err) => {
    console.error(`[userCache] Failed to persist ${table}:${key}`, err);
  });
}

export function forgetSynced(table: UserTable, key: string) {
  touchedKeys.add(`${table}:${key}`);
  const collection = collectionFor(table) as unknown as Collection<UserRecordFields>;
  if (collection.has(key)) collection.delete(key);
  withStore(table, "readwrite", (store) => store.delete(key)).catch(() => {});
}

export function purgeUserCacheEntries(userHash: string) {
  if (!userHash) return { removed: 0 };
  let removed = 0;
  for (const table of Object.keys(STORE_NAMES) as UserTable[]) {
    const collection = collectionFor(table) as unknown as Collection<UserRecordFields>;
    const keysToRemove = collection.toArray
      .filter((record) => record.user_hash === userHash)
      .map((record) => (table === "user_cards" ? record.user_hash : `${record.user_hash}:${record.uuid}`));
    for (const key of keysToRemove) {
      forgetSynced(table, key);
      removed++;
    }
  }
  return { removed };
}

export const isCacheHydrated: Ref<boolean> = ref(false);

let rehydratePromise: Promise<void> | null = null;

interface CachedRow extends UserRecordFields {
  __key: string;
}

export function ensureCacheHydrated() {
  if (!rehydratePromise) {
    rehydratePromise = (async () => {
      for (const table of Object.keys(STORE_NAMES) as UserTable[]) {
        const all = (await withStore<CachedRow[]>(table, "readonly", (store) => reqToPromise(store.getAll()))) || [];
        for (const record of all) {
          const { __key, ...rest } = record;
          if (touchedKeys.has(`${table}:${__key}`)) continue;
          applyToCache(table, __key, rest);
        }
      }
      isCacheHydrated.value = true;
    })().catch((err) => {
      console.error("[userCache] Rehydration failed:", err);
      isCacheHydrated.value = true;
    });
  }
  return rehydratePromise;
}

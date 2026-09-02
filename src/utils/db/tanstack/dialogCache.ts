import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import { ref, type Ref } from "vue";
import type { DialogKeysFields, DialogMessageFields, DialogReactionFields, DialogReceiptFields, DialogRecordFields, DialogRecordByTable } from "./dialogQueue";
import { DIALOG_TABLES, type DialogTable } from "./dialogQueue";

const DB_NAME = "dialog-synced-cache";
const DB_VERSION = 2;

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
      for (const table of DIALOG_TABLES) {
        if (!db.objectStoreNames.contains(table)) {
          db.createObjectStore(table, { keyPath: "__key" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.error("[dialogCache] Failed to open IndexedDB:", req.error);
      resolve(null);
    };
  });
  return dbPromise;
}

async function withStore<T>(table: DialogTable, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => T | Promise<T>): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, mode);
    const store = tx.objectStore(table);
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

export const cachedDialogKeysCollection = createCollection(
  localOnlyCollectionOptions<DialogKeysFields>({ id: "dialog_keys_cache", getKey: (item) => `${item.dialog_hash}:${item.sender_hash}` })
);
export const cachedDialogMessagesCollection = createCollection(
  localOnlyCollectionOptions<DialogMessageFields>({ id: "dialog_messages_cache", getKey: (item) => item.message_id })
);
export const cachedDialogMessageVersionsCollection = createCollection(
  localOnlyCollectionOptions<DialogMessageFields & { sign_hash: string }>({
    id: "dialog_messages_versions_cache",
    getKey: (item) => `${item.message_id}:${item.sign_hash}`,
  })
);
export const cachedDialogReactionsCollection = createCollection(
  localOnlyCollectionOptions<DialogReactionFields>({ id: "dialog_message_reactions_cache", getKey: (item) => item.reaction_hash })
);
export const cachedDialogReceiptsCollection = createCollection(
  localOnlyCollectionOptions<DialogReceiptFields>({ id: "dialog_message_receipts_cache", getKey: (item) => item.receipt_hash })
);

type CacheCollectionMap = {
  [T in DialogTable]: Collection<DialogRecordByTable[T]>;
};

const cacheCollections: CacheCollectionMap = {
  dialog_keys: cachedDialogKeysCollection,
  dialog_messages: cachedDialogMessagesCollection,
  dialog_messages_versions: cachedDialogMessageVersionsCollection,
  dialog_message_reactions: cachedDialogReactionsCollection,
  dialog_message_receipts: cachedDialogReceiptsCollection,
};

function collectionFor<T extends DialogTable>(table: T): Collection<DialogRecordByTable[T]> {
  return cacheCollections[table];
}

function applyToCache(table: DialogTable, key: string, record: DialogRecordFields) {
  const collection = collectionFor(table) as Collection<DialogRecordFields>;
  if (collection.has(key)) {
    collection.update(key, (draft: DialogRecordFields) => Object.assign(draft, record));
  } else {
    collection.insert(record);
  }
}

const touchedKeys = new Set<string>();

type CachedRecord = DialogRecordFields & { __awaitingEcho?: boolean; __ignoreEchoSignHash?: string };

export function stripCacheMetadata<T extends DialogRecordFields>(record: T | null | undefined): T | null | undefined {
  if (!record || (!("__awaitingEcho" in record) && !("__ignoreEchoSignHash" in record))) return record;
  const rest = { ...(record as T & { __awaitingEcho?: boolean; __ignoreEchoSignHash?: string }) };
  delete rest.__awaitingEcho;
  delete rest.__ignoreEchoSignHash;
  return rest as T;
}

export function isStaleEchoOfRejectedEdit(table: DialogTable, key: string, incomingSignHash: string | null | undefined): boolean {
  if (!incomingSignHash) return false;
  const row = collectionFor(table).get(key) as CachedRecord | undefined;
  return row?.__ignoreEchoSignHash === incomingSignHash;
}

export function recordSynced(
  table: DialogTable,
  key: string,
  record: DialogRecordFields,
  awaitingEcho = false,
  ignoreEchoSignHash?: string
): Promise<void> {
  touchedKeys.add(`${table}:${key}`);
  const stamped: CachedRecord = { ...record, __awaitingEcho: awaitingEcho, __ignoreEchoSignHash: ignoreEchoSignHash };
  applyToCache(table, key, stamped);
  return withStore(table, "readwrite", (store) => store.put({ ...stamped, __key: key })).then(
    () => undefined,
    (err) => {
      console.error(`[dialogCache] Failed to persist ${table}:${key}`, err);
      throw err;
    }
  );
}

export function forgetSynced(table: DialogTable, key: string) {
  touchedKeys.add(`${table}:${key}`);
  const collection = collectionFor(table);
  if (collection.has(key)) collection.delete(key);
  withStore(table, "readwrite", (store) => store.delete(key)).catch(() => {});
}

export const isDialogCacheHydrated: Ref<boolean> = ref(false);

let rehydratePromise: Promise<void> | null = null;

interface CachedRow extends DialogRecordFields {
  __key: string;
}

export function ensureDialogCacheHydrated() {
  if (!rehydratePromise) {
    rehydratePromise = (async () => {
      for (const table of DIALOG_TABLES) {
        const all = (await withStore<CachedRow[]>(table, "readonly", (store) => reqToPromise(store.getAll()))) || [];
        for (const record of all) {
          const { __key, ...rest } = record;
          if (touchedKeys.has(`${table}:${__key}`)) continue;
          applyToCache(table, __key, rest);
        }
      }
      isDialogCacheHydrated.value = true;
    })().catch((err) => {
      console.error("[dialogCache] Rehydration failed:", err);
      isDialogCacheHydrated.value = true;
    });
  }
  return rehydratePromise;
}

export function resetCacheRehydration() {
  rehydratePromise = null;
}

import { createBrowserWASQLitePersistence, openBrowserWASQLiteOPFSDatabase } from "@tanstack/browser-db-sqlite-persistence";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";
import type { CollectionConfig, SyncConfig, UtilsRecord } from "@tanstack/db";

const DB_NAME = "buckitup-electric-sync";

let persistence: PersistedCollectionPersistence | null = null;

function hasOpfsSupport(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function" && typeof Worker === "function";
}

async function init(): Promise<void> {
  if (!hasOpfsSupport()) {
    console.warn(
      "[electricPersistence] OPFS/Worker not available in this browser — Electric collections will run without local SQLite persistence (full shape re-sync on every reload)."
    );
    return;
  }
  try {
    const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: DB_NAME });
    persistence = createBrowserWASQLitePersistence({ database });
  } catch (err) {
    console.warn("[electricPersistence] failed to initialize SQLite/OPFS persistence — falling back to non-persisted Electric sync", err);
    persistence = null;
  }
}

export const electricPersistenceReady = init();

type SyncedCollectionOptions<T extends object, TKey extends string | number, TUtils extends UtilsRecord> = CollectionConfig<T, TKey, never, TUtils> & {
  sync: SyncConfig<T, TKey>;
};

export function withElectricPersistence<T extends object, TKey extends string | number, TUtils extends UtilsRecord>(
  options: SyncedCollectionOptions<T, TKey, TUtils>,
  schemaVersion = 1
): SyncedCollectionOptions<T, TKey, TUtils> {
  if (!persistence) return options;
  return persistedCollectionOptions<T, TKey, never, TUtils>({ ...options, persistence, schemaVersion });
}

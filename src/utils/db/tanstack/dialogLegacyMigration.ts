import type { DialogTable, DialogRecordFields } from "./dialogQueue";
import { importLegacyPendingEntry, triggerDialogFlush } from "./dialogQueue";
import { importLegacyCachedEntry } from "./dialogCache";

const DEFAULT_LEGACY_PGLITE_IDB_NAME = "electric-sync-data-v5";
const DEFAULT_STATUS_DB_NAME = "dialog-legacy-migration";

export interface LegacyTableSpec {
  table: DialogTable;
  pk: string[];
  keyOf: (row: Record<string, unknown>) => string | null;
  columns: string[];
}

export const LEGACY_TABLES: LegacyTableSpec[] = [
  {
    table: "dialog_keys",
    pk: ["dialog_hash", "sender_hash"],
    keyOf: (r) => (r.dialog_hash && r.sender_hash ? `${r.dialog_hash}:${r.sender_hash}` : null),
    columns: ["dialog_hash", "sender_hash", "peer_hash", "peer_kem_wrap_key_b64", "peer_wrapped_msg_key_b64", "owner_timestamp", "deleted_flag", "sign_b64"],
  },
  {
    table: "dialog_messages",
    pk: ["message_id"],
    keyOf: (r) => (r.message_id ? String(r.message_id) : null),
    columns: ["message_id", "dialog_hash", "sender_hash", "content_b64", "deleted_flag", "refs_map_b64", "parent_sign_hash", "owner_timestamp", "sign_b64", "sign_hash"],
  },
  {
    table: "dialog_messages_versions",
    pk: ["message_id", "sign_hash"],
    keyOf: (r) => (r.message_id && r.sign_hash ? `${r.message_id}:${r.sign_hash}` : null),
    columns: [
      "message_id",
      "sign_hash",
      "dialog_hash",
      "sender_hash",
      "content_b64",
      "deleted_flag",
      "refs_map_b64",
      "parent_sign_hash",
      "owner_timestamp",
      "sign_b64",
    ],
  },
  {
    table: "dialog_message_reactions",
    pk: ["reaction_hash"],
    keyOf: (r) => (r.reaction_hash ? String(r.reaction_hash) : null),
    columns: ["reaction_hash", "dialog_hash", "message_id", "message_sign_hash", "reactor_hash", "type_b64", "deleted_flag", "owner_timestamp", "sign_b64"],
  },
  {
    table: "dialog_message_receipts",
    pk: ["receipt_hash"],
    keyOf: (r) => (r.receipt_hash ? String(r.receipt_hash) : null),
    columns: ["receipt_hash", "dialog_hash", "message_id", "peer_hash", "type", "message_sign_hash", "owner_timestamp", "sign_b64"],
  },
];

function bestEffortOwner(row: Record<string, unknown>): string {
  const candidate = row.sender_hash ?? row.reactor_hash ?? row.peer_hash;
  return typeof candidate === "string" && candidate ? candidate : "legacy-migration";
}

interface MigrationStatusRecord {
  id: "legacy-pglite-v1";
  completedAt: number;
  importedPending: number;
  importedCached: number;
  skippedMalformed: number;
}

const STATUS_DB_VERSION = 1;
const STATUS_STORE = "status";
const STATUS_KEY = "legacy-pglite-v1";

function openStatusDb(statusDbName: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(statusDbName, STATUS_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STATUS_STORE)) db.createObjectStore(STATUS_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.error("[dialogLegacyMigration] Failed to open status DB:", req.error);
      resolve(null);
    };
  });
}

async function readMigrationStatus(statusDbName: string): Promise<MigrationStatusRecord | undefined> {
  const db = await openStatusDb(statusDbName);
  if (!db) return undefined;
  return new Promise((resolve) => {
    const tx = db.transaction(STATUS_STORE, "readonly");
    const req = tx.objectStore(STATUS_STORE).get(STATUS_KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

async function writeMigrationComplete(statusDbName: string, record: MigrationStatusRecord): Promise<void> {
  const db = await openStatusDb(statusDbName);
  if (!db) throw new Error("[dialogLegacyMigration] status DB unavailable — cannot durably record completion");
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STATUS_STORE, "readwrite");
    tx.objectStore(STATUS_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("[dialogLegacyMigration] status write aborted"));
  });
}

async function legacyDatabaseMightExist(legacyIdbName: string): Promise<boolean> {
  try {
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return true;
    const dbs = await indexedDB.databases();
    return dbs.some((d) => d.name === `/pglite/${legacyIdbName}` || d.name === legacyIdbName || d.name?.includes(legacyIdbName));
  } catch {
    return true;
  }
}

export interface ImportOutcome {
  importedPending: number;
  importedCached: number;
  alreadyPresent: number;
  skippedMalformed: number;
}

export async function importLegacyRows(spec: LegacyTableSpec, rows: Record<string, unknown>[]): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { importedPending: 0, importedCached: 0, alreadyPresent: 0, skippedMalformed: 0 };

  for (const row of rows) {
    const key = spec.keyOf(row);
    if (!key) {
      outcome.skippedMalformed++;
      console.warn(`[dialogLegacyMigration] Skipping malformed ${spec.table} row (missing ${spec.pk.join("/")}):`, JSON.stringify(row));
      continue;
    }

    const record: DialogRecordFields = {};
    for (const col of spec.columns) {
      if (col in row) (record as Record<string, unknown>)[col] = row[col];
    }

    const isPending = row.modified_columns !== null;
    if (isPending) {
      const result = await importLegacyPendingEntry(spec.table, key, record, bestEffortOwner(row));
      if (result === "imported") outcome.importedPending++;
      else outcome.alreadyPresent++;
    } else {
      const result = await importLegacyCachedEntry(spec.table, key, record);
      if (result === "imported") outcome.importedCached++;
      else outcome.alreadyPresent++;
    }
  }

  return outcome;
}

async function importTable(db: InstanceType<typeof import("@electric-sql/pglite").PGlite>, spec: LegacyTableSpec): Promise<ImportOutcome> {
  let rows: Record<string, unknown>[];
  try {
    const result = await db.query<Record<string, unknown>>(`SELECT * FROM ${spec.table}`);
    rows = result.rows;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/relation .* does not exist/i.test(message)) return { importedPending: 0, importedCached: 0, alreadyPresent: 0, skippedMalformed: 0 };
    throw err;
  }

  return importLegacyRows(spec, rows);
}

export interface MigrationResult {
  ran: boolean;
  importedPending: number;
  importedCached: number;
  alreadyPresent: number;
  skippedMalformed: number;
}

export interface MigrationOptions {
  legacyIdbName?: string;
  statusDbName?: string;
}

let migrationPromise: Promise<MigrationResult> | null = null;

export function migrateLegacyDialogState(options?: MigrationOptions): Promise<MigrationResult> {
  if (!migrationPromise) migrationPromise = runMigration(options);
  return migrationPromise;
}

async function runMigration(options?: MigrationOptions): Promise<MigrationResult> {
  const legacyIdbName = options?.legacyIdbName ?? DEFAULT_LEGACY_PGLITE_IDB_NAME;
  const statusDbName = options?.statusDbName ?? DEFAULT_STATUS_DB_NAME;

  const already = await readMigrationStatus(statusDbName);
  if (already) return { ran: false, importedPending: 0, importedCached: 0, alreadyPresent: 0, skippedMalformed: 0 };

  if (!(await legacyDatabaseMightExist(legacyIdbName))) {
    await writeMigrationComplete(statusDbName, { id: STATUS_KEY, completedAt: Date.now(), importedPending: 0, importedCached: 0, skippedMalformed: 0 });
    return { ran: true, importedPending: 0, importedCached: 0, alreadyPresent: 0, skippedMalformed: 0 };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  let db: InstanceType<typeof PGlite> | null = null;
  try {
    db = new PGlite(`idb://${legacyIdbName}`);
    await db.waitReady;

    let importedPending = 0;
    let importedCached = 0;
    let alreadyPresent = 0;
    let skippedMalformed = 0;
    for (const spec of LEGACY_TABLES) {
      const outcome = await importTable(db, spec);
      importedPending += outcome.importedPending;
      importedCached += outcome.importedCached;
      alreadyPresent += outcome.alreadyPresent;
      skippedMalformed += outcome.skippedMalformed;
    }

    await writeMigrationComplete(statusDbName, { id: STATUS_KEY, completedAt: Date.now(), importedPending, importedCached, skippedMalformed });

    console.log(`[dialogLegacyMigration] Migrated ${importedPending} legacy pending row(s) and ${importedCached} legacy synced row(s) (${alreadyPresent} already present, ${skippedMalformed} malformed/skipped)`);
    if (importedPending > 0) triggerDialogFlush();

    return { ran: true, importedPending, importedCached, alreadyPresent, skippedMalformed };
  } catch (err) {
    console.error("[dialogLegacyMigration] Migration failed — will retry on next load:", err);
    migrationPromise = null;
    throw err;
  } finally {
    await db?.close().catch(() => {});
  }
}

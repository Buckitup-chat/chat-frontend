import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import { ref, type Ref } from "vue";
import { sha3_512 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { api } from "../../../api/client";
import type { ApiMutation } from "../../../api/client";
import { MutationType } from "@/api/client";

export const DIALOG_TABLES = [
  "dialog_keys",
  "dialog_messages",
  "dialog_messages_versions",
  "dialog_message_reactions",
  "dialog_message_receipts",
] as const;

export type DialogTable = (typeof DIALOG_TABLES)[number];

export type EntryStatus = "pending" | "quarantined";

export interface DialogKeysFields {
  dialog_hash: string;
  sender_hash: string;
  peer_hash?: string | null;
  peer_kem_wrap_key_b64?: string | null;
  peer_wrapped_msg_key_b64?: string | null;
  owner_timestamp?: number | bigint | null;
  deleted_flag?: boolean;
  sign_b64?: string | null;
}

export interface DialogMessageFields {
  message_id: string;
  dialog_hash?: string;
  sender_hash?: string;
  content_b64?: string | null;
  deleted_flag?: boolean;
  refs_map_b64?: string | null;
  parent_sign_hash?: string | null;
  owner_timestamp?: number | bigint | null;
  sign_b64?: string | null;
  sign_hash?: string | null;
}

export interface DialogReactionFields {
  reaction_hash: string;
  dialog_hash?: string;
  message_id: string;
  message_sign_hash?: string | null;
  reactor_hash?: string;
  type_b64?: string | null;
  deleted_flag?: boolean;
  owner_timestamp?: number | bigint | null;
  sign_b64?: string | null;
}

export interface DialogReceiptFields {
  receipt_hash: string;
  dialog_hash?: string;
  message_id: string;
  peer_hash?: string;
  type?: string;
  message_sign_hash?: string | null;
  owner_timestamp?: number | bigint | null;
  sign_b64?: string | null;
}

export type DialogRecordByTable = {
  dialog_keys: DialogKeysFields;
  dialog_messages: DialogMessageFields;
  dialog_messages_versions: DialogMessageFields & { sign_hash: string };
  dialog_message_reactions: DialogReactionFields;
  dialog_message_receipts: DialogReceiptFields;
};

export interface DialogRecordFields {
  dialog_hash?: string | null;
  sender_hash?: string | null;
  peer_hash?: string | null;
  peer_kem_wrap_key_b64?: string | null;
  peer_wrapped_msg_key_b64?: string | null;
  message_id?: string | null;
  content_b64?: string | null;
  refs_map_b64?: string | null;
  parent_sign_hash?: string | null;
  reaction_hash?: string | null;
  message_sign_hash?: string | null;
  reactor_hash?: string | null;
  type_b64?: string | null;
  receipt_hash?: string | null;
  type?: string | null;
  owner_timestamp?: number | bigint | null;
  deleted_flag?: boolean;
  sign_b64?: string | null;
  sign_hash?: string | null;
}

export interface QueueEntry {
  id: string;
  table: DialogTable;
  key: string;
  ownerUserHash: string;
  record: DialogRecordFields;
  patch: Partial<DialogRecordFields>;
  status: EntryStatus;
  revision: number;
  sentSnapshot: DialogRecordFields | null;
  sentRevision: number | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  lastError: string | null;
}

const DB_NAME = "dialog-pending-queue";
const DB_VERSION = 1;
const STORE_NAME = "pending";

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
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.error("[dialogQueue] Failed to open IndexedDB:", req.error);
      resolve(null);
    };
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(): Promise<QueueEntry[]> {
  return (await withTransaction("readonly", (store) => reqToPromise(store.getAll()))) || [];
}

async function dbGet(id: string): Promise<QueueEntry | undefined> {
  return withTransaction("readonly", (store) => reqToPromise(store.get(id)));
}

type AtomicOutcome = { action: "put"; entry: QueueEntry } | { action: "delete" } | { action: "noop" };

interface AtomicResult {
  current: QueueEntry | undefined;
  outcome: AtomicOutcome;
}

function withTransaction<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore, tx: IDBTransaction) => T | Promise<T>) {
  return openDb().then((db) => {
    if (!db) return undefined as T;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let settled = false;
      let result: T;

      try {
        Promise.resolve(fn(store, tx))
          .then((value) => {
            result = value;
          })
          .catch((err) => {
            if (settled) return;
            settled = true;
            try {
              tx.abort();
            } catch {
              console.error(err);
            }
            reject(err);
          });
      } catch (err) {
        settled = true;
        try {
          tx.abort();
        } catch {
          console.error(err);
        }
        reject(err);
        return;
      }
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      tx.onerror = () => {
        if (settled) return;
        settled = true;
        reject(tx.error);
      };
      tx.onabort = () => {
        if (settled) return;
        settled = true;
        reject(tx.error || new Error("[dialogQueue] transaction aborted"));
      };
    });
  });
}

async function atomicMutate(id: string, mutator: (current: QueueEntry | undefined) => AtomicOutcome): Promise<AtomicResult> {
  return withTransaction("readwrite", (store) => {
    return new Promise<AtomicResult>((resolve, reject) => {
      const getReq: IDBRequest<QueueEntry | undefined> = store.get(id);
      getReq.onerror = () => reject(getReq.error);
      getReq.onsuccess = () => {
        const current = getReq.result;
        let outcome: AtomicOutcome;
        try {
          outcome = mutator(current);
        } catch (err) {
          reject(err);
          return;
        }
        if (outcome.action === "put") {
          const putReq = store.put(outcome.entry);
          putReq.onerror = () => reject(putReq.error);
          putReq.onsuccess = () => resolve({ current, outcome });
        } else if (outcome.action === "delete") {
          const delReq = store.delete(id);
          delReq.onerror = () => reject(delReq.error);
          delReq.onsuccess = () => resolve({ current, outcome });
        } else {
          resolve({ current, outcome: { action: "noop" } });
        }
      };
    });
  }) as Promise<AtomicResult>;
}

export interface QueueStatus {
  pending: number;
  quarantined: number;
  flushing: boolean;
  backoffUntil: number;
}

export const queueStatus: Ref<QueueStatus> = ref({
  pending: 0,
  quarantined: 0,
  flushing: false,
  backoffUntil: 0,
});

function transitionStatus(oldStatus: EntryStatus | null | undefined, newStatus: EntryStatus | null) {
  if (oldStatus === newStatus) return;
  const next = { ...queueStatus.value };
  if (oldStatus) next[oldStatus] = Math.max(0, next[oldStatus] - 1);
  if (newStatus) next[newStatus] += 1;
  queueStatus.value = next;
}

function keyFor(table: DialogTable, record: DialogRecordFields): string {
  switch (table) {
    case "dialog_keys":
      return `${record.dialog_hash}:${record.sender_hash}`;
    case "dialog_messages":
      return String(record.message_id);
    case "dialog_messages_versions":
      return `${record.message_id}:${record.sign_hash}`;
    case "dialog_message_reactions":
      return String(record.reaction_hash);
    case "dialog_message_receipts":
      return String(record.receipt_hash);
  }
}

export const pendingDialogKeysCollection = createCollection(
  localOnlyCollectionOptions<DialogKeysFields>({ id: "dialog_keys_pending", getKey: (item) => `${item.dialog_hash}:${item.sender_hash}` })
);
export const pendingDialogMessagesCollection = createCollection(
  localOnlyCollectionOptions<DialogMessageFields>({ id: "dialog_messages_pending", getKey: (item) => item.message_id })
);
export const pendingDialogMessageVersionsCollection = createCollection(
  localOnlyCollectionOptions<DialogMessageFields & { sign_hash: string }>({
    id: "dialog_messages_versions_pending",
    getKey: (item) => `${item.message_id}:${item.sign_hash}`,
  })
);
export const pendingDialogReactionsCollection = createCollection(
  localOnlyCollectionOptions<DialogReactionFields>({ id: "dialog_message_reactions_pending", getKey: (item) => item.reaction_hash })
);
export const pendingDialogReceiptsCollection = createCollection(
  localOnlyCollectionOptions<DialogReceiptFields>({ id: "dialog_message_receipts_pending", getKey: (item) => item.receipt_hash })
);

type OverlayCollectionMap = {
  [T in DialogTable]: Collection<DialogRecordByTable[T]>;
};

const overlayCollections: OverlayCollectionMap = {
  dialog_keys: pendingDialogKeysCollection,
  dialog_messages: pendingDialogMessagesCollection,
  dialog_messages_versions: pendingDialogMessageVersionsCollection,
  dialog_message_reactions: pendingDialogReactionsCollection,
  dialog_message_receipts: pendingDialogReceiptsCollection,
};

function overlayFor<T extends DialogTable>(table: T): Collection<DialogRecordByTable[T]> {
  return overlayCollections[table];
}

function applyToOverlay(table: DialogTable, record: DialogRecordFields) {
  const collection = overlayFor(table) as Collection<DialogRecordFields>;
  const key = keyFor(table, record);
  if (collection.has(key)) {
    collection.update(key, (draft: DialogRecordFields) => Object.assign(draft, record));
  } else {
    collection.insert(record);
  }
}

function removeFromOverlay(table: DialogTable, key: string) {
  const collection = overlayFor(table) as Collection<DialogRecordFields>;
  if (collection.has(key)) collection.delete(key);
}

async function putPending(
  table: DialogTable,
  key: string,
  record: DialogRecordFields,
  ownerUserHash: string,
  patch?: Partial<DialogRecordFields>
) {
  if (!ownerUserHash) throw new Error(`[dialogQueue] putPending(${table}): ownerUserHash is required`);
  const id = `${table}:${key}`;
  const now = Date.now();

  const { current: existing, outcome } = await atomicMutate(id, (existing) => {
    const revision = (existing?.revision || 0) + 1;
    return {
      action: "put",
      entry: {
        id,
        table,
        key,
        ownerUserHash,
        record: { ...existing?.record, ...record },
        patch: { ...existing?.patch, ...(patch ?? record) },
        status: "pending",
        revision,
        sentSnapshot: existing?.sentSnapshot ?? null,
        sentRevision: existing?.sentRevision ?? null,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        sentAt: existing?.sentAt ?? null,
        lastError: null,
      },
    };
  });
  const entry = (outcome as { action: "put"; entry: QueueEntry }).entry;
  transitionStatus(existing?.status, "pending");

  applyToOverlay(table, entry.record);

  triggerDialogFlush();
  return entry;
}

export function putPendingDialog(table: DialogTable, record: DialogRecordFields, ownerUserHash: string, patch?: Partial<DialogRecordFields>) {
  return putPending(table, keyFor(table, record), record, ownerUserHash, patch);
}

export type ImportLegacyEntryResult = "imported" | "already-present";

export async function importLegacyPendingEntry(
  table: DialogTable,
  key: string,
  record: DialogRecordFields,
  ownerUserHash: string
): Promise<ImportLegacyEntryResult> {
  if (!ownerUserHash) throw new Error(`[dialogQueue] importLegacyPendingEntry(${table}): ownerUserHash is required`);
  const id = `${table}:${key}`;
  const now = Date.now();

  const { outcome } = await atomicMutate(id, (existing) => {
    if (existing) return { action: "noop" };
    return {
      action: "put",
      entry: {
        id,
        table,
        key,
        ownerUserHash,
        record,
        patch: record,
        status: "pending",
        revision: 1,
        sentSnapshot: null,
        sentRevision: null,
        createdAt: now,
        updatedAt: now,
        sentAt: null,
        lastError: null,
      },
    };
  });

  if (outcome.action !== "put") return "already-present";
  transitionStatus(null, "pending");
  applyToOverlay(table, record);
  return "imported";
}

let rehydratePromise: Promise<void> | null = null;

export function ensureRehydrated() {
  if (!rehydratePromise) {
    rehydratePromise = (async () => {
      const entries = await dbGetAll();
      const counts: Record<EntryStatus, number> = { pending: 0, quarantined: 0 };
      for (const entry of entries) {
        if (entry.status === "pending") applyToOverlay(entry.table, entry.record);
        counts[entry.status] = (counts[entry.status] || 0) + 1;
      }
      queueStatus.value = {
        ...queueStatus.value,
        pending: counts.pending,
        quarantined: counts.quarantined,
      };
      triggerDialogFlush();
    })().catch((err) => {
      console.error("[dialogQueue] Rehydration failed:", err);
    });
  }
  return rehydratePromise;
}

export function resetRehydration() {
  rehydratePromise = null;
}

export type SyncedRecorder = (
  table: DialogTable,
  key: string,
  record: DialogRecordFields,
  awaitingEcho?: boolean,
  ignoreEchoSignHash?: string
) => void | Promise<void>;

let syncedRecorder: SyncedRecorder | null = null;

export function setSyncedRecorder(recorder: SyncedRecorder | null) {
  syncedRecorder = recorder;
}

export async function markSynced(entry: QueueEntry, ignoreEchoSignHash?: string) {
  const current = await dbGet(entry.id);
  if (!current) return;
  await syncedRecorder?.(current.table, current.key, localSnapshotOf(current), true, ignoreEchoSignHash);

  const { outcome } = await atomicMutate(entry.id, (c) => {
    if (!c) return { action: "noop" };
    return { action: "delete" };
  });
  if (outcome.action !== "delete") return;
  transitionStatus(current.status, null);
  removeFromOverlay(current.table, current.key);
}

function localSnapshotOf(current: QueueEntry): DialogRecordFields {
  const resolved = resolvePendingDialogRecord(current.patch ?? current.record, current.sentSnapshot);
  return {
    ...resolved.record,
    sign_b64: resolved.record.sign_b64 ?? null,
    sign_hash: computeLocalSignHash(resolved.record),
  };
}

interface IngestResult {
  index?: unknown;
  status?: string;
  error?: string;
  details?: Record<string, unknown>;
}

const isAlreadyExistsError = (r: IngestResult) => {
  if (r.status !== "error" || r.error !== "validation_failed") return false;
  return Object.values(r.details || {}).some((v) => Array.isArray(v) && v.some((msg) => /has already been taken/i.test(msg)));
};

export function computeLocalSignHash(record: { sign_hash?: string | null; sign_b64?: string | null }): string | null {
  if (record.sign_hash) return record.sign_hash;
  if (!record.sign_b64) return null;
  const bytes = Uint8Array.from(atob(record.sign_b64), (c) => c.charCodeAt(0));
  return "dms_" + bytesToHex(sha3_512(bytes));
}

export type ResolvedPendingDialogRecord = { ready: true; record: DialogRecordFields; mutationType: MutationType };

export function resolvePendingDialogRecord(
  patch: Partial<DialogRecordFields>,
  priorConfirmed: DialogRecordFields | null | undefined
): ResolvedPendingDialogRecord {
  const record: DialogRecordFields = { ...priorConfirmed, ...patch };
  return { ready: true, record, mutationType: record.deleted_flag ? "update" : "insert" };
}

interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateDialogRecord(table: DialogTable, record: DialogRecordFields): ValidationResult {
  switch (table) {
    case "dialog_keys":
      if (!record.peer_kem_wrap_key_b64) return { ok: false, reason: "missing peer_kem_wrap_key_b64" };
      if (!record.peer_wrapped_msg_key_b64) return { ok: false, reason: "missing peer_wrapped_msg_key_b64" };
      return { ok: true };
    case "dialog_messages":
    case "dialog_messages_versions":
      if (!record.content_b64 && !record.deleted_flag) return { ok: false, reason: "empty content_b64" };
      return { ok: true };
    case "dialog_message_reactions":
    case "dialog_message_receipts":
      if (!record.message_sign_hash) return { ok: false, reason: "empty message_sign_hash" };
      return { ok: true };
  }
}

const DIALOG_KEYS_PROTOCOL_FIELDS = [
  "dialog_hash",
  "sender_hash",
  "peer_hash",
  "peer_kem_wrap_key_b64",
  "peer_wrapped_msg_key_b64",
  "owner_timestamp",
  "deleted_flag",
  "sign_b64",
] as const;
const DIALOG_MESSAGES_PROTOCOL_FIELDS = [
  "message_id",
  "dialog_hash",
  "sender_hash",
  "content_b64",
  "deleted_flag",
  "refs_map_b64",
  "parent_sign_hash",
  "owner_timestamp",
  "sign_b64",
  "sign_hash",
] as const;
const DIALOG_REACTIONS_PROTOCOL_FIELDS = [
  "reaction_hash",
  "dialog_hash",
  "message_id",
  "message_sign_hash",
  "reactor_hash",
  "type_b64",
  "deleted_flag",
  "owner_timestamp",
  "sign_b64",
] as const;
const DIALOG_RECEIPTS_PROTOCOL_FIELDS = [
  "receipt_hash",
  "dialog_hash",
  "message_id",
  "peer_hash",
  "type",
  "message_sign_hash",
  "owner_timestamp",
  "sign_b64",
] as const;

function protocolFieldsFor(table: DialogTable): readonly string[] {
  switch (table) {
    case "dialog_keys":
      return DIALOG_KEYS_PROTOCOL_FIELDS;
    case "dialog_messages":
    case "dialog_messages_versions":
      return DIALOG_MESSAGES_PROTOCOL_FIELDS;
    case "dialog_message_reactions":
      return DIALOG_REACTIONS_PROTOCOL_FIELDS;
    case "dialog_message_receipts":
      return DIALOG_RECEIPTS_PROTOCOL_FIELDS;
  }
}

export function toProtocolRecord(table: DialogTable, record: DialogRecordFields): DialogRecordFields {
  const fields = protocolFieldsFor(table);
  const clean: Record<string, unknown> = {};
  const source = record as unknown as Record<string, unknown>;
  for (const field of fields) {
    if (field in source) clean[field] = source[field];
  }
  return clean as DialogRecordFields;
}

export interface BuiltDialogMutation {
  mutation: ApiMutation;
  sentSnapshot: DialogRecordFields;
}

export function buildDialogMutation(table: DialogTable, record: DialogRecordFields, mutationType: MutationType, signSkey: Uint8Array): BuiltDialogMutation {
  const protocolRecord = toProtocolRecord(table, record);
  const mutation = api.createGenericMutation(table, protocolRecord as unknown as Record<string, unknown>, signSkey, mutationType);
  return { mutation, sentSnapshot: (mutation.modified || mutation.changes) as DialogRecordFields };
}

export const DIALOG_KEYS_CHANGED_FIELDS = ["peer_hash", "peer_kem_wrap_key_b64", "peer_wrapped_msg_key_b64", "owner_timestamp", "deleted_flag", "sign_b64"] as const;
export const DIALOG_MESSAGES_CHANGED_FIELDS = ["content_b64", "deleted_flag", "refs_map_b64", "parent_sign_hash", "owner_timestamp", "sign_b64", "sign_hash"] as const;
export const DIALOG_MESSAGES_VERSIONS_CHANGED_FIELDS = [
  "dialog_hash",
  "sender_hash",
  "content_b64",
  "deleted_flag",
  "refs_map_b64",
  "parent_sign_hash",
  "owner_timestamp",
  "sign_b64",
] as const;
export const DIALOG_REACTIONS_CHANGED_FIELDS = ["type_b64", "deleted_flag", "owner_timestamp", "sign_b64"] as const;
export const DIALOG_RECEIPTS_CHANGED_FIELDS = ["type", "message_sign_hash", "owner_timestamp", "sign_b64"] as const;

function isDistinct(a: unknown, b: unknown): boolean {
  return (a ?? null) !== (b ?? null);
}

export function anyColumnChanged(columns: readonly string[], base: DialogRecordFields | null | undefined, merged: DialogRecordFields): boolean {
  if (!base) return true;
  const b = base as unknown as Record<string, unknown>;
  const m = merged as unknown as Record<string, unknown>;
  return columns.some((col) => isDistinct(b[col], m[col]));
}

export const DIALOG_MESSAGES_LOCKED_FIELDS = ["dialog_hash", "sender_hash"] as const;
export const DIALOG_REACTIONS_LOCKED_FIELDS = ["dialog_hash", "message_id", "message_sign_hash", "reactor_hash"] as const;
export const DIALOG_RECEIPTS_LOCKED_FIELDS = ["dialog_hash", "message_id", "peer_hash"] as const;

export function withLockedFields(base: DialogRecordFields | null | undefined, merged: DialogRecordFields, locked: readonly string[]): DialogRecordFields {
  if (!base) return merged;
  const b = base as unknown as Record<string, unknown>;
  const out = { ...merged } as unknown as Record<string, unknown>;
  for (const field of locked) out[field] = b[field];
  return out as DialogRecordFields;
}

async function quarantine(entry: QueueEntry, reason: string) {
  const current = await dbGet(entry.id);
  if (!current) return;
  await syncedRecorder?.(current.table, current.key, localSnapshotOf(current), true);

  const { outcome } = await atomicMutate(entry.id, (c) => {
    if (!c) return { action: "noop" };
    return { action: "put", entry: { ...c, status: "quarantined", lastError: reason } };
  });
  if (outcome.action !== "put") return;
  transitionStatus(current.status, "quarantined");
  removeFromOverlay(current.table, current.key);
}

let failStreak = 0;

function nextBackoffDelay() {
  failStreak = Math.min(failStreak + 1, 6);
  const delay = Math.min(5000 * 2 ** failStreak, 300000);
  console.warn(`[dialogQueue] sync backoff ${Math.round(delay / 1000)}s (streak ${failStreak})`);
  return delay;
}

function resetBackoff() {
  failStreak = 0;
}

export interface FlushResult {
  retryAfterMs: number;
}

export async function flushPendingDialogChanges(signSkey: Uint8Array | null | undefined, ownerUserHash?: string | null) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  if (!signSkey) {
    console.warn("[dialogQueue] sign_skey is required");
    return;
  }

  const all = await dbGetAll();
  const entries = all.filter((e) => e.status === "pending" && e.ownerUserHash === ownerUserHash);
  if (entries.length === 0) return;

  const tableOrder = new Map(DIALOG_TABLES.map((t, i) => [t, i]));
  entries.sort((a, b) => tableOrder.get(a.table)! - tableOrder.get(b.table)!);

  try {
    const mutations: ApiMutation[] = [];
    const mutationEntries: QueueEntry[] = [];

    let mutationCount = 0;

    for (const entry of entries) {
      if (++mutationCount % 50 === 0) await new Promise((r) => setTimeout(r, 0));

      const resolved = resolvePendingDialogRecord(entry.patch ?? entry.record, entry.sentSnapshot);

      const v = validateDialogRecord(entry.table, resolved.record);
      if (!v.ok) {
        console.warn(`[dialogQueue] Skipping invalid ${entry.table} ${entry.key}: ${v.reason}`);
        await quarantine(entry, v.reason || "invalid");
        continue;
      }
      const { mutation } = buildDialogMutation(entry.table, resolved.record, resolved.mutationType, signSkey);
      mutations.push(mutation);
      mutationEntries.push(entry);
    }

    if (mutations.length === 0) return;

    const resp = await api.ingestWithAuthEach(mutations, signSkey);

    let body: { results?: IngestResult[] } | null = null;
    try {
      body = await resp.json();
    } catch {
      console.error("[dialogQueue] ingest response was not JSON");
    }

    if (!body || !Array.isArray(body.results)) {
      console.error(`[dialogQueue] ingest HTTP ${resp.status}: no per-row results`);
      return { retryAfterMs: nextBackoffDelay() };
    }

    if (body.results.every((r) => r.status === "ok")) {
      const currentlyPending = (await dbGetAll()).filter((e) => e.status === "pending" && e.ownerUserHash === ownerUserHash);
      for (const entry of currentlyPending) {
        await markSynced(entry);
      }
      resetBackoff();
      return;
    }

    let toRetry = 0;

    for (const r of body.results) {
      const entry = mutationEntries[r?.index as number];
      if (!entry) continue;

      if (r.status === "ok") {
        await markSynced(entry);
      } else if (isAlreadyExistsError(r)) {
        const parentSignHash = entry.table === "dialog_messages" ? resolvePendingDialogRecord(entry.patch ?? entry.record, entry.sentSnapshot).record.parent_sign_hash : null;
        await markSynced(entry, parentSignHash ?? undefined);
      } else if (r.error === "validation_failed") {
        console.error(`[dialogQueue] Mutation for ${entry.table} ${entry.key} permanently rejected, quarantined locally:`, JSON.stringify(r.details || r));
        await quarantine(entry, r.error);
      } else {
        toRetry++;
        console.warn(`[dialogQueue] Mutation for ${entry.table} ${entry.key} failed (will retry):`, r.error);
      }
    }

    if (toRetry === 0) {
      resetBackoff();
      return;
    }
    return { retryAfterMs: nextBackoffDelay() };
  } catch (e) {
    console.warn("[dialogQueue] Sync failed:", e);
    return { retryAfterMs: nextBackoffDelay() };
  }
}

export interface FlushSchedulerOptions {
  setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
}

export interface FlushScheduler {
  trigger(debounceMs?: number): void;
  isRunning(): boolean;
}

export function createFlushScheduler(
  runOnce: () => FlushResult | undefined | void | Promise<FlushResult | undefined | void>,
  { setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }: FlushSchedulerOptions = {}
): FlushScheduler {
  let running = false;
  let backoffUntil = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function attempt(): Promise<void> {
    if (running) return;
    if (backoffUntil - now() > 0) return;
    running = true;
    try {
      const result = (await runOnce()) || ({} as FlushResult | Record<string, never>);
      backoffUntil = "retryAfterMs" in result && result.retryAfterMs ? now() + result.retryAfterMs : 0;
    } finally {
      running = false;
    }
  }

  return {
    trigger(debounceMs = 100) {
      if (debounceTimer !== null) clearTimer(debounceTimer);
      debounceTimer = setTimer(() => {
        debounceTimer = null;
        attempt();
      }, debounceMs);
    },
    isRunning: () => running,
  };
}

export interface DialogIdentity {
  signSkey: Uint8Array;
  userHash: string;
}

let getIdentityFn: (() => DialogIdentity | null) | null = null;

const flushScheduler = createFlushScheduler(async () => {
  const identity = getIdentityFn && getIdentityFn();
  if (!identity?.signSkey) return;
  queueStatus.value = { ...queueStatus.value, flushing: true };
  try {
    const result = await flushPendingDialogChanges(identity.signSkey, identity.userHash);
    queueStatus.value = { ...queueStatus.value, backoffUntil: result?.retryAfterMs ? Date.now() + result.retryAfterMs : 0 };
    return result;
  } finally {
    queueStatus.value = { ...queueStatus.value, flushing: false };
  }
});

export function setDialogAuthProvider(getIdentity: () => DialogIdentity | null) {
  getIdentityFn = getIdentity;
  setTimeout(() => triggerDialogFlush(), 200);
}

export function triggerDialogFlush() {
  flushScheduler.trigger();
}

export function isDialogShapeSyncDisabled(): boolean {
  return localStorage.getItem("DISABLE_SYNC") === "true";
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => setTimeout(() => triggerDialogFlush(), 300));
}

ensureRehydrated();

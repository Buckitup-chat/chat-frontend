import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import { ref, type Ref } from "vue";
import { api } from "../../../api/client";
import type { ApiMutation } from "../../../api/client";
import { MutationType } from "@/api/client";

export type UserTable = "user_cards" | "user_storage";
export type EntryStatus = "pending" | "awaiting_remote" | "quarantined";

export interface UserCardFields {
  user_hash: string;
  sign_pkey?: string;
  contact_pkey?: string;
  contact_cert?: string;
  crypt_pkey?: string;
  crypt_cert?: string;
  name?: string;
  deleted_flag?: boolean;
  owner_timestamp?: number | bigint;
  sign_b64?: string;
}

export interface UserStorageFields {
  user_hash: string;
  uuid: string;
  value_b64?: string | null;
  hash_b64?: string | null;
  deleted_flag?: boolean;
  owner_timestamp?: number | bigint | null;
  parent_sign_hash?: string | null;
  sign_hash?: string | null;
  sign_b64?: string | null;
  version?: number;
}

export interface UserRecordFields {
  user_hash: string;
  uuid?: string;
  sign_pkey?: string;
  contact_pkey?: string;
  contact_cert?: string;
  crypt_pkey?: string;
  crypt_cert?: string;
  name?: string;
  deleted_flag?: boolean;
  owner_timestamp?: number | bigint | null;
  sign_b64?: string | null;
  value_b64?: string | null;
  hash_b64?: string | null;
  parent_sign_hash?: string | null;
  sign_hash?: string | null;
  version?: number;
}

export interface QueueEntry {
  id: string;
  table: UserTable;
  key: string;
  record: UserRecordFields;
  patch: Partial<UserRecordFields>;
  status: EntryStatus;
  revision: number;
  sentSnapshot: UserRecordFields | null;
  sentRevision: number | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  lastError: string | null;
}

const DB_NAME = "user-pending-queue";
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
      console.error("[userQueue] Failed to open IndexedDB:", req.error);
      resolve(null);
    };
  });
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => T | Promise<T>): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let result: T | Promise<T>;
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

async function dbGetAll(): Promise<QueueEntry[]> {
  return (await withStore<QueueEntry[]>("readonly", (store) => reqToPromise(store.getAll()))) || [];
}

type AtomicOutcome = { action: "put"; entry: QueueEntry } | { action: "delete" } | { action: "noop" };

interface AtomicResult {
  current: QueueEntry | undefined;
  outcome: AtomicOutcome;
}

async function atomicMutate(id: string, mutator: (current: QueueEntry | undefined) => AtomicOutcome) {
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
  });
}

function withTransaction<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore, tx: IDBTransaction) => T | Promise<T>) {
  return openDb().then((db) => {
    if (!db) return { current: undefined, outcome: { action: "noop" } } as T;
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
        reject(tx.error || new Error("[userQueue] transaction aborted"));
      };
    });
  });
}

export interface QueueStatus {
  pending: number;
  awaitingRemote: number;
  quarantined: number;
  flushing: boolean;
  backoffUntil: number;
}

export const queueStatus: Ref<QueueStatus> = ref({
  pending: 0,
  awaitingRemote: 0,
  quarantined: 0,
  flushing: false,
  backoffUntil: 0,
});

function statusField(status: EntryStatus) {
  return status === "awaiting_remote" ? "awaitingRemote" : status;
}

function transitionStatus(oldStatus: EntryStatus | null | undefined, newStatus: EntryStatus | null) {
  if (oldStatus === newStatus) return;
  const next = { ...queueStatus.value };
  if (oldStatus) next[statusField(oldStatus)] = Math.max(0, next[statusField(oldStatus)] - 1);
  if (newStatus) next[statusField(newStatus)] += 1;
  queueStatus.value = next;
}

export const pendingUserCardsCollection = createCollection(
  localOnlyCollectionOptions<UserCardFields>({
    id: "user_cards_pending",
    getKey: (item) => item.user_hash,
  })
);

export const pendingUserStorageCollection = createCollection(
  localOnlyCollectionOptions<UserStorageFields>({
    id: "user_storage_pending",
    getKey: (item) => `${item.user_hash}:${item.uuid}`,
  })
);

type PendingOverlayCollection = Collection<UserCardFields> | Collection<UserStorageFields>;

function applyToOverlay(collection: PendingOverlayCollection, record: UserRecordFields) {
  const key = collection.id === "user_cards_pending" ? record.user_hash : `${record.user_hash}:${record.uuid}`;
  const generic = collection as unknown as Collection<UserRecordFields>;
  if (generic.has(key)) {
    generic.update(key, (draft) => Object.assign(draft, record));
  } else {
    generic.insert(record);
  }
}

function removeFromOverlay(table: UserTable, key: string) {
  const collection = table === "user_cards" ? pendingUserCardsCollection : pendingUserStorageCollection;
  if (collection.has(key)) collection.delete(key);
}

async function putPending(table: UserTable, key: string, record: UserRecordFields, patch?: Partial<UserRecordFields>) {
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

  applyToOverlay(table === "user_cards" ? pendingUserCardsCollection : pendingUserStorageCollection, entry.record);

  triggerUserFlush();
  return entry;
}

export function putPendingUserCard(record: UserCardFields, patch?: Partial<UserCardFields>) {
  return putPending("user_cards", record.user_hash, record, patch);
}

export function putPendingUserStorage(record: UserStorageFields, patch?: Partial<UserStorageFields>) {
  return putPending("user_storage", `${record.user_hash}:${record.uuid}`, record, patch);
}

let rehydratePromise: Promise<void> | null = null;

export function ensureRehydrated() {
  if (!rehydratePromise) {
    rehydratePromise = (async () => {
      const entries = await dbGetAll();
      const counts: Record<EntryStatus, number> = { pending: 0, awaiting_remote: 0, quarantined: 0 };
      for (const entry of entries) {
        const collection = entry.table === "user_cards" ? pendingUserCardsCollection : pendingUserStorageCollection;
        applyToOverlay(collection, entry.record);
        counts[entry.status] = (counts[entry.status] || 0) + 1;
      }
      queueStatus.value = {
        ...queueStatus.value,
        pending: counts.pending,
        awaitingRemote: counts.awaiting_remote,
        quarantined: counts.quarantined,
      };
      triggerUserFlush();
    })().catch((err) => {
      console.error("[userQueue] Rehydration failed:", err);
    });
  }
  return rehydratePromise;
}

export interface RemoteReader {
  get(key: string): UserRecordFields | undefined;
  isReady(): boolean;
}

type RemoteReaders = Record<UserTable, RemoteReader | null>;

const remoteReaders: RemoteReaders = { user_cards: null, user_storage: null };

export function setRemoteReaders(readers: Partial<RemoteReaders>) {
  Object.assign(remoteReaders, readers);
}

export interface BaseState {
  known: boolean;
  value: UserRecordFields | undefined;
}

export function resolveBaseState(table: UserTable, key: string, readers: RemoteReaders = remoteReaders) {
  const reader = readers[table];
  if (!reader) return { known: false, value: undefined };
  const value = reader.get(key);
  if (value !== undefined && value !== null) return { known: true, value };
  return { known: !!reader.isReady(), value: undefined };
}

const USER_CARD_CONFIRM_FIELDS: Array<keyof UserCardFields> = [
  "user_hash",
  "sign_pkey",
  "contact_pkey",
  "contact_cert",
  "crypt_pkey",
  "crypt_cert",
  "name",
  "deleted_flag",
  "owner_timestamp",
  "sign_b64",
];

const USER_STORAGE_CONFIRM_FIELDS: Array<keyof UserStorageFields> = [
  "user_hash",
  "uuid",
  "value_b64",
  "deleted_flag",
  "owner_timestamp",
  "sign_hash",
  "sign_b64",
];

function normalizeForCompare(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  return value;
}

const USER_CARD_BINARY_FIELDS = new Set<string>(["sign_pkey", "contact_pkey", "contact_cert", "crypt_pkey", "crypt_cert", "sign_b64"]);

const USER_STORAGE_BINARY_FIELDS = new Set<string>(["value_b64", "sign_b64"]);

function binaryFieldsFor(table: UserTable): Set<string> {
  return table === "user_cards" ? USER_CARD_BINARY_FIELDS : USER_STORAGE_BINARY_FIELDS;
}

function hexFromBytea(value: unknown): string | null {
  if (typeof value !== "string" || !/^\\x[0-9a-fA-F]*$/.test(value)) return null;
  return value.slice(2).toLowerCase();
}

function padBase64(s: string): string {
  const remainder = s.length % 4;
  return remainder === 0 ? s : s + "=".repeat(4 - remainder);
}

function hexFromBase64(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(normalized)) return null;
  try {
    const binary = atob(padBase64(normalized));
    let hex = "";
    for (let i = 0; i < binary.length; i++) hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
    return hex;
  } catch {
    return null;
  }
}

function canonicalBinary(value: unknown) {
  if (value === null || value === undefined) return value;
  const bytea = hexFromBytea(value);
  if (bytea !== null) return bytea;
  const b64 = hexFromBase64(value);
  if (b64 !== null) return b64;
  return value;
}

function fieldsMatch(table: UserTable, fields: Array<string>, a: UserRecordFields, b: UserRecordFields) {
  if (!a || !b) return false;
  const binaryFields = binaryFieldsFor(table);
  const aRec = a as unknown as Record<string, unknown>;
  const bRec = b as unknown as Record<string, unknown>;
  return fields.every((f) => {
    const av = normalizeForCompare(aRec[f] ?? null);
    const bv = normalizeForCompare(bRec[f] ?? null);
    if (binaryFields.has(f)) return canonicalBinary(av) === canonicalBinary(bv);
    return av === bv;
  });
}

export function isRemoteConfirmation(
  table: UserTable,
  sentSnapshot: UserRecordFields | null | undefined,
  remoteRecord: UserRecordFields | null | undefined
) {
  if (!sentSnapshot || !remoteRecord) return false;
  const fields = table === "user_cards" ? USER_CARD_CONFIRM_FIELDS : USER_STORAGE_CONFIRM_FIELDS;
  return fieldsMatch(table, fields, sentSnapshot, remoteRecord);
}

async function checkConfirmation(table: UserTable, key: string) {
  const reader = remoteReaders[table];
  if (!reader) return;
  const id = `${table}:${key}`;

  const remoteRecord = reader.get(key);
  const { current, outcome } = await atomicMutate(id, (current) => {
    if (!current || current.status !== "awaiting_remote") return { action: "noop" };
    if (!isRemoteConfirmation(table, current.sentSnapshot, remoteRecord)) return { action: "noop" };
    return { action: "delete" };
  });
  if (outcome.action !== "delete" || !current) return;
  transitionStatus(current.status, null);
  removeFromOverlay(table, key);
}

export async function checkAllAwaitingRemote(table: UserTable) {
  const all = await dbGetAll();
  const awaiting = all.filter((e) => e.table === table && e.status === "awaiting_remote");
  for (const entry of awaiting) {
    await checkConfirmation(table, entry.key);
  }
}

const LEGACY_STORAGE_SLOTS = new Set(["profile", "contacts"]);

export async function removeSupersededLegacyStorageEntry(userHash: string, logicalUuid: string) {
  if (!userHash || !LEGACY_STORAGE_SLOTS.has(logicalUuid)) return false;
  const key = `${userHash}:${logicalUuid}`;
  const id = `user_storage:${key}`;

  const { current, outcome } = await atomicMutate(id, (current) => {
    if (!current) return { action: "noop" };
    if (current.table !== "user_storage" || current.status !== "quarantined" || current.lastError !== "validation_failed") {
      return { action: "noop" };
    }
    return { action: "delete" };
  });
  if (outcome.action !== "delete" || !current) return false;
  transitionStatus(current.status, null);
  removeFromOverlay("user_storage", key);
  return true;
}

export async function purgeUserQueueEntries(userHash: string) {
  if (!userHash) return { removed: 0 };
  const all = await dbGetAll();
  const candidates = all.filter((e) => e.record?.user_hash === userHash);
  let removed = 0;
  for (const entry of candidates) {
    const { current, outcome } = await atomicMutate(entry.id, (current) => {
      if (!current || current.record?.user_hash !== userHash) return { action: "noop" };
      return { action: "delete" };
    });
    if (outcome.action === "delete" && current) {
      transitionStatus(current.status, null);
      removeFromOverlay(current.table, current.key);
      removed++;
    }
  }
  return { removed };
}

export async function markAwaitingRemote(entry: QueueEntry, sentSnapshot: UserRecordFields) {
  const { current, outcome } = await atomicMutate(entry.id, (current) => {
    if (!current || current.revision !== entry.revision) {
      return { action: "noop" };
    }
    return {
      action: "put",
      entry: {
        ...current,
        status: "awaiting_remote",
        sentSnapshot,
        sentRevision: entry.revision,
        sentAt: Date.now(),
      },
    };
  });
  if (outcome.action !== "put" || !current) return;
  transitionStatus(current.status, "awaiting_remote");
  await checkConfirmation(entry.table, entry.key);
}

const base64ToBytes = (base64: string | null | undefined) => {
  if (!base64) return null;
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

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

export type ResolvedPendingRecord = { ready: true; record: UserRecordFields; mutationType: MutationType } | { ready: false };

export function resolvePendingRecord(
  table: UserTable,
  patch: Partial<UserRecordFields>,
  baseState: BaseState,
  priorConfirmed?: UserRecordFields | null
): ResolvedPendingRecord {
  if (priorConfirmed) {
    const base = baseState.known && baseState.value ? baseState.value : priorConfirmed;
    const record = { ...(table === "user_cards" ? { deleted_flag: false } : null), ...base, ...patch } as UserRecordFields;
    return { ready: true, record, mutationType: "update" };
  }
  if (!baseState.known) return { ready: false };
  const base = baseState.value;
  const record = { ...(table === "user_cards" ? { deleted_flag: false } : null), ...base, ...patch } as UserRecordFields;
  return { ready: true, record, mutationType: base ? "update" : "insert" };
}

interface ValidationResult {
  ok: boolean;
  reason?: string;
}

function validateRecord(table: UserTable, record: UserRecordFields): ValidationResult {
  if (table === "user_cards") {
    if (!record.sign_pkey || !record.contact_pkey || !record.crypt_pkey) {
      return { ok: false, reason: "missing keys" };
    }
    return { ok: true };
  }
  if (table === "user_storage") {
    if (!record.value_b64 && !record.deleted_flag) {
      return { ok: false, reason: "empty value_b64" };
    }
    return { ok: true };
  }
  return { ok: true };
}

export interface BuiltMutation {
  mutation: ApiMutation;
  sentSnapshot: UserRecordFields;
}

export function buildMutation(table: UserTable, record: UserRecordFields, mutationType: MutationType, signSkey: Uint8Array) {
  if (table === "user_cards") {
    const { mutation } = api.createUserCard(
      record.name || "User",
      {
        user_hash: record.user_hash,
        sign_pkey: base64ToBytes(record.sign_pkey),
        contact_pkey: base64ToBytes(record.contact_pkey),
        contact_cert: base64ToBytes(record.contact_cert),
        crypt_pkey: base64ToBytes(record.crypt_pkey),
        crypt_cert: base64ToBytes(record.crypt_cert),
        sign_skey: signSkey,
      },
      mutationType
    );
    return { mutation, sentSnapshot: (mutation.modified || mutation.changes) as unknown as UserRecordFields };
  }

  const mutation = api.createStorageMutation(
    record.user_hash,
    record.uuid as string,
    record.value_b64,
    record.hash_b64,
    record.owner_timestamp ? Number(record.owner_timestamp) : Math.floor(Date.now() / 1000),
    signSkey,
    record.deleted_flag,
    record.deleted_flag,
    record.parent_sign_hash,
    record.sign_hash,
    record.sign_b64,
    mutationType
  );
  return { mutation, sentSnapshot: (mutation.modified || mutation.changes) as unknown as UserRecordFields };
}

export function selectOwnedEntries(entries: QueueEntry[], ownerUserHash: string | null | undefined) {
  if (!ownerUserHash) return [];
  return entries.filter((e) => e.record?.user_hash === ownerUserHash);
}

async function quarantine(id: string, reason: string, expectedRevision: number) {
  const { current, outcome } = await atomicMutate(id, (current) => {
    if (!current || current.revision !== expectedRevision) return { action: "noop" };
    return { action: "put", entry: { ...current, status: "quarantined", lastError: reason } };
  });
  if (outcome.action !== "put" || !current) return;
  transitionStatus(current.status, "quarantined");
}

let failStreak = 0;

function nextBackoffDelay() {
  failStreak = Math.min(failStreak + 1, 6);
  const delay = Math.min(5000 * 2 ** failStreak, 300000);
  console.warn(`[userQueue] sync backoff ${Math.round(delay / 1000)}s (streak ${failStreak})`);
  return delay;
}

function resetBackoff() {
  failStreak = 0;
}

export interface FlushResult {
  retryAfterMs: number;
}

export async function flushPendingUserChanges(signSkey: Uint8Array | null | undefined, ownerUserHash: string | null | undefined) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  if (!signSkey || !ownerUserHash) {
    console.warn("[userQueue] sign_skey and owner user_hash are required");
    return;
  }

  const all = await dbGetAll();
  const entries = selectOwnedEntries(
    all.filter((e) => e.status === "pending"),
    ownerUserHash
  );
  if (entries.length === 0) return;

  try {
    const mutations: ApiMutation[] = [];
    const mutationEntries: QueueEntry[] = [];
    const mutationSnapshots: UserRecordFields[] = [];

    for (const entry of entries) {
      const baseState = resolveBaseState(entry.table, entry.key);
      const resolved = resolvePendingRecord(entry.table, entry.patch ?? entry.record, baseState, entry.sentSnapshot);
      if (!resolved.ready || !resolved.record || !resolved.mutationType) {
        continue;
      }
      const v = validateRecord(entry.table, resolved.record);
      if (!v.ok) {
        console.warn(`[userQueue] Skipping invalid ${entry.table} ${entry.key}: ${v.reason}`);
        await quarantine(entry.id, v.reason || "invalid", entry.revision);
        continue;
      }
      const { mutation, sentSnapshot } = buildMutation(entry.table, resolved.record, resolved.mutationType, signSkey);
      mutations.push(mutation);
      mutationEntries.push(entry);
      mutationSnapshots.push(sentSnapshot);
    }

    if (mutations.length === 0) return;

    const resp = await api.ingestWithAuthEach(mutations, signSkey);

    let body: { results?: IngestResult[] } | null = null;
    try {
      body = await resp.json();
    } catch {
      console.error(Error)
    }

    if (!body || !Array.isArray(body.results)) {
      console.error(`[userQueue] ingest HTTP ${resp.status}: no per-row results`);
      return { retryAfterMs: nextBackoffDelay() };
    }

    let toRetry = 0;

    const seenIndices = new Set<number>();
    const resultsByIndex = new Map<number, IngestResult>();
    for (const r of body.results) {
      const idx = r?.index;
      const isValidIndex = Number.isInteger(idx) && (idx as number) >= 0 && (idx as number) < mutationEntries.length;
      if (!isValidIndex) {
        toRetry++;
        console.warn("[userQueue] ingest result missing/invalid index, ignoring:", JSON.stringify(r));
        continue;
      }
      const validIdx = idx as number;
      if (seenIndices.has(validIdx)) {
        resultsByIndex.delete(validIdx);
        toRetry++;
        console.warn(`[userQueue] ingest returned duplicate result index ${validIdx}, ignoring all of them`);
        continue;
      }
      seenIndices.add(validIdx);
      resultsByIndex.set(validIdx, r);
    }

    for (let i = 0; i < mutationEntries.length; i++) {
      const entry = mutationEntries[i];
      const r = resultsByIndex.get(i);
      if (!r) {
        toRetry++;
        continue;
      }

      if (r.status === "ok" || isAlreadyExistsError(r)) {
        await markAwaitingRemote(entry, mutationSnapshots[i]);
      } else if (r.error === "validation_failed") {
        console.error(`[userQueue] Mutation for ${entry.table} ${entry.key} permanently rejected, quarantined locally:`, JSON.stringify(r.details || r));
        await quarantine(entry.id, r.error, entry.revision);
      } else {
        toRetry++;
        console.warn(`[userQueue] Mutation for ${entry.table} ${entry.key} failed (will retry):`, r.error);
      }
    }

    if (toRetry === 0) {
      resetBackoff();
      return;
    }
    return { retryAfterMs: nextBackoffDelay() };
  } catch (e) {
    console.warn("[userQueue] Sync failed:", e);
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
  let rerunRequested = false;
  let backoffUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function arm(delayMs: number, fn: () => void): void {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(fn, delayMs);
  }

  async function attempt(): Promise<void> {
    if (running) {
      rerunRequested = true;
      return;
    }
    const remaining = backoffUntil - now();
    if (remaining > 0) {
      arm(remaining, attempt);
      return;
    }
    running = true;
    try {
      const result = (await runOnce()) || ({} as FlushResult | Record<string, never>);
      if ("retryAfterMs" in result && result.retryAfterMs) {
        backoffUntil = now() + result.retryAfterMs;
        arm(result.retryAfterMs, attempt);
      } else {
        backoffUntil = 0;
      }
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        attempt();
      }
    }
  }

  return {
    trigger(debounceMs = 100) {
      arm(debounceMs, attempt);
    },
    isRunning: () => running,
  };
}

export interface UserIdentity {
  signSkey: Uint8Array;
  userHash: string;
}

let getIdentityFn: (() => UserIdentity | null) | null = null;

const flushScheduler = createFlushScheduler(async () => {
  const identity = getIdentityFn && getIdentityFn();
  if (!identity?.signSkey || !identity?.userHash) return;
  queueStatus.value = { ...queueStatus.value, flushing: true };
  try {
    const result = await flushPendingUserChanges(identity.signSkey, identity.userHash);
    queueStatus.value = { ...queueStatus.value, backoffUntil: result?.retryAfterMs ? Date.now() + result.retryAfterMs : 0 };
    return result;
  } finally {
    queueStatus.value = { ...queueStatus.value, flushing: false };
  }
});

export function setUserAuthProvider(getIdentity: () => UserIdentity | null) {
  getIdentityFn = getIdentity;
  setTimeout(() => triggerUserFlush(), 200);
}

export function triggerUserFlush() {
  flushScheduler.trigger();
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => setTimeout(() => triggerUserFlush(), 300));
}

ensureRehydrated();

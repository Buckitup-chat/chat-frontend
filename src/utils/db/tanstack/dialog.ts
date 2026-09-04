import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { ChangeMessage, WithVirtualProps } from "@tanstack/db";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { electricPersistenceReady, withElectricPersistence } from "./electricPersistence";
import type { DialogKeysFields, DialogMessageFields, DialogReactionFields, DialogReceiptFields } from "./dialogQueue";
import {
  pendingDialogKeysCollection,
  pendingDialogMessagesCollection,
  pendingDialogMessageVersionsCollection,
  pendingDialogReactionsCollection,
  pendingDialogReceiptsCollection,
  putPendingDialog,
  computeLocalSignHash,
  ensureRehydrated,
  setSyncedRecorder,
  setDialogAuthProvider,
  triggerDialogFlush,
  isDialogShapeSyncDisabled,
  anyColumnChanged,
  DIALOG_KEYS_CHANGED_FIELDS,
  DIALOG_MESSAGES_CHANGED_FIELDS,
  DIALOG_MESSAGES_VERSIONS_CHANGED_FIELDS,
  DIALOG_REACTIONS_CHANGED_FIELDS,
  DIALOG_RECEIPTS_CHANGED_FIELDS,
  withLockedFields,
  DIALOG_MESSAGES_LOCKED_FIELDS,
  DIALOG_REACTIONS_LOCKED_FIELDS,
  DIALOG_RECEIPTS_LOCKED_FIELDS,
} from "./dialogQueue";
import {
  cachedDialogKeysCollection,
  cachedDialogMessagesCollection,
  cachedDialogMessageVersionsCollection,
  cachedDialogReactionsCollection,
  cachedDialogReceiptsCollection,
  recordSynced,
  forgetSynced,
  ensureDialogCacheHydrated,
  isDialogCacheHydrated,
  stripCacheMetadata,
  isStaleEchoOfRejectedEdit
} from "./dialogCache";
import {
  mergeDialogMessagesForDisplay,
  mergeDialogReactionsForDisplay,
  isDialogMessagePending,
  shouldRedecryptMessage,
  compareByOwnerTimestamp,
  formatMessageTime,
  preferAckedCache,
  getDialogMessageCreatedAtMs,
  getDialogMessageDisplayTimestamp,
  isDialogMessageEdited,
} from "./dialogDisplay";

export {
  mergeDialogMessagesForDisplay,
  mergeDialogReactionsForDisplay,
  isDialogMessagePending,
  shouldRedecryptMessage,
  compareByOwnerTimestamp,
  formatMessageTime,
  preferAckedCache,
  getDialogMessageCreatedAtMs,
  getDialogMessageDisplayTimestamp,
  isDialogMessageEdited,
};

type DialogKeysRow = DialogKeysFields & Record<string, unknown>;
type DialogMessageRow = DialogMessageFields & Record<string, unknown>;
type DialogReactionRow = DialogReactionFields & Record<string, unknown>;
type DialogReceiptRow = DialogReceiptFields & Record<string, unknown>;

const absUrl = (p: string) => {
  const u = `${ELECTRIC_API_URL}${p}`;
  return u.startsWith("http") ? u : `${location.origin}${u}`;
};

function shapeErrorHandler(table: string) {
  return (error: unknown) => {
    console.error(`[dialog] shape sync error for ${table}:`, error);
  };
}

const dialogSyncDisabled = isDialogShapeSyncDisabled();

if (!dialogSyncDisabled) await electricPersistenceReady;

export const dialogKeysCollection = dialogSyncDisabled
  ? createCollection(localOnlyCollectionOptions<DialogKeysRow>({ id: "dialog_keys", getKey: (item) => `${item.dialog_hash}:${item.sender_hash}` }))
  : createCollection(
      withElectricPersistence(
        electricCollectionOptions<DialogKeysRow>({
          id: "dialog_keys",
          shapeOptions: { url: absUrl("/dialog_key"), params: { table: "dialog_keys" }, onError: shapeErrorHandler("dialog_keys") },
          getKey: (item) => `${item.dialog_hash}:${item.sender_hash}`,
        })
      )
    );

export const dialogMessagesCollection = dialogSyncDisabled
  ? createCollection(localOnlyCollectionOptions<DialogMessageRow>({ id: "dialog_messages", getKey: (item) => item.message_id }))
  : createCollection(
      withElectricPersistence(
        electricCollectionOptions<DialogMessageRow>({
          id: "dialog_messages",
          shapeOptions: { url: absUrl("/dialog_message"), params: { table: "dialog_messages" }, onError: shapeErrorHandler("dialog_messages") },
          getKey: (item) => item.message_id,
        })
      )
    );

export const dialogMessageReactionsCollection = dialogSyncDisabled
  ? createCollection(localOnlyCollectionOptions<DialogReactionRow>({ id: "dialog_message_reactions", getKey: (item) => item.reaction_hash }))
  : createCollection(
      withElectricPersistence(
        electricCollectionOptions<DialogReactionRow>({
          id: "dialog_message_reactions",
          shapeOptions: { url: absUrl("/dialog_message_reaction"), params: { table: "dialog_message_reactions" }, onError: shapeErrorHandler("dialog_message_reactions") },
          getKey: (item) => item.reaction_hash,
        })
      )
    );

export const dialogMessageReceiptsCollection = dialogSyncDisabled
  ? createCollection(localOnlyCollectionOptions<DialogReceiptRow>({ id: "dialog_message_receipts", getKey: (item) => item.receipt_hash }))
  : createCollection(
      withElectricPersistence(
        electricCollectionOptions<DialogReceiptRow>({
          id: "dialog_message_receipts",
          shapeOptions: { url: absUrl("/dialog_message_receipt"), params: { table: "dialog_message_receipts" }, onError: shapeErrorHandler("dialog_message_receipts") },
          getKey: (item) => item.receipt_hash,
        })
      )
    );

setSyncedRecorder(recordSynced);

type DialogKeysChange = ChangeMessage<WithVirtualProps<DialogKeysRow, string | number>, string | number>;
type DialogMessageChange = ChangeMessage<WithVirtualProps<DialogMessageRow, string | number>, string | number>;
type DialogReactionChange = ChangeMessage<WithVirtualProps<DialogReactionRow, string | number>, string | number>;
type DialogReceiptChange = ChangeMessage<WithVirtualProps<DialogReceiptRow, string | number>, string | number>;

type DialogChangeByTable = {
  dialog_keys: DialogKeysChange;
  dialog_messages: DialogMessageChange;
  dialog_message_reactions: DialogReactionChange;
  dialog_message_receipts: DialogReceiptChange;
};

type SyncedDialogTable = keyof DialogChangeByTable;

function handleChanges<TTable extends SyncedDialogTable>(
  table: TTable,
  changes: DialogChangeByTable[TTable][],
) {
  for (const change of changes) {
    const key = String(change.key);
    if (change.type === "delete") {
      forgetSynced(table, key);
      continue;
    }
    const value = change.value;
    const signHash = typeof value.sign_hash === "string" ? value.sign_hash : undefined;
    if (isStaleEchoOfRejectedEdit(table, key, signHash)) continue;
    recordSynced(table, key, value);
  }
  if (changes.length > 0) setTimeout(() => triggerDialogFlush(), 1200);
}

export function handleDialogKeysChanges(changes: DialogKeysChange[]) {
  return handleChanges("dialog_keys", changes);
}
export function handleDialogMessagesChanges(changes: DialogMessageChange[]) {
  return handleChanges("dialog_messages", changes);
}
export function handleDialogReactionsChanges(changes: DialogReactionChange[]) {
  return handleChanges("dialog_message_reactions", changes);
}
export function handleDialogReceiptsChanges(changes: DialogReceiptChange[]) {
  return handleChanges("dialog_message_receipts", changes);
}

dialogKeysCollection.subscribeChanges(handleDialogKeysChanges, { includeInitialState: true });
dialogMessagesCollection.subscribeChanges(handleDialogMessagesChanges, { includeInitialState: true });
dialogMessageReactionsCollection.subscribeChanges(handleDialogReactionsChanges, { includeInitialState: true });
dialogMessageReceiptsCollection.subscribeChanges(handleDialogReceiptsChanges, { includeInitialState: true });

export {
  cachedDialogKeysCollection,
  cachedDialogMessagesCollection,
  cachedDialogMessageVersionsCollection,
  cachedDialogReactionsCollection,
  cachedDialogReceiptsCollection,
  isDialogCacheHydrated,
  pendingDialogKeysCollection,
  pendingDialogMessagesCollection,
  pendingDialogMessageVersionsCollection,
  pendingDialogReactionsCollection,
  pendingDialogReceiptsCollection,
  setDialogAuthProvider,
  triggerDialogFlush,
};

let readyPromise: Promise<void> | null = null;

async function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (dialogSyncDisabled) {
        console.log("Shape sync disabled via localStorage");
      } else {
        dialogKeysCollection.preload().then(() => setTimeout(() => triggerDialogFlush(), 500));
        dialogMessagesCollection.preload().then(() => setTimeout(() => triggerDialogFlush(), 500));
        dialogMessageReactionsCollection.preload().then(() => setTimeout(() => triggerDialogFlush(), 500));
        dialogMessageReceiptsCollection.preload().then(() => setTimeout(() => triggerDialogFlush(), 500));
      }
      await Promise.all([ensureRehydrated(), ensureDialogCacheHydrated()]);
    })();
  }
  return readyPromise;
}

export async function ensureDialogReady() {
  await ready();
}

export async function getDialogKeys(dialogHash: string, senderHash: string) {
  await ready();
  const key = `${dialogHash}:${senderHash}`;
  const record = pendingDialogKeysCollection.get(key) || stripCacheMetadata(preferAckedCache(dialogKeysCollection.get(key), cachedDialogKeysCollection.get(key)));
  return record && record.deleted_flag === false ? record : null;
}

export async function getDialogMessage(messageId: string) {
  await ready();
  const record = pendingDialogMessagesCollection.get(messageId) || stripCacheMetadata(preferAckedCache(dialogMessagesCollection.get(messageId), cachedDialogMessagesCollection.get(messageId)));
  return record ?? null;
}

export async function getDialogReaction(reactionHash: string) {
  await ready();
  const record =
    pendingDialogReactionsCollection.get(reactionHash) ||
    stripCacheMetadata(preferAckedCache(dialogMessageReactionsCollection.get(reactionHash), cachedDialogReactionsCollection.get(reactionHash)));
  return record ?? null;
}

export async function getDialogReceipt(receiptHash: string) {
  await ready();
  const record =
    pendingDialogReceiptsCollection.get(receiptHash) ||
    stripCacheMetadata(preferAckedCache(dialogMessageReceiptsCollection.get(receiptHash), cachedDialogReceiptsCollection.get(receiptHash)));
  return record ?? null;
}

export interface UpsertDialogKeysInput extends DialogKeysFields {
  ownerUserHash: string;
}

export async function upsertDialogKeys(input: UpsertDialogKeysInput) {
  const { ownerUserHash, ...fields } = input;
  if (!ownerUserHash) throw new Error("upsertDialogKeys: ownerUserHash is required");
  await ready();
  const key = `${fields.dialog_hash}:${fields.sender_hash}`;
  const base = pendingDialogKeysCollection.get(key) || dialogKeysCollection.get(key) || stripCacheMetadata(cachedDialogKeysCollection.get(key));
  const merged: DialogKeysFields = { deleted_flag: false, ...base, ...fields };
  if (!anyColumnChanged(DIALOG_KEYS_CHANGED_FIELDS, base, merged)) return base;
  return putPendingDialog("dialog_keys", merged, ownerUserHash);
}

export interface UpsertDialogMessageInput extends DialogMessageFields {
  ownerUserHash: string;
}

export async function upsertDialogMessage(input: UpsertDialogMessageInput) {
  const { ownerUserHash, ...fields } = input;
  if (!ownerUserHash) throw new Error("upsertDialogMessage: ownerUserHash is required");
  await ready();
  const base = pendingDialogMessagesCollection.get(fields.message_id) || dialogMessagesCollection.get(fields.message_id) || stripCacheMetadata(cachedDialogMessagesCollection.get(fields.message_id));
  const merged = withLockedFields(base, { deleted_flag: false, ...base, ...fields }, DIALOG_MESSAGES_LOCKED_FIELDS) as DialogMessageFields;

  const entry = anyColumnChanged(DIALOG_MESSAGES_CHANGED_FIELDS, base, merged) ? await putPendingDialog("dialog_messages", merged, ownerUserHash) : base;

  const signHash = computeLocalSignHash(merged);
  if (signHash) {
    const versionsKey = `${merged.message_id}:${signHash}`;
    const versionsBase = pendingDialogMessageVersionsCollection.get(versionsKey) || stripCacheMetadata(cachedDialogMessageVersionsCollection.get(versionsKey));
    const versionsMerged: DialogMessageFields & { sign_hash: string } = { ...merged, sign_hash: signHash };
    if (anyColumnChanged(DIALOG_MESSAGES_VERSIONS_CHANGED_FIELDS, versionsBase, versionsMerged)) {
      await putPendingDialog("dialog_messages_versions", versionsMerged, ownerUserHash);
    }
  }

  return entry;
}

export interface UpsertDialogReactionInput extends DialogReactionFields {
  ownerUserHash: string;
}

export async function upsertDialogReaction(input: UpsertDialogReactionInput) {
  const { ownerUserHash, ...fields } = input;
  if (!ownerUserHash) throw new Error("upsertDialogReaction: ownerUserHash is required");
  await ready();
  const base =
    pendingDialogReactionsCollection.get(fields.reaction_hash) ||
    dialogMessageReactionsCollection.get(fields.reaction_hash) ||
    stripCacheMetadata(cachedDialogReactionsCollection.get(fields.reaction_hash));
  const merged = withLockedFields(base, { deleted_flag: false, ...base, ...fields }, DIALOG_REACTIONS_LOCKED_FIELDS) as DialogReactionFields;
  if (!anyColumnChanged(DIALOG_REACTIONS_CHANGED_FIELDS, base, merged)) return base;
  return putPendingDialog("dialog_message_reactions", merged, ownerUserHash);
}

export interface UpsertDialogReceiptInput extends DialogReceiptFields {
  ownerUserHash: string;
}

export async function upsertDialogReceipt(input: UpsertDialogReceiptInput) {
  const { ownerUserHash, ...fields } = input;
  if (!ownerUserHash) throw new Error("upsertDialogReceipt: ownerUserHash is required");
  await ready();
  const base =
    pendingDialogReceiptsCollection.get(fields.receipt_hash) ||
    dialogMessageReceiptsCollection.get(fields.receipt_hash) ||
    stripCacheMetadata(cachedDialogReceiptsCollection.get(fields.receipt_hash));
  const merged = withLockedFields(base, { ...base, ...fields }, DIALOG_RECEIPTS_LOCKED_FIELDS) as DialogReceiptFields;
  if (!anyColumnChanged(DIALOG_RECEIPTS_CHANGED_FIELDS, base, merged)) return base;
  return putPendingDialog("dialog_message_receipts", merged, ownerUserHash);
}

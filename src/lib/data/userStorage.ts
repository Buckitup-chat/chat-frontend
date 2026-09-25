// user_storage rows without PGlite: local durability via IndexedDB KV,
// server sync via signed mutations that go through the same durable
// intent → signed snapshot → outbox lifecycle as message/checkpoint writes
// (intents.ts, intentRecovery.ts, storageIntent.ts).
//
// Contract (verified against chat backend tests): the first write of a
// (user_hash, uuid) is an `insert`; every later revision MUST be an `update`
// with parent_sign_hash pointing at the server tip and a strictly newer
// owner_timestamp — a repeated insert is rejected with 422 regardless of
// content.
//
// Invariants this module enforces:
//   1. A durable intent is written before any optimistic projection, key
//      access, canonicalization or signing (§1). If that write fails, the
//      caller gets a definitive 'failed' outcome and nothing is signed.
//   2. A mutation is only signed against a KNOWN server base. "Server
//      unreachable" is not "row absent" — signing an insert from an unknown
//      base produces a guaranteed conflict once connectivity returns. When no
//      base is known yet, the intent stays durable and recoverable
//      ('awaiting-recovery'), not failed (§2, §14).
//   3. A locked vault (no signing key) is the same kind of recoverable wait:
//      the intent stays durable, unsigned, until the next recovery pass has
//      a key (§2).
//   4. Writes to one slot serialize their materialize-then-sign step via a
//      cross-tab lock (storageIntent.ts's withStorageSlotLock), not a
//      session-local Promise chain — the ordering survives reload and holds
//      across tabs (§6).
import { kvGet, kvSet } from './localStore';
import { getServerState, entityKeyFor } from './userStorageBase';
import { getAccepted } from './acceptedSnapshot';
import { enqueueIntent, updateIntent, intentsOf } from './intents';
import { materializeSignEnqueueStorageIntent } from './intentRecovery';
import { materializeStorageIntent, mergeJsonPatch, type StorageIntentPayload } from './storageIntent';
import { pinActiveSession, assertSessionUnchanged } from './sessionGuard';
import { SessionFencedError } from './outbox';
import { nextOwnerTimestamp } from './time';
import type { UserStorageRow } from './types';
import { readShapeOnce } from './shapeRead';
import { wireBool } from '@/lib/pq/schema';

// Slot addresses are not constants here: reads are public, so a fixed uuid
// per slot would be the same address on every account. See lib/pq/slotId for
// the derived root address and lib/data/slots for the map of the rest.

export type StorageSyncStatus = 'synced' | 'syncing' | 'failed' | 'awaiting-recovery';

// What we persist locally: the server-shaped row plus local-only metadata.
interface LocalStorageEntry {
	row: UserStorageRow;
	/** local integrity convenience; never sent to the server */
	hash_b64: string | null;
	syncStatus: StorageSyncStatus;
	syncError?: string;
}

// Re-exported: getServerState moved to userStorageBase.ts so storageIntent.ts
// can use it without importing this module (which would cycle back through
// storageIntent.ts). External callers keep importing it from here.
export { getServerState };

const kvKey = (userHash: string, uuid: string) => `us|${userHash}|${uuid}`;

// Older builds stored the bare row (with a synthetic `version`) instead of
// the entry wrapper. Normalize on read; the next write rewrites the new shape.
const normalizeEntry = (v: unknown): LocalStorageEntry | undefined => {
	if (!v || typeof v !== 'object') return undefined;
	if ('row' in (v as Record<string, unknown>)) return v as LocalStorageEntry;
	const legacyRow = v as UserStorageRow & { hash_b64?: string | null };
	return {
		row: legacyRow,
		hash_b64: legacyRow.hash_b64 ?? null,
		// legacy rows predate status tracking; profile/contacts never reached
		// the server back then, so 'failed' is the truthful default
		syncStatus: 'failed',
	};
};

const getLocalEntry = async (userHash: string, uuid: string): Promise<LocalStorageEntry | undefined> =>
	normalizeEntry(await kvGet(kvKey(userHash, uuid)).catch(() => undefined));

const tsOf = (row?: UserStorageRow | null): number => Number(row?.owner_timestamp || 0);

/** Freshest readable row: server vs locally pending, by owner_timestamp. */
export async function getStorageRow(userHash: string, uuid: string): Promise<UserStorageRow | null> {
	const [local, server] = await Promise.all([getLocalEntry(userHash, uuid), getServerState(userHash, uuid)]);

	const localRow = local && !local.row.deleted_flag ? local.row : undefined;
	const serverRow = server.state === 'found' && !server.row.deleted_flag ? server.row : undefined;

	const candidates = [localRow, serverRow].filter((r): r is UserStorageRow => !!r);
	if (candidates.length === 0) return null;
	return candidates.reduce((a, b) => (tsOf(b) > tsOf(a) ? b : a));
}

export interface UpsertResult {
	row: UserStorageRow;
	/** settled by the time this resolves: the server accepted, rejected, or
	 * the write is durably queued and recoverable (locked vault / unknown
	 * base) — see StorageSyncStatus. */
	sync: Promise<{ status: StorageSyncStatus; error?: unknown }>;
}

export interface UpsertOptions {
	userHash: string;
	uuid: string;
	valueB64: string;
	hashB64: string | null;
	signSkey: Uint8Array | null;
	/** Signed tombstone. Deletion is a new signed revision, never a server-side op. */
	deletedFlag?: boolean;
}

export interface UpsertJsonPatchOptions {
	userHash: string;
	uuid: string;
	jsonPatch: Record<string, unknown>;
	signSkey: Uint8Array | null;
	deletedFlag?: boolean;
}

interface StorageEdit {
	userHash: string;
	uuid: string;
	deletedFlag: boolean;
	valueB64?: string;
	jsonPatch?: Record<string, unknown>;
}

const provisionalRow = (
	userHash: string,
	uuid: string,
	valueB64: string | undefined,
	deletedFlag: boolean,
	previous: UserStorageRow | null
): UserStorageRow => ({
	user_hash: userHash,
	uuid,
	value_b64: valueB64 ?? previous?.value_b64 ?? '',
	deleted_flag: deletedFlag,
	parent_sign_hash: previous?.sign_hash ?? null,
	sign_hash: null,
	owner_timestamp: nextOwnerTimestamp(tsOf(previous)),
	sign_b64: null,
});

async function findUnresolvedStorageIntent(
	userHash: string,
	uuid: string
): Promise<{ id: string; payload: StorageIntentPayload } | null> {
	const { entries } = await intentsOf(userHash);
	for (const entry of entries) {
		const stored = entry.intent as Record<string, unknown>;
		if (stored.kind === 'storage' && stored.uuid === uuid) {
			return { id: entry.id, payload: stored as unknown as StorageIntentPayload };
		}
	}
	return null;
}

async function coalesceOrCreateStorageIntent(edit: StorageEdit): Promise<string | null> {
	const { userHash, uuid, deletedFlag, valueB64, jsonPatch } = edit;
	const existing = await findUnresolvedStorageIntent(userHash, uuid);
	if (existing) {
		const next: StorageIntentPayload = jsonPatch
			? {
				...existing.payload,
				deletedFlag,
				jsonPatch: mergeJsonPatch(existing.payload.jsonPatch ?? null, jsonPatch),
				revision: (existing.payload.revision ?? 0) + 1,
			}
			: {
				...existing.payload,
				deletedFlag,
				valueB64: valueB64!,
				jsonPatch: undefined,
				revision: (existing.payload.revision ?? 0) + 1,
			};
		return (await updateIntent(existing.id, next)) ? existing.id : null;
	}
	const payload: StorageIntentPayload = {
		kind: 'storage', relation: 'user_storage', userHash, uuid, deletedFlag,
		valueB64: valueB64 ?? '',
		...(jsonPatch ? { jsonPatch } : {}),
		revision: 0,
	};
	return enqueueIntent(payload, userHash, 'user_storage');
}

async function refreshedRowAfterAcceptance(userHash: string, uuid: string, fallback: UserStorageRow): Promise<UserStorageRow> {
	const accepted = await getAccepted('user_storage', entityKeyFor(userHash, uuid), userHash).catch(() => null);
	return (accepted as UserStorageRow | null) ?? fallback;
}

async function upsertStorageEditLive(edit: StorageEdit, hashB64: string | null, signSkey: Uint8Array | null): Promise<UpsertResult> {
	const { userHash, uuid, deletedFlag } = edit;
	const key = kvKey(userHash, uuid);
	const token = pinActiveSession(userHash, 'upsertStorageRow');

	const intentId = await coalesceOrCreateStorageIntent(edit);
	if (intentId === null) {
		const local = await getLocalEntry(userHash, uuid);
		// Nothing durable exists for this edit: no optimistic projection, no
		// signing, no network (§1) — a visible, definitive failure.
		return {
			row: local?.row ?? provisionalRow(userHash, uuid, edit.valueB64, deletedFlag, null),
			sync: Promise.resolve({ status: 'failed' as const, error: 'this edit could not be stored durably' }),
		};
	}

	assertSessionUnchanged(token, 'upsertStorageEditLive:afterDurableIntent');
	const local = await getLocalEntry(userHash, uuid);
	const projected = provisionalRow(userHash, uuid, edit.valueB64, deletedFlag, local?.row ?? null);
	assertSessionUnchanged(token, 'upsertStorageEditLive:beforeOptimisticProjection');
	await kvSet(key, { row: projected, hash_b64: hashB64, syncStatus: 'syncing' } satisfies LocalStorageEntry, userHash);

	if (!signSkey) {
		assertSessionUnchanged(token, 'upsertStorageEditLive:beforeAwaitingRecoveryNoKey');
		await kvSet(key, { row: projected, hash_b64: hashB64, syncStatus: 'awaiting-recovery' } satisfies LocalStorageEntry, userHash);
		return { row: projected, sync: Promise.resolve({ status: 'awaiting-recovery' as const }) };
	}

	const result = await materializeSignEnqueueStorageIntent(userHash, uuid, intentId, signSkey, token, materializeStorageIntent);

	if (result.kind === 'already-claimed') {
		return { row: projected, sync: Promise.resolve({ status: 'syncing' as const }) };
	}
	if (result.kind === 'base-unavailable') {
		assertSessionUnchanged(token, 'upsertStorageEditLive:beforeAwaitingRecoveryBaseUnavailable');
		await kvSet(key, { row: projected, hash_b64: hashB64, syncStatus: 'awaiting-recovery', syncError: result.message } satisfies LocalStorageEntry, userHash);
		return { row: projected, sync: Promise.resolve({ status: 'awaiting-recovery' as const, error: result.message }) };
	}

	try {
		const handle = await result.dispatchPromise;
		const outcome = handle.phase === 'accepted' ? ({ kind: 'accepted' } as const) : await handle.acceptance;
		assertSessionUnchanged(token, 'upsertStorageEditLive:afterAcceptanceWait');
		if (outcome.kind === 'accepted') {
			const finalRow = await refreshedRowAfterAcceptance(userHash, uuid, projected);
			assertSessionUnchanged(token, 'upsertStorageEditLive:beforeSyncedProjection');
			await kvSet(key, { row: finalRow, hash_b64: hashB64, syncStatus: 'synced' } satisfies LocalStorageEntry, userHash);
			return { row: finalRow, sync: Promise.resolve({ status: 'synced' as const }) };
		}
		const message = outcome.kind === 'rejected' ? outcome.error : 'discarded before delivery';
		await kvSet(key, { row: projected, hash_b64: hashB64, syncStatus: 'failed', syncError: message } satisfies LocalStorageEntry, userHash);
		console.warn(`[userStorage] ${uuid}: sync failed:`, message);
		return { row: projected, sync: Promise.resolve({ status: 'failed' as const, error: message }) };
	} catch (e: unknown) {
		if (e instanceof SessionFencedError) throw e;
		assertSessionUnchanged(token, 'upsertStorageEditLive:beforeFailedProjectionOnThrow');
		const message = String((e as Error)?.message || e);
		await kvSet(key, { row: projected, hash_b64: hashB64, syncStatus: 'failed', syncError: message } satisfies LocalStorageEntry, userHash);
		console.warn(`[userStorage] ${uuid}: sync failed:`, message);
		return { row: projected, sync: Promise.resolve({ status: 'failed' as const, error: e }) };
	}
}

/**
 * Write a slot revision (opaque ciphertext the caller already built).
 *
 * The returned promise resolves once the intent is durable and either
 * signed+settled ('synced'/'failed') or durably waiting on a key or base
 * ('awaiting-recovery') — never as a bare optimistic success. §6: ordering
 * across overlapping writes to the same (user_hash, uuid) is enforced by a
 * cross-tab lock around materialize-then-sign (storageIntent.ts), not a
 * session-local queue, so it holds after reload and between tabs. A genuine
 * server conflict reconciles (reread the authoritative base, reapply this
 * same valueB64, re-sign, retry) rather than quarantining outright — see
 * materializeSignEnqueueStorageIntent.
 */
export function upsertStorageRow(opts: UpsertOptions): Promise<UpsertResult> {
	const { userHash, uuid, valueB64, hashB64, signSkey, deletedFlag = false } = opts;
	return upsertStorageEditLive({ userHash, uuid, deletedFlag, valueB64 }, hashB64, signSkey);
}

export function upsertStorageJsonPatch(opts: UpsertJsonPatchOptions): Promise<UpsertResult> {
	const { userHash, uuid, jsonPatch, signSkey, deletedFlag = false } = opts;
	return upsertStorageEditLive({ userHash, uuid, deletedFlag, jsonPatch }, null, signSkey);
}

/**
 * A write that counts only once the server has it. "Saved on this device" is
 * not something to tell a person who just pressed Save, nor a vault the
 * shares would find, so every caller with a person or a key behind it uses
 * this; upsertStorageRow is for the ones that can live with a local-only row.
 */
export async function putStorageRow(opts: UpsertOptions): Promise<UserStorageRow> {
	return settledOnServer(await upsertStorageRow(opts));
}

/** putStorageRow for a JSON-patch intent (the root record). */
export async function putStorageJsonPatch(opts: UpsertJsonPatchOptions): Promise<UserStorageRow> {
	return settledOnServer(await upsertStorageJsonPatch(opts));
}

// 'awaiting-recovery' is a durable local intent, not a server verdict: it
// throws here just like 'failed', or a caller would report as saved (or show
// shares for) a row the server does not have yet.
async function settledOnServer(write: UpsertResult): Promise<UserStorageRow> {
	const sync = await write.sync;
	if (sync.status !== 'synced') {
		throw new Error('Saved on this device, but the server did not take it', { cause: sync.error ?? sync.status });
	}
	return write.row;
}

/** Sync status of the locally stored revision, for UI indicators. */
export async function getStorageSyncStatus(userHash: string, uuid: string): Promise<StorageSyncStatus | null> {
	const local = await getLocalEntry(userHash, uuid);
	return local?.syncStatus ?? null;
}

export { entityKeyFor as storageEntityKeyFor };

// ---------- account-free reads ----------
//
// Everything above needs an account: the collection is built per user_hash and
// the KV is keyed by it. Recovery has neither, so it reads the raw shape.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Reads the live user_storage rows at one uuid, without an account.
 *
 * Every other reader here goes through the account's collection, because
 * every other caller has an account. Recovery does not: the signing key is
 * gone, so `user_hash` cannot be computed and the collection cannot be built.
 * Reads are public (pq_user_storage §FR-3), and a uuid derived from the
 * recovered secret is enough to name the rows.
 *
 * Plural on purpose. The row key is (user_hash, uuid) and only half of it is
 * known here, so anyone who learns the locator — every guardian does, it
 * travels with their share — can write their own row at the same address.
 * Returning the first match would let one such row shadow the real vault and
 * report the backup as missing. The caller tries each candidate; AES-GCM is
 * what identifies the owner's row, and nothing else can.
 *
 * An empty array means nothing is stored there — a legitimate answer meaning
 * this secret has no backup on this server.
 */
export async function getPublicStorageRowsByUuid(
	uuid: string, signal?: AbortSignal,
): Promise<UserStorageRow[]> {
	// Validation, not sanitization, as with every other identifier this layer
	// puts in a where clause: encodeURIComponent protects the URL, not the SQL
	// behind it, and this uuid can arrive from a guardian's message.
	if (!UUID_RE.test(uuid)) throw new Error(`Invalid user_storage uuid: ${JSON.stringify(uuid)}`);

	// readShapeOnce, not the collection: it forces a fresh snapshot, which
	// matters here because recovery reads a row it may have written seconds ago
	// on another device. wireBool, not a local truthiness test: no Electric
	// parser runs on a raw shape read, so a tombstone arrives as true, 't', 1
	// or '1' depending on the hop, and misreading one hands back a vault its
	// owner deliberately revoked.
	const rows = await readShapeOnce<UserStorageRow>('user_storage', `uuid='${uuid}'`, signal);
	return rows.filter((v) => !wireBool(v.deleted_flag));
}

// user_storage rows without PGlite: local durability via IndexedDB KV,
// server sync via direct signed mutations.
//
// Contract (verified against chat backend tests): the first write of a
// (user_hash, uuid) is an `insert`; every later revision MUST be an `update`
// with parent_sign_hash pointing at the server tip and a strictly newer
// owner_timestamp — a repeated insert is rejected with 422 regardless of
// content.
//
// Two invariants this module enforces:
//   1. A mutation is only signed against a KNOWN server base. "Server
//      unreachable" is not "row absent" — signing an insert from an unknown
//      base produces a guaranteed conflict once connectivity returns.
//   2. Writes to one slot are serialized. Overlapping saves would otherwise
//      sign sibling revisions off the same parent and let a slower-but-older
//      operation overwrite the local cache of a newer one.
import { kvGet, kvSet } from './localStore';
import { getUserStorageCollection } from './collections';
import { sendMutationsAndAwaitShape } from './ingest';
import { nextOwnerTimestamp } from './time';
import { api } from '@/api/client';
import type { UserStorageRow } from './types';

// The user_storage.uuid column is a real Ecto.UUID server-side, so the
// well-known slots need actual UUIDs rather than labels. The primary key is
// (user_hash, uuid), so one fixed UUID per slot is safe across all users.
export const STORAGE_SLOTS = {
	profile: '00000000-0000-4000-8000-000000000001',
	contacts: '00000000-0000-4000-8000-000000000002',
} as const;

// Labels these slots used before the fix — rows written then still sit in the
// local KV store under the old key and must stay readable.
const LEGACY_LABELS: Record<string, string> = {
	[STORAGE_SLOTS.profile]: 'profile',
	[STORAGE_SLOTS.contacts]: 'contacts',
};

export type StorageSyncStatus = 'synced' | 'syncing' | 'failed';

// What we persist locally: the server-shaped row plus local-only metadata.
interface LocalStorageEntry {
	row: UserStorageRow;
	/** local integrity convenience; never sent to the server */
	hash_b64: string | null;
	syncStatus: StorageSyncStatus;
	syncError?: string;
}

/**
 * Server state for one slot. `absent` and `unavailable` are deliberately
 * distinct: only `absent` proves an insert is the right mutation.
 * A tombstone counts as `found` — the logical PK exists, so writes remain
 * updates.
 */
type ServerLookup =
	| { state: 'found'; row: UserStorageRow }
	| { state: 'absent' }
	| { state: 'unavailable'; error: unknown };

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

const getLocalEntry = async (userHash: string, uuid: string): Promise<LocalStorageEntry | undefined> => {
	const direct = normalizeEntry(await kvGet(kvKey(userHash, uuid)).catch(() => undefined));
	if (direct) return direct;

	const legacy = LEGACY_LABELS[uuid];
	if (legacy) {
		return normalizeEntry(await kvGet(kvKey(userHash, legacy)).catch(() => undefined));
	}
	return undefined;
};

export const getServerState = async (userHash: string, uuid: string): Promise<ServerLookup> => {
	const coll = getUserStorageCollection(userHash);
	try {
		await coll.preload();
	} catch (error) {
		return { state: 'unavailable', error };
	}
	const row = coll.get(`${userHash}|${uuid}`) as UserStorageRow | undefined;
	if (!row) return { state: 'absent' };
	// Tombstones included on purpose: the row exists, so a write is an update
	return { state: 'found', row };
};

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
	/** settled by the time this resolves: the server accepted or rejected it */
	sync: Promise<{ status: StorageSyncStatus; error?: unknown }>;
}

// --- per-slot write serialization -------------------------------------------
// Each slot has a promise chain; a queued write reads the server tip only
// after its predecessor has fully settled, so revisions form a linear chain
// and local persistence cannot be reordered by network timing.
const slotQueues = new Map<string, Promise<unknown>>();

function enqueueForSlot<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = slotQueues.get(key) ?? Promise.resolve();
	// run regardless of whether the predecessor resolved or rejected
	const next = previous.then(fn, fn);
	const settled = next.then(
		() => undefined,
		() => undefined
	);
	slotQueues.set(key, settled);
	settled.then(() => {
		if (slotQueues.get(key) === settled) slotQueues.delete(key);
	});
	return next;
}

export interface UpsertOptions {
	userHash: string;
	uuid: string;
	valueB64: string;
	hashB64: string | null;
	signSkey: Uint8Array | null;
}

async function upsertStorageRowSerial(opts: UpsertOptions): Promise<UpsertResult> {
	const { userHash, uuid, valueB64, hashB64, signSkey } = opts;
	const key = kvKey(userHash, uuid);

	const [local, server] = await Promise.all([getLocalEntry(userHash, uuid), getServerState(userHash, uuid)]);

	const persist = (row: UserStorageRow, syncStatus: StorageSyncStatus, syncError?: string) =>
		kvSet(key, { row, hash_b64: hashB64, syncStatus, syncError } satisfies LocalStorageEntry);

	// Server base unknown → do not sign anything. Keep the user's edit locally
	// and report the failure honestly; re-signing against a guessed base would
	// produce a conflict the moment connectivity returns.
	// (A durable outbox that materializes the mutation later is the tracked
	// follow-up — see the offline-first note in the review.)
	if (server.state === 'unavailable') {
		const pendingRow: UserStorageRow = {
			user_hash: userHash,
			uuid,
			value_b64: valueB64,
			deleted_flag: false,
			parent_sign_hash: local?.row.parent_sign_hash ?? null,
			sign_hash: null,
			owner_timestamp: nextOwnerTimestamp(tsOf(local?.row)),
			sign_b64: null,
		};
		await persist(pendingRow, 'failed', 'server state unavailable — not signed');
		return {
			row: pendingRow,
			sync: Promise.resolve({ status: 'failed' as const, error: server.error }),
		};
	}

	const serverRow = server.state === 'found' ? server.row : null;
	const mutationType = serverRow ? 'update' : 'insert';
	const parentSignHash = serverRow?.sign_hash ?? null;
	const ownerTimestamp = nextOwnerTimestamp(Math.max(tsOf(serverRow), tsOf(local?.row)));

	const mutation = api.createStorageMutation(
		userHash, uuid, valueB64, null, 0, ownerTimestamp,
		signSkey, false, false, parentSignHash, null, null, mutationType
	);
	const wire = (mutation.type === 'insert' ? mutation.modified : mutation.changes) as Record<string, unknown>;

	const row: UserStorageRow = {
		user_hash: userHash,
		uuid,
		value_b64: valueB64,
		deleted_flag: false,
		parent_sign_hash: parentSignHash,
		sign_hash: (wire.sign_hash as string) ?? null,
		owner_timestamp: ownerTimestamp,
		sign_b64: (wire.sign_b64 as string) ?? null,
	};

	if (!signSkey) {
		await persist(row, 'failed', 'no signing key');
		return { row, sync: Promise.resolve({ status: 'failed' as const }) };
	}

	await persist(row, 'syncing');
	try {
		// Barrier: the queue must not release the next write for this slot
		// until the committed revision is visible in the shape, otherwise the
		// successor reads a stale (or absent) tip and signs a doomed mutation.
		await sendMutationsAndAwaitShape([mutation], signSkey);
		await persist(row, 'synced');
		return { row, sync: Promise.resolve({ status: 'synced' as const }) };
	} catch (e: unknown) {
		const message = String((e as Error)?.message || e);
		await persist(row, 'failed', message);
		console.warn(`[userStorage] ${uuid}: sync failed:`, message);
		return { row, sync: Promise.resolve({ status: 'failed' as const, error: e }) };
	}
}

/**
 * Write a slot revision. Serialized per (user_hash, uuid): the returned
 * promise resolves only after the server has accepted or rejected the write,
 * so callers can treat it as the definitive outcome.
 */
export function upsertStorageRow(opts: UpsertOptions): Promise<UpsertResult> {
	return enqueueForSlot(kvKey(opts.userHash, opts.uuid), () => upsertStorageRowSerial(opts));
}

/** Sync status of the locally stored revision, for UI indicators. */
export async function getStorageSyncStatus(userHash: string, uuid: string): Promise<StorageSyncStatus | null> {
	const local = await getLocalEntry(userHash, uuid);
	return local?.syncStatus ?? null;
}

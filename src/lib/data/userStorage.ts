// user_storage rows without PGlite: local durability via IndexedDB KV,
// server sync via direct signed mutations.
//
// Contract (verified against chat backend tests): the first write of a
// (user_hash, uuid) is an `insert`; every later revision MUST be an `update`
// with parent_sign_hash pointing at the server tip and a strictly newer
// owner_timestamp — a repeated insert is rejected with 422 regardless of
// content. Freshness between local and server state is compared by
// owner_timestamp only; the server row shape carries no client-side fields.
import { kvGet, kvSet } from './localStore';
import { getUserStorageCollection } from './collections';
import { sendMutationsWithRetry } from './ingest';
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

const getServerRow = async (userHash: string, uuid: string): Promise<UserStorageRow | undefined> => {
	try {
		const coll = getUserStorageCollection();
		await coll.preload();
		const row = coll.get(`${userHash}|${uuid}`) as UserStorageRow | undefined;
		return row && !row.deleted_flag ? row : undefined;
	} catch (e) {
		console.warn('[userStorage] collection read failed:', e);
		return undefined;
	}
};

const tsOf = (row?: UserStorageRow | null): number => Number(row?.owner_timestamp || 0);

/** Freshest readable row: server vs locally pending, by owner_timestamp. */
export async function getStorageRow(userHash: string, uuid: string): Promise<UserStorageRow | null> {
	const [local, server] = await Promise.all([getLocalEntry(userHash, uuid), getServerRow(userHash, uuid)]);

	const localRow = local && !local.row.deleted_flag ? local.row : undefined;
	const candidates = [localRow, server].filter((r): r is UserStorageRow => !!r);
	if (candidates.length === 0) return null;
	return candidates.reduce((a, b) => (tsOf(b) > tsOf(a) ? b : a));
}

export interface UpsertResult {
	row: UserStorageRow;
	/** resolves when the server accepted or definitively rejected the write */
	sync: Promise<{ status: StorageSyncStatus; error?: unknown }>;
}

export async function upsertStorageRow(opts: {
	userHash: string;
	uuid: string;
	valueB64: string;
	hashB64: string | null;
	signSkey: Uint8Array | null;
}): Promise<UpsertResult> {
	const { userHash, uuid, valueB64, hashB64, signSkey } = opts;

	const [local, server] = await Promise.all([getLocalEntry(userHash, uuid), getServerRow(userHash, uuid)]);

	// The mutation type is decided by the SERVER tip, not local state:
	// a server row means this key exists and any revision must be an update.
	const mutationType = server ? 'update' : 'insert';
	const parentSignHash = server?.sign_hash ?? null;
	const ownerTimestamp = nextOwnerTimestamp(Math.max(tsOf(server), tsOf(local?.row)));

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

	const persist = (syncStatus: StorageSyncStatus, syncError?: string) =>
		kvSet(kvKey(userHash, uuid), { row, hash_b64: hashB64, syncStatus, syncError } satisfies LocalStorageEntry);

	if (!signSkey) {
		await persist('failed', 'no signing key');
		return { row, sync: Promise.resolve({ status: 'failed' as const }) };
	}

	await persist('syncing');
	const sync = sendMutationsWithRetry([mutation], signSkey)
		.then(async () => {
			await persist('synced');
			return { status: 'synced' as const };
		})
		.catch(async (e) => {
			await persist('failed', String(e?.message || e));
			console.warn(`[userStorage] ${uuid}: sync failed:`, e?.message || e);
			return { status: 'failed' as const, error: e };
		});

	return { row, sync };
}

/** Sync status of the locally stored revision, for UI indicators. */
export async function getStorageSyncStatus(userHash: string, uuid: string): Promise<StorageSyncStatus | null> {
	const local = await getLocalEntry(userHash, uuid);
	return local?.syncStatus ?? null;
}

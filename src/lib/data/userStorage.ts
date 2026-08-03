// user_storage rows without PGlite: local durability via IndexedDB KV,
// server sync via direct signed mutations, reads preferring the freshest
// of local vs Electric-synced state.
import { kvGet, kvSet } from './localStore';
import { getUserStorageCollection } from './collections';
import { sendMutationsWithRetry, IngestError } from './ingest';
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

const kvKey = (userHash: string, uuid: string) => `us|${userHash}|${uuid}`;

export async function getStorageRow(userHash: string, uuid: string): Promise<UserStorageRow | null> {
	let local = await kvGet<UserStorageRow>(kvKey(userHash, uuid)).catch(() => undefined);

	// Migration read: pick up data saved under the pre-UUID label. The next
	// write lands under the new uuid, so this path fades out on its own.
	const legacy = LEGACY_LABELS[uuid];
	if (!local && legacy) {
		local = await kvGet<UserStorageRow>(kvKey(userHash, legacy)).catch(() => undefined);
	}

	let remote: UserStorageRow | undefined;
	try {
		const coll = getUserStorageCollection();
		await coll.preload();
		remote = coll.get(`${userHash}|${uuid}`);
	} catch (e) {
		console.warn('[userStorage] collection read failed:', e);
	}

	const candidates = [local, remote].filter((r): r is UserStorageRow => !!r && !r.deleted_flag);
	if (candidates.length === 0) return null;
	return candidates.reduce((a, b) => (Number(b.version) > Number(a.version) ? b : a));
}

export async function upsertStorageRow(opts: {
	userHash: string;
	uuid: string;
	valueB64: string;
	hashB64: string | null;
	signSkey: Uint8Array | null;
}): Promise<UserStorageRow> {
	const { userHash, uuid, valueB64, hashB64, signSkey } = opts;
	const current = await getStorageRow(userHash, uuid);
	const version = current ? Number(current.version) + 1 : 0;
	const ownerTimestamp = Math.floor(Date.now() / 1000);

	const row: UserStorageRow = {
		user_hash: userHash,
		uuid,
		version,
		value_b64: valueB64,
		hash_b64: hashB64,
		deleted_flag: false,
		parent_sign_hash: current?.sign_hash ?? null,
		sign_hash: null,
		owner_timestamp: ownerTimestamp,
		sign_b64: null,
	};

	await kvSet(kvKey(userHash, uuid), row);

	if (signSkey) {
		const mutation = api.createStorageMutation(
			userHash, uuid, valueB64, hashB64, version, ownerTimestamp,
			signSkey, false, false, row.parent_sign_hash, null, null, 'insert'
		);
		sendMutationsWithRetry([mutation], signSkey).catch((e) => {
			const note = e instanceof IngestError && e.permanent ? 'rejected by server (stays local-only)' : 'push failed';
			console.warn(`[userStorage] ${uuid}: ${note}:`, e?.message || e);
		});
	}

	return row;
}

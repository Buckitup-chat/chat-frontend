// user_storage rows without PGlite: local durability via IndexedDB KV,
// server sync via direct signed mutations, reads preferring the freshest
// of local vs Electric-synced state.
//
// Known server limitation: rows whose uuid is not a real UUID ('profile',
// 'contacts') are rejected by ingest validation, so those stay local-only
// until the backend relaxes the check. Avatar rows (crypto.randomUUID)
// sync fine.
import { kvGet, kvSet } from './localStore';
import { getUserStorageCollection } from './collections';
import { sendMutationsWithRetry, IngestError } from './ingest';
import { api } from '@/api/client';
import type { UserStorageRow } from './types';

const kvKey = (userHash: string, uuid: string) => `us|${userHash}|${uuid}`;

export async function getStorageRow(userHash: string, uuid: string): Promise<UserStorageRow | null> {
	const local = await kvGet<UserStorageRow>(kvKey(userHash, uuid)).catch(() => undefined);

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

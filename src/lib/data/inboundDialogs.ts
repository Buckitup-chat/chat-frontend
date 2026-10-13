// Who opened a dialog with an account. Participation is derived from
// dialog_keys, `sender_hash = me OR peer_hash = me` (chat repo: pq_dialogs
// § Participation); the rows naming the account as peer are the dialogs
// others started. The rows are read unverified and used only as a list of
// whom to ask: every message read from those dialogs goes through the gate.
import { readShapeOnce } from './shapeRead';
import { wireBool } from '@/lib/pq/schema';

const USER_HASH = /^u_[0-9a-f]{128}$/;

/** The user_hashes that published a dialog key naming `me` as their peer. */
export const peersWhoWrote = async (me: string, signal?: AbortSignal): Promise<string[]> => {
	// Validation, not sanitization: the value goes into a where clause.
	if (!USER_HASH.test(me)) throw new Error(`not a user_hash: ${me}`);
	const rows = await readShapeOnce<{ sender_hash?: string; peer_hash?: string; deleted_flag?: unknown }>('dialog_keys', `peer_hash = '${me}'`, signal);
	const peers = new Set<string>();
	for (const r of rows) {
		if (r.peer_hash !== me || wireBool(r.deleted_flag) || typeof r.sender_hash !== 'string' || !USER_HASH.test(r.sender_hash) || r.sender_hash === me) continue;
		peers.add(r.sender_hash);
	}
	return [...peers];
};

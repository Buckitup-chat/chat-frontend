// Who opened a dialog with an account. Participation is derived from
// dialog_keys, `sender_hash = me OR peer_hash = me` (chat repo: pq_dialogs
// § Participation); the rows naming the account as peer are the dialogs
// others started, kept in one live collection per account. The rows are used
// unverified, only as a list of whom to ask: every message read from those
// dialogs goes through the gate.
import { getInboundDialogKeysCollection } from './collections';
import { wireBool } from '@buckitup/pq-client/schema';

const USER_HASH = /^u_[0-9a-f]{128}$/;

type KeyRow = { sender_hash?: unknown; peer_hash?: unknown; deleted_flag?: unknown };

/** The user_hashes that published a live dialog key naming `me` as their peer: each once, never `me`. */
export const peersIn = (rows: readonly KeyRow[], me: string): string[] => {
	const peers = new Set<string>();
	for (const r of rows) {
		if (r.peer_hash !== me || wireBool(r.deleted_flag) || typeof r.sender_hash !== 'string' || !USER_HASH.test(r.sender_hash) || r.sender_hash === me) continue;
		peers.add(r.sender_hash);
	}
	return [...peers];
};

/** Who opened a dialog with `me`, as the live collection has it now (the first call waits for its snapshot). */
export const peersWhoWrote = async (me: string): Promise<string[]> => {
	const coll = getInboundDialogKeysCollection(me);
	await coll.preload();
	return peersIn(coll.toArray, me);
};

/** Keeps `me`'s collection live while a screen follows it; resolves nothing, returns the way to stop. */
export const followPeersWhoWrote = (me: string): (() => void) => {
	const sub = getInboundDialogKeysCollection(me).subscribeChanges(() => {});
	return () => sub.unsubscribe();
};

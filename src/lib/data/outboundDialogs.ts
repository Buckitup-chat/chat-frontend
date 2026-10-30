import { getOutboundDialogKeysCollection } from './collections';
import { wireBool } from '@buckitup/pq-client/schema';

const USER_HASH = /^u_[0-9a-f]{128}$/;
type KeyRow = { sender_hash?: unknown; peer_hash?: unknown; deleted_flag?: unknown };

export const peersOut = (rows: readonly KeyRow[], me: string): string[] => {
	const peers = new Set<string>();
	for (const row of rows) {
		if (row.sender_hash !== me || wireBool(row.deleted_flag) || typeof row.peer_hash !== 'string' || !USER_HASH.test(row.peer_hash) || row.peer_hash === me) continue;
		peers.add(row.peer_hash);
	}
	return [...peers];
};

export const peersWeWrote = async (me: string): Promise<string[]> => {
	const coll = getOutboundDialogKeysCollection(me);
	await coll.preload();
	return peersOut(coll.toArray, me);
};

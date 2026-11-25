import { getOutboundDialogKeysCollection } from './collections';
import { wireBool } from '@buckitup/pq-client/schema';
import { getVerifiedSignPkey } from './cardRegistry';
import { verifyReplicatedRow, type SignPkeyResolver } from './rowVerification';

const USER_HASH = /^u_[0-9a-f]{128}$/;
type KeyRow = { sender_hash?: unknown; peer_hash?: unknown; deleted_flag?: unknown };

export interface OutboundPeers {
	peers: string[];
	waiting: boolean;
}

export const peersOut = async (
	rows: readonly KeyRow[],
	me: string,
	resolveSignPkey: SignPkeyResolver = getVerifiedSignPkey,
): Promise<OutboundPeers> => {
	const peers = new Set<string>();
	let waiting = false;
	for (const row of rows) {
		if (row.sender_hash !== me || wireBool(row.deleted_flag) || typeof row.peer_hash !== 'string' || !USER_HASH.test(row.peer_hash) || row.peer_hash === me) continue;
		if (peers.has(row.peer_hash)) continue;
		const verdict = await verifyReplicatedRow('dialog_keys', row as Record<string, unknown>, resolveSignPkey);
		if (verdict.status === 'verified') peers.add(row.peer_hash);
		else if (verdict.status === 'unavailable') waiting = true;
	}
	return { peers: [...peers], waiting };
};

export const peersWeWrote = async (me: string): Promise<OutboundPeers> => {
	const coll = getOutboundDialogKeysCollection(me);
	await coll.preload();
	return peersOut(coll.toArray, me);
};

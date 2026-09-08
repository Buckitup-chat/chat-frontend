// HTTP commit → Electric shape barrier.
//
// A 200 from /ingest_each means Postgres committed the transaction; it does
// NOT mean the Electric shape has delivered it. Any operation that reads the
// collection as the base for its next write must wait for the specific txid to
// become visible, otherwise it signs against a stale (or absent) tip and gets
// a guaranteed conflict.
//
// TanStack's Electric collections expose exactly this primitive for writes
// that bypass its own mutation handlers: collection.utils.awaitTxId(txid).
import {
	getDialogCollections,
	getUserCardsCollection,
	getUserStorageCollection,
} from './collections';

interface AwaitableCollection {
	utils?: { awaitTxId?: (txId: number, timeout?: number) => Promise<boolean> };
}

/** How long to wait for a committed txid to appear in the shape. */
export const SHAPE_BARRIER_TIMEOUT_MS = 10_000;

/** Second, longer wait before declaring the read model behind. */
export const SHAPE_BARRIER_RETRY_MS = 20_000;

/**
 * The collection that will serve as the base for subsequent writes of this
 * relation. Dialog tables need the row's dialog_hash to find their shape.
 */
export function collectionForRelation(
	relation: string,
	row: Record<string, unknown> | null | undefined
): AwaitableCollection | null {
	switch (relation) {
		case 'user_cards':
			return getUserCardsCollection();
		case 'user_storage':
			return getUserStorageCollection(String(row?.user_hash || ''));
		case 'dialog_keys':
		case 'dialog_messages':
		case 'dialog_message_reactions':
		case 'dialog_message_receipts': {
			const dialogHash = String(row?.dialog_hash || '');
			if (!dialogHash) return null;
			const colls = getDialogCollections(dialogHash);
			return {
				dialog_keys: colls.keys,
				dialog_messages: colls.messages,
				dialog_message_reactions: colls.reactions,
				dialog_message_receipts: colls.receipts,
			}[relation] as AwaitableCollection;
		}
		default:
			return null;
	}
}

/**
 * The read scope a relation's writes share. Dialog tables are scoped per
 * dialog, user_storage per account: a barrier that timed out in one dialog
 * says nothing about another.
 */
export function scopeForRelation(
	relation: string,
	row: Record<string, unknown> | null | undefined
): string {
	switch (relation) {
		case 'user_storage':
			return `user_storage|${String(row?.user_hash || '')}`;
		case 'dialog_keys':
		case 'dialog_messages':
		case 'dialog_message_reactions':
		case 'dialog_message_receipts':
			return `${relation}|${String(row?.dialog_hash || '')}`;
		default:
			return relation;
	}
}

/**
 * Waits for every txid to become visible in the collection. Returns false when
 * one of them did not arrive in time.
 *
 * A timeout is not a send failure — the server committed, and resending the
 * same mutation because replication lagged would be wrong. But it is also not
 * success: the read model is known to be behind, and anything that builds on
 * it would sign against a stale tip. The caller decides; this only reports.
 *
 * The wait is retried once with a longer budget before giving up, since the
 * common case is a slow shape rather than a lost one.
 */
export async function awaitShapeVisibility(
	collection: AwaitableCollection | null,
	txids: number[],
	label = 'shape'
): Promise<boolean> {
	const awaitTxId = collection?.utils?.awaitTxId;
	if (!awaitTxId || txids.length === 0) return true;

	let visible = true;
	for (const txid of txids) {
		let seen = false;
		for (const budget of [SHAPE_BARRIER_TIMEOUT_MS, SHAPE_BARRIER_RETRY_MS]) {
			try {
				await awaitTxId(txid, budget);
				seen = true;
				break;
			} catch (e) {
				console.warn(`[data] ${label}: txid ${txid} not visible within ${budget}ms:`, e);
			}
		}
		if (!seen) visible = false;
	}
	return visible;
}

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
			return getUserStorageCollection();
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
 * Block until every txid is visible in the collection.
 *
 * A timeout is logged and swallowed rather than thrown: the write itself did
 * succeed, and failing the caller because replication was slow would be worse
 * than proceeding with a possibly stale base (which the conflict path already
 * handles).
 */
export async function awaitShapeVisibility(
	collection: AwaitableCollection | null,
	txids: number[],
	label = 'shape'
): Promise<void> {
	const awaitTxId = collection?.utils?.awaitTxId;
	if (!awaitTxId || txids.length === 0) return;

	for (const txid of txids) {
		try {
			await awaitTxId(txid, SHAPE_BARRIER_TIMEOUT_MS);
		} catch (e) {
			console.warn(`[data] ${label}: txid ${txid} not visible within the barrier timeout:`, e);
		}
	}
}

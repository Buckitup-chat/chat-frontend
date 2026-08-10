// Identity check for idempotent retries.
//
// A unique-key conflict from the server only proves that SOME row with that
// key exists — not that it is the row we tried to write. Treating every
// "has already been taken" as success silently swallows lost updates (the
// third-party review, finding 3). The honest rule: a conflicting insert is a
// success only if the server row is byte-identical to ours, which we can
// verify by comparing signatures — a retry re-sends the same signed object.
import { getDialogCollections, getUserCardsCollection, getUserStorageCollection } from './collections';

interface MutationLike {
	type?: string;
	modified?: Record<string, unknown>;
	changes?: Record<string, unknown>;
	syncMetadata?: { relation?: string };
}

const rowOf = (m: MutationLike): Record<string, unknown> | null => m.modified ?? m.changes ?? null;

const lookup = async (relation: string, row: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
	switch (relation) {
		case 'user_cards': {
			const coll = getUserCardsCollection();
			await coll.preload();
			return coll.get(String(row.user_hash)) as Record<string, unknown> | undefined;
		}
		case 'user_storage': {
			const coll = getUserStorageCollection();
			await coll.preload();
			return coll.get(`${row.user_hash}|${row.uuid}`) as Record<string, unknown> | undefined;
		}
		case 'dialog_keys':
		case 'dialog_messages':
		case 'dialog_message_reactions':
		case 'dialog_message_receipts': {
			const dialogHash = String(row.dialog_hash || '');
			if (!dialogHash) return undefined;
			const colls = getDialogCollections(dialogHash);
			const byRelation = {
				dialog_keys: () => colls.keys.get(`${row.dialog_hash}|${row.sender_hash}`),
				dialog_messages: () => colls.messages.get(String(row.message_id)),
				dialog_message_reactions: () => colls.reactions.get(String(row.reaction_hash)),
				dialog_message_receipts: () => colls.receipts.get(String(row.receipt_hash)),
			} as const;
			const coll = {
				dialog_keys: colls.keys,
				dialog_messages: colls.messages,
				dialog_message_reactions: colls.reactions,
				dialog_message_receipts: colls.receipts,
			}[relation];
			await coll.preload();
			return byRelation[relation as keyof typeof byRelation]() as Record<string, unknown> | undefined;
		}
		default:
			return undefined;
	}
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * True iff the server already holds exactly the row this mutation carries
 * (same signature). Polls the live collection briefly: the conflicting row
 * arrives through the shape stream, which may lag the 422 by a moment.
 */
export async function mutationAppliedOnServer(mutation: MutationLike, opts: { attempts?: number; delayMs?: number } = {}): Promise<boolean> {
	const { attempts = 4, delayMs = 500 } = opts;
	const relation = mutation.syncMetadata?.relation;
	const row = rowOf(mutation);
	if (!relation || !row || !row.sign_b64) return false;

	for (let i = 0; i < attempts; i++) {
		try {
			const remote = await lookup(relation, row);
			if (remote) {
				return remote.sign_b64 === row.sign_b64;
			}
		} catch (e) {
			console.warn('[data] confirm lookup failed:', e);
		}
		if (i < attempts - 1) await sleep(delayMs);
	}
	return false;
}

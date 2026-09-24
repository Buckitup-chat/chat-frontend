// Causal admission rules for dialog messages (invariants/04_ordering.md,
// pq_dialogs.done.md §References).
//
// refs_map_b64 is the authoritative causal frontier; UUIDv7 order is only
// advisory. The server cannot validate any of this — the map is ciphertext to
// it — so the ingest rules are the frontend's job and nobody else's: refs
// resolve locally, no self-reference, and a message whose parents have not
// arrived waits instead of rendering as ordered.
//
// Roots: a message with an empty map observed nothing — the start of the
// dialog from its author's point of view. Two messages may observe the same
// tails, the empty scope of a fresh dialog included (two first messages sent
// before either was signed or seen); that is a fork at the root, merged by
// the next message that cites both, and never serialized away
// (main-tanstack-proposal-v3.md §427–441, manual plan DLG-03). Which root
// arrived first cannot make the other invalid — that would depend on
// delivery order and give two clients different histories.
//
// Pure: the caller decrypts refs (keys differ per author) and tracks which
// revisions it has already admitted and which can never be admitted.

export interface RevisionRef {
	messageId: string;
	signHash: string;
}

export type DagVerdict =
	| { status: 'ok'; isGenesis: boolean }
	| { status: 'waiting'; missing: RevisionRef[] }
	| { status: 'blocked'; blockedBy: RevisionRef[] }
	| { status: 'violation'; reason: 'self_reference' };

export const revisionKey = (messageId: string, signHash: string) => `${messageId}|${signHash}`;

export const validateRefs = (
	revision: RevisionRef,
	refs: Record<string, string>,
	opts: {
		/** revisions already admitted in this dialog, by revisionKey */
		hasRevision: (key: string) => boolean;
		/** revisions that can never be admitted (definitively invalid, or
		 * themselves blocked), by revisionKey */
		isTerminal?: (key: string) => boolean;
	},
): DagVerdict => {
	const entries = Object.entries(refs);

	// A root (empty scope). Any number of them is a root fork, not a violation.
	if (entries.length === 0) return { status: 'ok', isGenesis: true };

	const missing: RevisionRef[] = [];
	const blockedBy: RevisionRef[] = [];
	for (const [refId, refSignHash] of entries) {
		// The spec forbids the exact pair: a message must not cite its own
		// revision (04_ordering.md rule 4). Citing an older revision of the
		// same message_id is the edit chain's business, not a violation here.
		if (refId === revision.messageId && refSignHash === revision.signHash) {
			return { status: 'violation', reason: 'self_reference' };
		}
		const key = revisionKey(refId, refSignHash);
		if (opts.hasRevision(key)) continue;
		if (opts.isTerminal?.(key)) blockedBy.push({ messageId: refId, signHash: refSignHash });
		else missing.push({ messageId: refId, signHash: refSignHash });
	}

	if (blockedBy.length > 0) return { status: 'blocked', blockedBy };
	// Unresolved refs are out-of-order delivery, not an error: Electric gives
	// no ordering guarantee, so the message queues until its parents arrive.
	if (missing.length > 0) return { status: 'waiting', missing };
	return { status: 'ok', isGenesis: false };
};

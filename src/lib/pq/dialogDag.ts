// Causal admission rules for dialog messages (invariants/04_ordering.md).
//
// refs_map_b64 is the authoritative causal frontier; UUIDv7 order is only
// advisory. The server cannot validate any of this — the map is ciphertext to
// it — so these four ingest rules are the frontend's job and nobody else's:
// refs resolve locally, at most one genesis, no self-reference, and a message
// whose parents have not arrived waits instead of rendering as ordered.
//
// Pure: the caller decrypts refs (keys differ per author) and tracks which
// revisions it has already admitted.

export interface RevisionRef {
	messageId: string;
	signHash: string;
}

export type DagVerdict =
	| { status: 'ok'; isGenesis: boolean }
	| { status: 'waiting'; missing: RevisionRef[] }
	| { status: 'violation'; reason: 'self_reference' | 'duplicate_genesis' };

export const revisionKey = (messageId: string, signHash: string) => `${messageId}|${signHash}`;

export const validateRefs = (
	revision: RevisionRef,
	refs: Record<string, string>,
	opts: {
		/** revisions already admitted in this dialog, by revisionKey */
		hasRevision: (key: string) => boolean;
		/** a genesis (empty-map) message has already been admitted */
		genesisSeen: boolean;
	},
): DagVerdict => {
	const entries = Object.entries(refs);

	if (entries.length === 0) {
		// Only one message per dialog may carry an empty map. A second one is
		// a protocol violation surfaced to the UI as a fork at the root — not
		// silently rendered as another beginning of the conversation.
		if (opts.genesisSeen) return { status: 'violation', reason: 'duplicate_genesis' };
		return { status: 'ok', isGenesis: true };
	}

	const missing: RevisionRef[] = [];
	for (const [refId, refSignHash] of entries) {
		// The spec forbids the exact pair: a message must not cite its own
		// revision (04_ordering.md rule 4). Citing an older revision of the
		// same message_id is the edit chain's business, not a violation here.
		if (refId === revision.messageId && refSignHash === revision.signHash) {
			return { status: 'violation', reason: 'self_reference' };
		}
		if (!opts.hasRevision(revisionKey(refId, refSignHash))) {
			missing.push({ messageId: refId, signHash: refSignHash });
		}
	}

	// Unresolved refs are out-of-order delivery, not an error: Electric gives
	// no ordering guarantee, so the message queues until its parents arrive.
	if (missing.length > 0) return { status: 'waiting', missing };
	return { status: 'ok', isGenesis: false };
};

// Causal references for dialog messages (chat docs: pq_dialogs.md §References).
//
// refs_map_b64 carries the DAG tails the sender observed at authoring time:
// a map of {message_id: sign_hash}. A tail is a (message_id, sign_hash) pair
// — a specific revision — that no loaded message's refs_map references.
// Transitive reduction keeps the map small: referencing the latest message
// implicitly covers everything it referenced.
//
// This module is the pure computation; decryption of each row's refs_map is
// the caller's job (the sender key differs per author).

export interface LoadedMessageRefs {
	message_id: string;
	/** current revision of this message as loaded */
	sign_hash: string;
	/**
	 * Decrypted refs_map of that revision: {message_id: sign_hash}.
	 * `null` means "unknown" — the sender key has not arrived yet or the blob
	 * could not be decrypted. Unknown refs contribute nothing to the
	 * referenced set, so the result is a conservative superset of the true
	 * tails (over-claiming what was observed, never under-claiming). The
	 * alternative — blocking the send until everything decrypts — would stall
	 * exactly the common case where a peer's first message and their key
	 * arrive together.
	 */
	refs: Record<string, string> | null;
}

const pair = (mid: string, sh: string) => `${mid}|${sh}`;

/**
 * Tail set per the spec:
 * 1) collect every (message_id, sign_hash) referenced by any loaded message;
 * 2) a loaded message whose exact current pair is not referenced is a tail.
 *
 * An edit produces a new sign_hash, so the edited message becomes a new tail
 * even if its previous revision is referenced elsewhere — intentional: the
 * refs record exactly which revisions the sender observed.
 */
export function computeTails(loaded: LoadedMessageRefs[]): Record<string, string> {
	const referenced = new Set<string>();
	for (const row of loaded) {
		// null = unknown refs; contributes nothing, yielding extra tails
		// rather than pretending the revision referenced nothing
		if (!row.refs) continue;
		for (const [mid, sh] of Object.entries(row.refs)) {
			referenced.add(pair(mid, sh));
		}
	}

	const tails: Record<string, string> = {};
	for (const row of loaded) {
		if (!row.sign_hash) continue;
		if (!referenced.has(pair(row.message_id, row.sign_hash))) {
			tails[row.message_id] = row.sign_hash;
		}
	}
	return tails;
}

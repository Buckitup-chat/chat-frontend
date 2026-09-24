// Per-operation write contracts (ADR §7 + the barrier inventory appendix).
//
// What a mutation needs — its dependency class, and whether the write must
// wait for shape visibility or only for server acceptance — is part of the
// operation's contract, not of the caller's memory. The dispatch coordinator
// reads these descriptors; changing a row of the agreed barrier table is a
// one-line data edit here, not an architecture change.
//
// Confirmation levels (§7.3): a prerequisite is satisfied by SERVER_ACCEPTED;
// shape visibility is a separate, stronger condition required only when the
// dependent step actually reads the row from replicated state.

export type DependencyClass =
	/** §7.1 — supersedes an existing row; new links block on a stale base. */
	| 'chained'
	/** §7.2 — creates a new row from captured local scope; never blocked on
	 * unrelated confirmations. */
	| 'independent'
	/** §7.3 — other rows are only accepted once this one exists server-side. */
	| 'prerequisite-provider';

export type ConfirmationLevel =
	/** Exact server confirmation ends the wait; nothing reads the shape next. */
	| 'accepted'
	/** The next step reads this scope from replicated state — await the echo. */
	| 'visible';

export interface WriteContract {
	dependencyClass: DependencyClass;
	confirmation: ConfirmationLevel;
}

const CONTRACTS: Record<string, { insert: WriteContract; update?: WriteContract }> = {
	user_cards: {
		// Prerequisite for every signed row of the account (§7.3); nothing on
		// this client reads the card back from the shape as a write base.
		insert: { dependencyClass: 'prerequisite-provider', confirmation: 'accepted' },
		update: { dependencyClass: 'chained', confirmation: 'accepted' },
	},
	dialog_keys: {
		// Prerequisite for messages/reactions in the dialog on the SERVER side
		// (v3 "HTTP → shape barrier" table): the dependent write only needs
		// this key accepted, never visible in the shape. This client's own
		// "have I already published a key" check (ensureOwnDialogKeyPublished
		// in messageIntent.ts) does read the shape row first, but falls back
		// to the durable accepted snapshot (acceptedSnapshot.ts, recorded by
		// coordinator.ts's reconcileAccepted on every acceptance regardless of
		// this confirmation level) before ever minting a fresh wrap — so a
		// shape that hasn't caught up yet, including right after a reload,
		// does not risk a second, PK-conflicting randomized wrap.
		insert: { dependencyClass: 'prerequisite-provider', confirmation: 'accepted' },
	},
	dialog_messages: {
		insert: { dependencyClass: 'independent', confirmation: 'accepted' },
		update: { dependencyClass: 'chained', confirmation: 'accepted' },
	},
	dialog_message_reactions: {
		insert: { dependencyClass: 'independent', confirmation: 'accepted' },
		update: { dependencyClass: 'chained', confirmation: 'accepted' },
	},
	dialog_message_receipts: {
		// terminal: nothing ever reads a receipt back as a write base
		insert: { dependencyClass: 'independent', confirmation: 'accepted' },
	},
	user_storage: {
		// 'accepted' is sufficient: coordinator.ts's reconcileAccepted records
		// an accepted snapshot for user_storage (keyed by user_hash|uuid), and
		// storageIntent.ts's materializeStorageIntent reads that snapshot plus
		// the outbox's own not-yet-accepted entry for the same slot
		// (pendingChainRow) as the write base — never the replicated shape.
		// A shape-visibility wait would only matter for a caller that reads
		// the row back from the shape as its base; nothing does (unlike
		// dialog_keys, whose own republish check does read the shape).
		insert: { dependencyClass: 'chained', confirmation: 'accepted' },
		update: { dependencyClass: 'chained', confirmation: 'accepted' },
	},
	files: {
		// the manifest is read back only by resume's salted one-shot reader
		insert: { dependencyClass: 'independent', confirmation: 'accepted' },
	},
};

const FALLBACK: WriteContract = { dependencyClass: 'chained', confirmation: 'visible' };

export const OWNER_FIELD: Record<string, string> = {
	user_cards: 'user_hash',
	user_storage: 'user_hash',
	dialog_keys: 'sender_hash',
	dialog_messages: 'sender_hash',
	dialog_messages_versions: 'sender_hash',
	dialog_message_reactions: 'reactor_hash',
	dialog_message_receipts: 'peer_hash',
	files: 'uploader_hash',
};

/**
 * The contract for one mutation. Unknown relations get the conservative
 * fallback: treat as chained, await visibility — a new relation must opt in
 * to weaker guarantees explicitly, never receive them by omission.
 */
export function contractFor(relation: string | undefined, mutationType: string | undefined): WriteContract {
	if (!relation) return FALLBACK;
	const entry = CONTRACTS[relation];
	if (!entry) return FALLBACK;
	if (mutationType === 'update' && entry.update) return entry.update;
	return entry.insert;
}

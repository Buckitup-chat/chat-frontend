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
		// Prerequisite for messages/reactions in the dialog — the server checks
		// its own store, not our shape.
		insert: { dependencyClass: 'prerequisite-provider', confirmation: 'accepted' },
	},
	dialog_messages: {
		// CONTESTED rows of the barrier table (№6-8): stays 'visible' until the
		// coordinator decision on "own snapshot as a trusted base" — the next
		// send's refs and the next edit's tip are currently read from the shape.
		insert: { dependencyClass: 'independent', confirmation: 'visible' },
		update: { dependencyClass: 'chained', confirmation: 'visible' },
	},
	dialog_message_reactions: {
		insert: { dependencyClass: 'independent', confirmation: 'accepted' },
		// toggle reads the stored row's owner_timestamp — contested (№9), keep
		update: { dependencyClass: 'chained', confirmation: 'visible' },
	},
	dialog_message_receipts: {
		// terminal: nothing ever reads a receipt back as a write base
		insert: { dependencyClass: 'independent', confirmation: 'accepted' },
	},
	user_storage: {
		// CONTESTED (№3/4): the per-slot queue reads the tip from the shape;
		// stays 'visible' until the coordinator decision.
		insert: { dependencyClass: 'chained', confirmation: 'visible' },
		update: { dependencyClass: 'chained', confirmation: 'visible' },
	},
	files: {
		// the manifest is read back only by resume's salted one-shot reader
		insert: { dependencyClass: 'independent', confirmation: 'accepted' },
	},
};

const FALLBACK: WriteContract = { dependencyClass: 'chained', confirmation: 'visible' };

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

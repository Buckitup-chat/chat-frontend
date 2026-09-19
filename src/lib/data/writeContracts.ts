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
		// — but this client also reads the row back from the shape as its own
		// "have I published a key yet" check (initDialogKeysUnguarded), so
		// 'accepted' left a window where a second call in the same dialog saw
		// "absent" and republished with a fresh (incompatible) key wrapping,
		// permanently conflicting with itself. Await the echo.
		insert: { dependencyClass: 'prerequisite-provider', confirmation: 'visible' },
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
		// 'visible' until the accepted-base actually exists for this relation:
		// userStorage.ts reads freshestOf(serverRow, acceptedLocal) as its
		// write base, but nothing records an accepted snapshot for
		// user_storage (the coordinator's ENTITY_KEY_FIELD does not cover
		// it), so under 'accepted' the next slot edit would chain onto a
		// possibly-stale shape row with no stale-scope protection at all.
		insert: { dependencyClass: 'chained', confirmation: 'visible' },
		update: { dependencyClass: 'chained', confirmation: 'visible' },
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

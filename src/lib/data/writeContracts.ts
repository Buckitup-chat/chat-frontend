export type DependencyClass =
	| 'chained'
	| 'independent'
	| 'prerequisite-provider';

export type ConfirmationLevel =
	| 'accepted'
	| 'visible';

export interface WriteContract {
	dependencyClass: DependencyClass;
	confirmation: ConfirmationLevel;
}

const CONTRACTS: Record<string, { insert: WriteContract; update?: WriteContract }> = {
	user_cards: {
		insert: { dependencyClass: 'prerequisite-provider', confirmation: 'accepted' },
		update: { dependencyClass: 'chained', confirmation: 'accepted' },
	},
	dialog_keys: {
		insert: { dependencyClass: 'prerequisite-provider', confirmation: 'accepted' },
	},
	dialog_messages: {
		insert: { dependencyClass: 'independent', confirmation: 'visible' },
		update: { dependencyClass: 'chained', confirmation: 'visible' },
	},
	dialog_message_reactions: {
		insert: { dependencyClass: 'independent', confirmation: 'accepted' },
		update: { dependencyClass: 'chained', confirmation: 'visible' },
	},
	dialog_message_receipts: {
		insert: { dependencyClass: 'independent', confirmation: 'accepted' },
	},
	user_storage: {
		insert: { dependencyClass: 'chained', confirmation: 'visible' },
		update: { dependencyClass: 'chained', confirmation: 'visible' },
	},
	files: {
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
};

export function contractFor(relation: string | undefined, mutationType: string | undefined): WriteContract {
	if (!relation) return FALLBACK;
	const entry = CONTRACTS[relation];
	if (!entry) return FALLBACK;
	if (mutationType === 'update' && entry.update) return entry.update;
	return entry.insert;
}

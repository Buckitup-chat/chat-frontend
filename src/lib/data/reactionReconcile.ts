// Which optimistic reaction items a set of confirmed server rows resolves
// (§3.5 — echo race protection). Extracted from Page_Chat.vue's inline loop:
// pure logic, no Vue/collection dependency, so it is testable without
// mounting the component (main-tanstack-proposal-v3.md's "dialogDisplay.ts"
// pattern — a pure merge/format layer, not reintroduced elsewhere yet).
//
// The echo-race invariant this exists to prove: a confirmation resolves an
// optimistic intent only when it matches BOTH the exact desired end state
// AND the exact message revision the intent targeted. Matching on either
// alone would let a stale echo — an old confirmation for a since-superseded
// revision, or a confirmation of someone else's still-pending toggle of the
// same reaction — falsely close out an intent it does not actually confirm.
export interface OptimisticReactionItem {
	id: string;
	type: string;
	dialogHash: string;
	messageId: string;
	reactionHash: string;
	desiredActive: boolean;
}

export interface ServerReactionRow {
	reaction_hash: string;
	deleted_flag: boolean;
	message_sign_hash: string | null;
}

/**
 * Ids of optimistic reaction items that `serverRows` now confirms — safe to
 * remove from the optimistic overlay.
 */
export function reconcileOptimisticReactions(
	optimisticItems: Iterable<OptimisticReactionItem>,
	serverRows: ServerReactionRow[],
	dialogHash: string,
	currentSignHashOf: (messageId: string) => string | null | undefined
): string[] {
	const resolved: string[] = [];
	for (const item of optimisticItems) {
		if (item.type !== 'reaction' || item.dialogHash !== dialogHash) continue;
		const serverRow = serverRows.find((r) => r.reaction_hash === item.reactionHash);
		if (!serverRow) continue;
		const confirmedActive =
			!serverRow.deleted_flag && serverRow.message_sign_hash === currentSignHashOf(item.messageId);
		if (confirmedActive === item.desiredActive) resolved.push(item.id);
	}
	return resolved;
}

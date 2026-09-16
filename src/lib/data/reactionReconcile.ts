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

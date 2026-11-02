// A checkpoint compared with the dialog as it is now, for showing: the
// dialog's feed (tap on a checkpoint marker) and the Checkpoints screen both
// ask the same three questions of the dialogs store in the same order.

/** The dialogs store's checkpoint calls this needs. */
export interface CheckpointComparer {
	verifyDialogCheckpoint(peerHash: string, part: CheckpointPart): Promise<{ status: string; missingEventIds?: string[] }>;
	compareDialogCheckpoint(peerHash: string, part: CheckpointPart, opts: { pointerMessageId: string }): Promise<{ verdict: string }>;
	describeCheckpointDiff(peerHash: string, part: CheckpointPart, opts: { pointerMessageId: string }): Promise<{
		status: string;
		changes?: Array<{ type: string; messageId: string; senderHash?: string | null }>;
		futureAdded?: { count: number; firstMessageId: string | null };
	}>;
}

export interface CheckpointPart {
	createdAt: number;
	[key: string]: unknown;
}

export type CheckpointComparison =
	| {
		kind: 'diff';
		createdAt: number;
		changes: Array<{ type: string; messageId: string; senderHash?: string | null }>;
		futureAdded: { count: number; firstMessageId: string | null };
	}
	| { kind: 'verdict'; createdAt: number; text: string };

/**
 * The commitments are checked and the roots compared first; only a valid
 * checkpoint whose view moved gets the detailed diff — attested history
 * message by message, the unbounded continuation as one marker. Anything
 * else is reported as the verdicts themselves.
 */
export const loadCheckpointComparison = async (
	dialogs: CheckpointComparer,
	peerHash: string,
	part: CheckpointPart,
	messageId: string,
): Promise<CheckpointComparison> => {
	const [verify, compare] = await Promise.all([
		dialogs.verifyDialogCheckpoint(peerHash, part),
		dialogs.compareDialogCheckpoint(peerHash, part, { pointerMessageId: messageId }),
	]);
	if (verify.status === 'valid' && compare.verdict === 'VIEW_CHANGED') {
		const diff = await dialogs.describeCheckpointDiff(peerHash, part, { pointerMessageId: messageId });
		if (diff.status === 'ok' && diff.changes && diff.futureAdded && (diff.changes.length || diff.futureAdded.count)) {
			return { kind: 'diff', createdAt: part.createdAt, changes: diff.changes, futureAdded: diff.futureAdded };
		}
	}
	const text = `Commitments: ${verify.status}` +
		(verify.status === 'incomplete_history' ? ` (${verify.missingEventIds?.length ?? 0} missing)` : '') +
		`\nAgainst current state: ${compare.verdict}`;
	return { kind: 'verdict', createdAt: part.createdAt, text };
};

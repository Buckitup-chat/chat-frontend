// What a checkpoint comparison comes to, in words: the Checkpoints screen
// sums up each dialog that moved, and the comparison's header says how much.
// Pure — the comparison itself is describeCheckpointDiff (dialogs.store).
import { plural } from '@/lib/recovery/backupPlan';

/** One change behind the checkpoint, as describeCheckpointDiff returns it. */
export interface CheckpointChange {
	type: string;
	messageId: string;
}

/** New messages ahead of the checkpoint, collapsed. */
export interface FutureAdded {
	count: number;
	firstMessageId?: string | null;
}

export interface CheckpointCounts {
	edited: number;
	deleted: number;
	added: number;
	restored: number;
	missing: number;
	/** Changes to the history the checkpoint signed, all kinds together. */
	signed: number;
	/** Messages written after the checkpoint. */
	newAfter: number;
}

/** A change's kind in a word: "edited". */
export const CHANGE_KIND: Record<string, keyof CheckpointCounts> = {
	MESSAGE_EDITED: 'edited',
	MESSAGE_DELETED: 'deleted',
	MESSAGE_ADDED: 'added',
	MESSAGE_RESTORED: 'restored',
	MESSAGE_REMOVED: 'missing',
};

export const countCheckpointChanges = (
	changes: CheckpointChange[] = [],
	futureAdded: FutureAdded | null = null,
): CheckpointCounts => {
	const counts: CheckpointCounts = { edited: 0, deleted: 0, added: 0, restored: 0, missing: 0, signed: 0, newAfter: 0 };
	for (const c of changes) {
		const kind = CHANGE_KIND[c.type];
		if (kind) counts[kind] += 1;
		counts.signed += 1;
	}
	counts.newAfter = futureAdded?.count ?? 0;
	return counts;
};

/**
 * "2 edits, 1 deleted · 3 new after": what changed in the signed history,
 * then what came after it. Only the parts that are there; '' for nothing.
 */
export const checkpointSummaryText = (c: CheckpointCounts): string => {
	const signed = [
		c.edited && plural(c.edited, 'edit', 'edits'),
		c.deleted && `${c.deleted} deleted`,
		c.added && `${c.added} added`,
		c.restored && `${c.restored} restored`,
		c.missing && `${c.missing} missing`,
	].filter(Boolean).join(', ');
	return [signed, c.newAfter && `${c.newAfter} new after`].filter(Boolean).join(' · ');
};

/** "3 changes to signed history · 3 new after", or "no changes". */
export const checkpointChangesLine = (c: CheckpointCounts): string => {
	const parts = [];
	if (c.signed) parts.push(`${plural(c.signed, 'change', 'changes')} to signed history`);
	if (c.newAfter) parts.push(`${c.newAfter} new after`);
	return parts.join(' · ') || 'no changes';
};

export interface CheckpointEntry {
	peerHash: string;
	changed: boolean;
	createdAt: number;
}

/** Dialogs that moved and dialogs that did not, newest checkpoint first in each. */
export const groupCheckpointDialogs = <T extends CheckpointEntry>(entries: T[]): { changed: T[]; unchanged: T[] } => {
	const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
	return { changed: sorted.filter((e) => e.changed), unchanged: sorted.filter((e) => !e.changed) };
};

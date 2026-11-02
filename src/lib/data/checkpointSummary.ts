// What a checkpoint comparison comes to, in words: the Checkpoints screen
// sums up each dialog that moved, and the comparison's header says how much.
// Pure — the comparison itself is describeCheckpointDiff (dialogs.store).

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

const KIND: Record<string, keyof CheckpointCounts> = {
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
		const kind = KIND[c.type];
		if (kind) counts[kind] += 1;
		counts.signed += 1;
	}
	counts.newAfter = futureAdded?.count ?? 0;
	return counts;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

// Spelled out, not Intl's: en-GB abbreviates September to "Sept" in some
// engines and "Sep" in others.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "12 Oct, 18:04" in the device's time zone; the year only when it is not this one. */
export const checkpointTime = (sec: number, now: Date = new Date()): string => {
	const d = new Date(sec * 1000);
	const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`;
	return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

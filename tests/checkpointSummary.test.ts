// What a checkpoint comparison comes to, in words, for the Checkpoints screen
// and the comparison's header.
import { describe, it, expect } from 'vitest';
import {
	countCheckpointChanges, checkpointSummaryText, checkpointChangesLine, groupCheckpointDialogs,
} from '@/lib/data/checkpointSummary';
import { shortDayTime } from '@/lib/shortDate';

const change = (type: string, n: number) => ({ type, messageId: `dmsg_${type}_${n}` });

describe('checkpoint summary', () => {
	it('counts each kind of change behind the checkpoint and the new messages after it', () => {
		const counts = countCheckpointChanges(
			[change('MESSAGE_EDITED', 1), change('MESSAGE_EDITED', 2), change('MESSAGE_DELETED', 3), change('MESSAGE_REMOVED', 4)],
			{ count: 3, firstMessageId: 'dmsg_x' },
		);
		expect(counts).toEqual({ edited: 2, deleted: 1, added: 0, restored: 0, missing: 1, signed: 4, newAfter: 3 });
	});

	it('names only the parts that are there', () => {
		const text = (changes: ReturnType<typeof change>[], after = 0) =>
			checkpointSummaryText(countCheckpointChanges(changes, after ? { count: after } : null));
		expect(text([change('MESSAGE_EDITED', 1), change('MESSAGE_EDITED', 2), change('MESSAGE_DELETED', 3)], 3))
			.toBe('2 edits, 1 deleted · 3 new after');
		expect(text([change('MESSAGE_EDITED', 1)])).toBe('1 edit');
		expect(text([], 1)).toBe('1 new after');
		expect(text([change('MESSAGE_ADDED', 1), change('MESSAGE_RESTORED', 2)])).toBe('1 added, 1 restored');
		expect(text([])).toBe('');
	});

	it('says how much of the signed history changed', () => {
		expect(checkpointChangesLine(countCheckpointChanges([change('MESSAGE_EDITED', 1), change('MESSAGE_DELETED', 2), change('MESSAGE_EDITED', 3)], { count: 3 })))
			.toBe('3 changes to signed history · 3 new after');
		expect(checkpointChangesLine(countCheckpointChanges([change('MESSAGE_EDITED', 1)]))).toBe('1 change to signed history');
		expect(checkpointChangesLine(countCheckpointChanges([]))).toBe('no changes');
	});

	it('dates a checkpoint by day and time, with the year only when it is not this one', () => {
		const at = (y: number) => Math.floor(new Date(y, 9, 12, 18, 4).getTime() / 1000);
		expect(shortDayTime(at(2026), new Date(2026, 10, 2))).toBe('12 Oct, 18:04');
		expect(shortDayTime(at(2025), new Date(2026, 10, 2))).toBe('12 Oct 2025, 18:04');
		const sep = Math.floor(new Date(2026, 8, 28, 9, 5).getTime() / 1000);
		expect(shortDayTime(sep, new Date(2026, 10, 2))).toBe('28 Sep, 09:05');
	});

	it('groups changed and unchanged dialogs, newest checkpoint first', () => {
		const { changed, unchanged } = groupCheckpointDialogs([
			{ peerHash: 'a', changed: false, createdAt: 10 },
			{ peerHash: 'b', changed: true, createdAt: 5 },
			{ peerHash: 'c', changed: false, createdAt: 30 },
			{ peerHash: 'd', changed: true, createdAt: 20 },
		]);
		expect(changed.map((e) => e.peerHash)).toEqual(['d', 'b']);
		expect(unchanged.map((e) => e.peerHash)).toEqual(['c', 'a']);
	});
});

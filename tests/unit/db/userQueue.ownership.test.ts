import { describe, it, expect } from 'vitest';
import { selectOwnedEntries } from '@/utils/db/tanstack/userQueue';
import type { QueueEntry, UserTable } from '@/utils/db/tanstack/userQueue';

function entry(table: UserTable, userHash: string, extra: Record<string, unknown> = {}): QueueEntry {
	return {
		id: `${table}:${userHash}`,
		table,
		key: userHash,
		status: 'pending',
		revision: 1,
		record: { user_hash: userHash, ...extra },
	} as unknown as QueueEntry;
}

describe('selectOwnedEntries — account/signing scoping', () => {
	it("account A's pending mutation is excluded when flushing as B", () => {
		const entries = [entry('user_cards', 'u_alice', { name: 'Alice' })];
		const forB = selectOwnedEntries(entries, 'u_bob');
		expect(forB).toEqual([]);
	});

	it("switching back to A picks the same entry up again — nothing was discarded", () => {
		const entries = [entry('user_cards', 'u_alice', { name: 'Alice' })];
		const forB = selectOwnedEntries(entries, 'u_bob');
		const forA = selectOwnedEntries(entries, 'u_alice');
		expect(forB).toHaveLength(0);
		expect(forA).toHaveLength(1);
		expect(forA[0].record.user_hash).toBe('u_alice');
	});

	it('a mixed queue only ever yields the requested owner\'s entries, for both tables', () => {
		const entries = [
			entry('user_cards', 'u_alice'),
			entry('user_storage', 'u_alice', { uuid: 'profile' }),
			entry('user_cards', 'u_bob'),
			entry('user_storage', 'u_bob', { uuid: 'profile' }),
		];

		const forAlice = selectOwnedEntries(entries, 'u_alice');
		const forBob = selectOwnedEntries(entries, 'u_bob');

		expect(forAlice).toHaveLength(2);
		expect(forAlice.every((e) => e.record.user_hash === 'u_alice')).toBe(true);
		expect(forBob).toHaveLength(2);
		expect(forBob.every((e) => e.record.user_hash === 'u_bob')).toBe(true);
	});

	it('an entry with no owner information yet is never accidentally selected for anyone', () => {
		const entries = [
			{ id: 'user_cards:broken', table: 'user_cards', key: 'broken', status: 'pending', revision: 1, record: {} } as unknown as QueueEntry,
		];
		expect(selectOwnedEntries(entries, 'u_alice')).toEqual([]);
		expect(selectOwnedEntries(entries, undefined)).toEqual([]);
	});
});

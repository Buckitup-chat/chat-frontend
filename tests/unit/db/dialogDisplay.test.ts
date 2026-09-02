import { describe, it, expect } from 'vitest';
import {
	mergeDialogMessagesForDisplay,
	mergeDialogReactionsForDisplay,
	preferAckedCache,
	isDialogMessagePending,
	shouldRedecryptMessage,
	compareByOwnerTimestamp,
	formatMessageTime,
} from '@/utils/db/tanstack/dialogDisplay';

const DIALOG_A = 'di_a';

describe('preferAckedCache — normal precedence', () => {
	it('cache wins while awaitingEcho is true', () => {
		const network = { v: 'network' };
		const cached = { v: 'cache', __awaitingEcho: true };
		expect(preferAckedCache(network, cached)).toBe(cached);
	});

	it('network wins once the gate is open (__awaitingEcho false/absent)', () => {
		const network = { v: 'network' };
		const cached = { v: 'cache', __awaitingEcho: false };
		expect(preferAckedCache(network, cached)).toBe(network);
		expect(preferAckedCache(network, { v: 'cache' })).toBe(network);
	});

	it('falls back to whichever side exists; null/undefined when both absent', () => {
		const row = { v: 1 };
		expect(preferAckedCache(row, null)).toBe(row);
		expect(preferAckedCache(null, row)).toBe(row);
		expect(preferAckedCache(null, undefined)).toBeUndefined();
	});
});

describe('mergeDialogMessagesForDisplay — normal precedence and filtering', () => {
	it('pending overrides synced (cache/network) for the same message_id', () => {
		const cached = [{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, content_b64: 'synced', deleted_flag: false, owner_timestamp: 1 }];
		const pending = [{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, content_b64: 'in-flight', deleted_flag: false, owner_timestamp: 1 }];
		const result = mergeDialogMessagesForDisplay(cached, [], pending, DIALOG_A);
		expect(result).toHaveLength(1);
		expect(result[0].content_b64).toBe('in-flight');
	});

	it('cache/network merge follows preferAckedCache for the same message_id', () => {
		const cached = [{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, content_b64: 'cache', deleted_flag: false, owner_timestamp: 1, __awaitingEcho: true }];
		const network = [{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, content_b64: 'network', deleted_flag: false, owner_timestamp: 1 }];
		expect(mergeDialogMessagesForDisplay(cached, network, [], DIALOG_A)[0].content_b64).toBe('cache');
	});

	it('deleted_flag filtering: false is visible', () => {
		const rows = [{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, deleted_flag: false, owner_timestamp: 1 }];
		expect(mergeDialogMessagesForDisplay(rows, [], [], DIALOG_A)).toHaveLength(1);
	});

	it('deleted_flag filtering: true is excluded', () => {
		const rows = [{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, deleted_flag: true, owner_timestamp: 1 }];
		expect(mergeDialogMessagesForDisplay(rows, [], [], DIALOG_A)).toEqual([]);
	});

	it('deleted_flag filtering: null/undefined is excluded (fail-closed, matches old SQL NOT deleted_flag)', () => {
		const nullRow = [{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, deleted_flag: null as unknown as boolean, owner_timestamp: 1 }];
		const undefinedRow = [{ message_id: 'dmsg_2', dialog_hash: DIALOG_A, owner_timestamp: 1 }];
		expect(mergeDialogMessagesForDisplay(nullRow, [], [], DIALOG_A)).toEqual([]);
		expect(mergeDialogMessagesForDisplay(undefinedRow, [], [], DIALOG_A)).toEqual([]);
	});

	it('excludes rows from a different dialog_hash', () => {
		const rows = [{ message_id: 'dmsg_1', dialog_hash: 'di_other', deleted_flag: false, owner_timestamp: 1 }];
		expect(mergeDialogMessagesForDisplay(rows, [], [], DIALOG_A)).toEqual([]);
	});

	it('sorts ascending by owner_timestamp', () => {
		const rows = [
			{ message_id: 'dmsg_3', dialog_hash: DIALOG_A, deleted_flag: false, owner_timestamp: 300 },
			{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, deleted_flag: false, owner_timestamp: 100 },
			{ message_id: 'dmsg_2', dialog_hash: DIALOG_A, deleted_flag: false, owner_timestamp: 200 },
		];
		expect(mergeDialogMessagesForDisplay(rows, [], [], DIALOG_A).map((r) => r.message_id)).toEqual(['dmsg_1', 'dmsg_2', 'dmsg_3']);
	});

	it('null/undefined source arrays are treated as empty', () => {
		expect(mergeDialogMessagesForDisplay(null, undefined, null, DIALOG_A)).toEqual([]);
	});
});

describe('mergeDialogReactionsForDisplay — normal precedence and filtering', () => {
	it('pending overrides synced for the same reaction_hash', () => {
		const cached = [{ reaction_hash: 'dmr_1', dialog_hash: DIALOG_A, message_id: 'dmsg_1', deleted_flag: false }];
		const pending = [{ reaction_hash: 'dmr_1', dialog_hash: DIALOG_A, message_id: 'dmsg_1', deleted_flag: true }];
		expect(mergeDialogReactionsForDisplay(cached, [], pending, DIALOG_A)).toEqual([]);
	});

	it('deleted_flag filtering: false visible, true and null/undefined excluded', () => {
		const visible = [{ reaction_hash: 'dmr_1', dialog_hash: DIALOG_A, message_id: 'dmsg_1', deleted_flag: false }];
		const deleted = [{ reaction_hash: 'dmr_2', dialog_hash: DIALOG_A, message_id: 'dmsg_1', deleted_flag: true }];
		const nullFlag = [{ reaction_hash: 'dmr_3', dialog_hash: DIALOG_A, message_id: 'dmsg_1', deleted_flag: null as unknown as boolean }];
		expect(mergeDialogReactionsForDisplay(visible, [], [], DIALOG_A)).toHaveLength(1);
		expect(mergeDialogReactionsForDisplay(deleted, [], [], DIALOG_A)).toEqual([]);
		expect(mergeDialogReactionsForDisplay(nullFlag, [], [], DIALOG_A)).toEqual([]);
	});

	it('a removed (deleted) reaction does not appear even though a stale synced copy still shows it active, once pending confirms the removal', () => {
		const cached = [{ reaction_hash: 'dmr_1', dialog_hash: DIALOG_A, message_id: 'dmsg_1', deleted_flag: false, __awaitingEcho: false }];
		const pending = [{ reaction_hash: 'dmr_1', dialog_hash: DIALOG_A, message_id: 'dmsg_1', deleted_flag: true }];
		expect(mergeDialogReactionsForDisplay(cached, [], pending, DIALOG_A)).toEqual([]);
	});

	it('distinct reaction_hash rows for the same message all survive the merge', () => {
		const rows = [
			{ reaction_hash: 'dmr_alice', dialog_hash: DIALOG_A, message_id: 'dmsg_1', deleted_flag: false },
			{ reaction_hash: 'dmr_bob', dialog_hash: DIALOG_A, message_id: 'dmsg_1', deleted_flag: false },
		];
		expect(mergeDialogReactionsForDisplay(rows, [], [], DIALOG_A)).toHaveLength(2);
	});

	it('excludes rows from a different dialog_hash', () => {
		const rows = [{ reaction_hash: 'dmr_1', dialog_hash: 'di_other', message_id: 'dmsg_1', deleted_flag: false }];
		expect(mergeDialogReactionsForDisplay(rows, [], [], DIALOG_A)).toEqual([]);
	});
});

describe('isDialogMessagePending', () => {
	it('true when the message_id is present in the pending array', () => {
		expect(isDialogMessagePending('dmsg_1', [{ message_id: 'dmsg_1' }])).toBe(true);
	});

	it('false when absent, empty, null, or undefined', () => {
		expect(isDialogMessagePending('dmsg_1', [])).toBe(false);
		expect(isDialogMessagePending('dmsg_1', null)).toBe(false);
		expect(isDialogMessagePending('dmsg_1', undefined)).toBe(false);
		expect(isDialogMessagePending('dmsg_1', [{ message_id: 'dmsg_other' }])).toBe(false);
	});
});

describe('shouldRedecryptMessage', () => {
	it('true when there is no cached decryption entry yet', () => {
		expect(shouldRedecryptMessage(undefined, { content_b64: 'c' })).toBe(true);
	});

	it('false when content_b64 is unchanged since the cached decryption', () => {
		expect(shouldRedecryptMessage({ _contentB64: 'c' }, { content_b64: 'c' })).toBe(false);
	});

	it('true when content_b64 changed (an edit landed)', () => {
		expect(shouldRedecryptMessage({ _contentB64: 'old' }, { content_b64: 'new' })).toBe(true);
	});
});

describe('compareByOwnerTimestamp — deterministic ordering', () => {
	it('orders ascending for plain numbers', () => {
		expect(compareByOwnerTimestamp({ ownerTimestamp: 100 }, { ownerTimestamp: 200 })).toBeLessThan(0);
		expect(compareByOwnerTimestamp({ ownerTimestamp: 200 }, { ownerTimestamp: 100 })).toBeGreaterThan(0);
		expect(compareByOwnerTimestamp({ ownerTimestamp: 100 }, { ownerTimestamp: 100 })).toBe(0);
	});

	it('handles bigint _raw.owner_timestamp values without throwing, comparable to plain numbers', () => {
		const bigintRow = { _raw: { owner_timestamp: 300n } };
		const numberRow = { ownerTimestamp: 100 };
		expect(() => compareByOwnerTimestamp(bigintRow, numberRow)).not.toThrow();
		expect(compareByOwnerTimestamp(bigintRow, numberRow)).toBeGreaterThan(0);
	});

	it('missing timestamps are treated as 0, not a crash', () => {
		expect(() => compareByOwnerTimestamp({}, {})).not.toThrow();
		expect(compareByOwnerTimestamp({}, {})).toBe(0);
	});
});

describe('formatMessageTime — stable contract only (no timezone-fragile assertions)', () => {
	it('formats to an HH:MM shaped string', () => {
		expect(formatMessageTime(1700000000)).toMatch(/^\d{2}:\d{2}$/);
	});

	it('bigint and number inputs for the same value format identically', () => {
		expect(formatMessageTime(1700000000n)).toBe(formatMessageTime(1700000000));
	});

	it('missing/null input does not throw', () => {
		expect(() => formatMessageTime(undefined)).not.toThrow();
		expect(() => formatMessageTime(null)).not.toThrow();
		expect(formatMessageTime(undefined)).toMatch(/^\d{2}:\d{2}$/);
	});
});

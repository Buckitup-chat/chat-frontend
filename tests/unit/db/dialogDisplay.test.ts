import { describe, it, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { DialogMessageFields } from '@/utils/db/tanstack/dialogQueue';
import {
	mergeDialogMessagesForDisplay,
	mergeDialogReactionsForDisplay,
	preferAckedCache,
	isDialogMessagePending,
	shouldRedecryptMessage,
	compareByOwnerTimestamp,
	formatMessageTime,
	getDialogMessageCreatedAtMs,
	getDialogMessageDisplayTimestamp,
	isDialogMessageEdited,
} from '@/utils/db/tanstack/dialogDisplay';

const DIALOG_A = 'di_a';

function fakeDialogMessageId(createdAtMs: number, tail = '000000000000'): string {
	const hex = createdAtMs.toString(16).padStart(12, '0');
	return `dmsg_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${tail}`;
}

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

describe('compareByOwnerTimestamp — deterministic secondary tie-break (burst-send ordering fix)', () => {
	it('Test F: timestamp primary ordering is unchanged when timestamps differ', () => {
		const a = { ownerTimestamp: 100, message_id: 'dmsg_zzz' };
		const b = { ownerTimestamp: 200, message_id: 'dmsg_aaa' };

		expect(compareByOwnerTimestamp(a, b)).toBeLessThan(0);
		expect(compareByOwnerTimestamp(b, a)).toBeGreaterThan(0);
	});

	it('Test G: equal timestamp is resolved deterministically by message_id, regardless of input order', () => {
		const a = { ownerTimestamp: 100, message_id: 'dmsg_bbbbbbbb' };
		const b = { ownerTimestamp: 100, message_id: 'dmsg_aaaaaaaa' };

		const sortedBA = [b, a].sort(compareByOwnerTimestamp).map((m) => m.message_id);
		const sortedAB = [a, b].sort(compareByOwnerTimestamp).map((m) => m.message_id);

		expect(sortedBA).toEqual(sortedAB);
		expect(sortedBA).toEqual(['dmsg_aaaaaaaa', 'dmsg_bbbbbbbb']);
		expect(compareByOwnerTimestamp(a, b)).not.toBe(0);
	});

	it('Test H: same-timestamp group sorts identically regardless of pre-sort (arrival vs. reload/cache-hydration) order', () => {
		const A = { ownerTimestamp: 100, message_id: 'dmsg_A' };
		const B = { ownerTimestamp: 100, message_id: 'dmsg_B' };
		const C = { ownerTimestamp: 100, message_id: 'dmsg_C' };
		const D = { ownerTimestamp: 100, message_id: 'dmsg_D' };

		const liveArrivalOrder = [A, B, C, D];
		const hydratedCacheOrder = [C, A, D, B];

		const sortedLive = [...liveArrivalOrder].sort(compareByOwnerTimestamp).map((m) => m.message_id);
		const sortedHydrated = [...hydratedCacheOrder].sort(compareByOwnerTimestamp).map((m) => m.message_id);

		expect(sortedHydrated).toEqual(sortedLive);
	});

	it('Test I: real uuid@14 v7() ids — lexical order matches call/creation order, including multiple calls within the same millisecond', () => {
		const ids = Array.from({ length: 20 }, () => 'dmsg_' + uuidv7());
		const messages = ids.map((message_id) => ({ ownerTimestamp: 100, message_id }));

		const shuffled = [...messages].reverse();
		const sorted = shuffled.sort(compareByOwnerTimestamp).map((m) => m.message_id);

		expect(sorted).toEqual(ids);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('documents the limitation: message_id ordering is not authoritative across different senders/devices (client clock skew)', () => {
		const laterWallClockButSkewedBehindDevice = { ownerTimestamp: 100, message_id: 'dmsg_' + '0'.repeat(8) };
		const earlierWallClockButSkewedAheadDevice = { ownerTimestamp: 100, message_id: 'dmsg_' + 'f'.repeat(8) };
		expect(compareByOwnerTimestamp(laterWallClockButSkewedBehindDevice, earlierWallClockButSkewedAheadDevice)).toBeLessThan(0);
	});
});

describe('compareByOwnerTimestamp — legacy (non-UUIDv7) ids: unchanged owner_timestamp does not move a row', () => {
	it('a re-upserted row with the same owner_timestamp sorts back to its original position, not to the end', () => {
		const msgA = { message_id: 'dmsg_a', ownerTimestamp: 100 };
		const msgB = { message_id: 'dmsg_b', ownerTimestamp: 200 };
		const msgC = { message_id: 'dmsg_c', ownerTimestamp: 300 };

		const editedB = { ...msgB };
		const afterEditUpsertOrder = [msgA, msgC, editedB];

		const sorted = afterEditUpsertOrder.sort(compareByOwnerTimestamp).map((m) => m.message_id);
		expect(sorted).toEqual(['dmsg_a', 'dmsg_b', 'dmsg_c']);
	});
});

describe('getDialogMessageCreatedAtMs — extracting the immutable creation time from a UUIDv7 message_id', () => {
	it('Test E/F prerequisite: a valid "dmsg_" + UUIDv7 id returns the exact embedded creation ms', () => {
		expect(getDialogMessageCreatedAtMs(fakeDialogMessageId(1_700_000_000_000))).toBe(1_700_000_000_000);
		expect(getDialogMessageCreatedAtMs(fakeDialogMessageId(0))).toBe(0);
	});

	it('agrees with a real uuid@14 v7() id: the extracted creation ms is within the call\'s own timing window', () => {
		const before = Date.now();
		const id = 'dmsg_' + uuidv7();
		const after = Date.now();
		const createdAtMs = getDialogMessageCreatedAtMs(id);
		expect(createdAtMs).not.toBeNull();
		expect(createdAtMs!).toBeGreaterThanOrEqual(before);
		expect(createdAtMs!).toBeLessThanOrEqual(after);
	});

	it('Test H prerequisite: returns null for anything that is not a valid v7 id (legacy fallback trigger)', () => {
		expect(getDialogMessageCreatedAtMs('dmsg_not-a-uuid')).toBeNull();
		expect(getDialogMessageCreatedAtMs('dmsg_' + '0'.repeat(8))).toBeNull();
		expect(getDialogMessageCreatedAtMs(undefined)).toBeNull();
		expect(getDialogMessageCreatedAtMs(null)).toBeNull();
		expect(getDialogMessageCreatedAtMs(42)).toBeNull();
		expect(getDialogMessageCreatedAtMs('')).toBeNull();
		expect(getDialogMessageCreatedAtMs('dmsg_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d')).toBeNull();
		expect(getDialogMessageCreatedAtMs(fakeDialogMessageId(1000).slice('dmsg_'.length))).toBeNull();
	});
});

describe('compareByOwnerTimestamp — UUIDv7 creation time drives order; edit-advanced owner_timestamp does not (Test E/F)', () => {
	it('Test E: sort order follows creation time even though the edited row\'s owner_timestamp is now the largest', () => {
		const A = { message_id: fakeDialogMessageId(100), owner_timestamp: 100 };
		const B = { message_id: fakeDialogMessageId(200), owner_timestamp: 999_999 };
		const C = { message_id: fakeDialogMessageId(300), owner_timestamp: 300 };

		const sorted = [A, B, C].sort(compareByOwnerTimestamp).map((m) => m.message_id);
		expect(sorted).toEqual([A.message_id, B.message_id, C.message_id]);
	});

	it('Test F: hydration/arrival order does not matter — the final order is identical regardless of pre-sort order', () => {
		const A = { message_id: fakeDialogMessageId(100), owner_timestamp: 100 };
		const B = { message_id: fakeDialogMessageId(200), owner_timestamp: 999_999 };
		const C = { message_id: fakeDialogMessageId(300), owner_timestamp: 300 };

		const liveOrder = [A, B, C];
		const hydratedOrder = [C, A, B];

		const sortedLive = [...liveOrder].sort(compareByOwnerTimestamp).map((m) => m.message_id);
		const sortedHydrated = [...hydratedOrder].sort(compareByOwnerTimestamp).map((m) => m.message_id);

		expect(sortedLive).toEqual([A.message_id, B.message_id, C.message_id]);
		expect(sortedHydrated).toEqual(sortedLive);
	});

	it('mergeDialogMessagesForDisplay uses the same canonical ordering as compareByOwnerTimestamp (single source of truth)', () => {
		const rows = [
			{ message_id: fakeDialogMessageId(300), dialog_hash: DIALOG_A, deleted_flag: false, owner_timestamp: 300 },
			{ message_id: fakeDialogMessageId(100), dialog_hash: DIALOG_A, deleted_flag: false, owner_timestamp: 100 },
			{ message_id: fakeDialogMessageId(200), dialog_hash: DIALOG_A, deleted_flag: false, owner_timestamp: 999_999 },
		];
		const merged = mergeDialogMessagesForDisplay(rows, [], [], DIALOG_A);
		expect(merged.map((r) => r.message_id)).toEqual([fakeDialogMessageId(100), fakeDialogMessageId(200), fakeDialogMessageId(300)]);
	});
});

describe('getDialogMessageDisplayTimestamp — bubble HH:MM time survives an edit (Test G)', () => {
	it('Test G: derives the seconds-since-epoch from the UUIDv7 creation time, ignoring a much larger owner_timestamp', () => {
		const createdAtMs = 1_700_000_000_000;
		const row = { message_id: fakeDialogMessageId(createdAtMs), owner_timestamp: 9_999_999_999 };
		expect(getDialogMessageDisplayTimestamp(row)).toBe(createdAtMs / 1000);
		expect(getDialogMessageDisplayTimestamp(row)).not.toBe(row.owner_timestamp);
		expect(formatMessageTime(getDialogMessageDisplayTimestamp(row))).toBe(formatMessageTime(createdAtMs / 1000));
	});

	it('Test H: legacy (non-v7) ids continue to format using owner_timestamp — no crash, no wrong fallback', () => {
		const row = { message_id: 'dmsg_legacy_row', owner_timestamp: 1_700_000_000 };
		expect(getDialogMessageDisplayTimestamp(row)).toBe(1_700_000_000);
	});

	it('missing/undefined message_id falls back to owner_timestamp', () => {
		expect(getDialogMessageDisplayTimestamp({ owner_timestamp: 555 })).toBe(555);
	});
});

describe('isDialogMessageEdited — parent_sign_hash is the sole canonical "edited" marker', () => {
	it('Test A: an original message (parent_sign_hash null) is not edited', () => {
		const row = { message_id: 'dmsg_original', parent_sign_hash: null };
		expect(isDialogMessageEdited(row)).toBe(false);
	});

	it('Test A variant: parent_sign_hash absent/undefined is also not edited', () => {
		const rowWithoutParentSignHash = { message_id: 'dmsg_original', parent_sign_hash: undefined };
		expect(isDialogMessageEdited(rowWithoutParentSignHash)).toBe(false);
		expect(isDialogMessageEdited(undefined)).toBe(false);
		expect(isDialogMessageEdited(null)).toBe(false);
	});

	it('Test B: a first edit (parent_sign_hash set to the original version\'s sign_hash) is edited', () => {
		const row = { message_id: 'dmsg_x', parent_sign_hash: 'dms_prev' };
		expect(isDialogMessageEdited(row)).toBe(true);
	});

	it('Test C: a later version in the chain (parent_sign_hash advanced to v2) is still edited', () => {
		const row = { message_id: 'dmsg_x', parent_sign_hash: 'dms_v2' };
		expect(isDialogMessageEdited(row)).toBe(true);
	});

	it('PART 6: the marker does not depend on owner_timestamp, deleted_flag, or content — only parent_sign_hash', () => {
		const deletedButChained = { owner_timestamp: 999, deleted_flag: true, parent_sign_hash: 'dms_v3' };
		expect(isDialogMessageEdited(deletedButChained)).toBe(true);
		const brandNewRow = { owner_timestamp: 999, content_b64: 'c', parent_sign_hash: null };
		expect(isDialogMessageEdited(brandNewRow)).toBe(false);
	});
});

describe('mergeDialogMessagesForDisplay — the edited marker survives cache/network/pending merge and reload (Test D/E)', () => {
	it('Test D: an edited pending row overrides a stale (pre-edit) network row, and the marker is not lost', () => {
		const network: DialogMessageFields[] = [{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, content_b64: 'original', deleted_flag: false, owner_timestamp: 100, parent_sign_hash: null }];
		const pending: DialogMessageFields[] = [{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, content_b64: 'edited', deleted_flag: false, owner_timestamp: 501, parent_sign_hash: 'dms_prev' }];

		const merged = mergeDialogMessagesForDisplay([], network, pending, DIALOG_A);
		expect(merged).toHaveLength(1);
		expect(isDialogMessageEdited(merged[0])).toBe(true);
	});

	it('Test E: a reload-style row — only a synced cache/network row with parent_sign_hash, no pending/optimistic state — is still marked edited', () => {
		const cachedOnlyAfterReload = [
			{ message_id: 'dmsg_1', dialog_hash: DIALOG_A, content_b64: 'edited version', deleted_flag: false, owner_timestamp: 501, parent_sign_hash: 'dms_prev' },
		];

		const merged = mergeDialogMessagesForDisplay(cachedOnlyAfterReload, [], [], DIALOG_A);
		expect(merged).toHaveLength(1);
		expect(isDialogMessageEdited(merged[0])).toBe(true);
	});

	it('an untouched original row surviving the same merge is not marked edited', () => {
		const cachedOnlyAfterReload = [
			{ message_id: 'dmsg_2', dialog_hash: DIALOG_A, content_b64: 'never edited', deleted_flag: false, owner_timestamp: 200, parent_sign_hash: null },
		];

		const merged = mergeDialogMessagesForDisplay(cachedOnlyAfterReload, [], [], DIALOG_A);
		expect(isDialogMessageEdited(merged[0])).toBe(false);
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

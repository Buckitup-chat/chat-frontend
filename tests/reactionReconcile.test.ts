import { describe, it, expect } from 'vitest';
import { reconcileOptimisticReactions } from '@/lib/data/reactionReconcile';
import type { OptimisticReactionItem, ServerReactionRow } from '@/lib/data/reactionReconcile';

const DIALOG = 'di_' + '1'.repeat(128);
const OTHER_DIALOG = 'di_' + '2'.repeat(128);
const R1 = 'dms_' + 'a'.repeat(128);
const R2 = 'dms_' + 'b'.repeat(128);

const item = (over: Partial<OptimisticReactionItem>): OptimisticReactionItem => ({
	id: 'opt_1', type: 'reaction', dialogHash: DIALOG, messageId: 'dmsg_1',
	reactionHash: 'dmr_1', desiredActive: true, ...over,
});

const row = (over: Partial<ServerReactionRow>): ServerReactionRow => ({
	reaction_hash: 'dmr_1', deleted_flag: false, message_sign_hash: R1, ...over,
});

const signHashIsR1 = () => R1;

describe('reconcileOptimisticReactions: happy path', () => {
	it('resolves a reaction-on intent once the server row confirms it active on the right revision', () => {
		const resolved = reconcileOptimisticReactions(
			[item({ desiredActive: true })], [row({ deleted_flag: false, message_sign_hash: R1 })], DIALOG, signHashIsR1
		);
		expect(resolved).toEqual(['opt_1']);
	});

	it('resolves a reaction-off (un-react) intent once the row tombstones on the right revision', () => {
		const resolved = reconcileOptimisticReactions(
			[item({ desiredActive: false })], [row({ deleted_flag: true, message_sign_hash: R1 })], DIALOG, signHashIsR1
		);
		expect(resolved).toEqual(['opt_1']);
	});

	it('leaves an intent unresolved while no matching server row exists yet', () => {
		const resolved = reconcileOptimisticReactions([item({})], [], DIALOG, signHashIsR1);
		expect(resolved).toEqual([]);
	});
});

describe('reconcileOptimisticReactions: echo race (§3.5)', () => {
	it('a confirmation for a superseded revision does not resolve an intent on the current one', () => {
		const currentIsR2 = () => R2;
		const resolved = reconcileOptimisticReactions(
			[item({ desiredActive: true })],
			[row({ deleted_flag: false, message_sign_hash: R1 })],
			DIALOG,
			currentIsR2
		);
		expect(resolved).toEqual([]);
	});

	it('a stale confirmation of the OPPOSITE desired state never resolves a newer, conflicting intent', () => {
		const stale = item({ id: 'opt_stale_on', desiredActive: true });
		const current = item({ id: 'opt_current_off', desiredActive: false });
		const resolved = reconcileOptimisticReactions(
			[stale, current], [row({ deleted_flag: true, message_sign_hash: R1 })], DIALOG, signHashIsR1
		);
		expect(resolved).toEqual(['opt_current_off']);
		expect(resolved).not.toContain('opt_stale_on');
	});

	it('a row for a different reaction_hash never resolves an unrelated intent', () => {
		const resolved = reconcileOptimisticReactions(
			[item({ reactionHash: 'dmr_mine' })], [row({ reaction_hash: 'dmr_someone_elses' })], DIALOG, signHashIsR1
		);
		expect(resolved).toEqual([]);
	});
});

describe('reconcileOptimisticReactions: scoping', () => {
	it('ignores items from a different dialog', () => {
		const resolved = reconcileOptimisticReactions(
			[item({ dialogHash: OTHER_DIALOG })], [row({})], DIALOG, signHashIsR1
		);
		expect(resolved).toEqual([]);
	});

	it('ignores non-reaction optimistic items (e.g. messages) entirely', () => {
		const resolved = reconcileOptimisticReactions(
			[item({ type: 'message' })], [row({})], DIALOG, signHashIsR1
		);
		expect(resolved).toEqual([]);
	});
});

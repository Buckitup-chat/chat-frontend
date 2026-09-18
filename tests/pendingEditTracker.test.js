import { describe, it, expect } from 'vitest';
import { claimPendingEdit, submitPendingEdit, failPendingEdit, reconcilePendingEditsWithVerifiedRows } from '@/lib/data/pendingEditTracker';

describe('pendingEditTracker: identity-checked claim/submit/fail (§R4)', () => {
	it('submit moves a current claim to awaiting_echo without removing it', () => {
		const map = new Map();
		const token = claimPendingEdit(map, 'm1', 'hello');

		expect(submitPendingEdit(map, 'm1', token, 'sig_A', 101)).toBe(true);
		expect(map.get('m1')).toMatchObject({ text: 'hello', status: 'awaiting_echo', targetSignHash: 'sig_A', targetOwnerTimestamp: 101 });
	});

	it('fail marks the entry as errored when it is still the current one', () => {
		const map = new Map();
		const token = claimPendingEdit(map, 'm1', 'hello');
		const error = new Error('boom');

		expect(failPendingEdit(map, 'm1', token, error)).toBe(true);
		expect(map.get('m1')).toMatchObject({ text: 'hello', status: 'error', error });
	});

	it('a later edit is not moved to awaiting_echo by an earlier one\'s late submit', () => {
		const map = new Map();
		const tokenA = claimPendingEdit(map, 'm1', 'edit A');
		const tokenB = claimPendingEdit(map, 'm1', 'edit B');

		expect(submitPendingEdit(map, 'm1', tokenA, 'sig_A', 100)).toBe(false);
		expect(map.get('m1')).toMatchObject({ text: 'edit B', status: 'syncing', token: tokenB });
	});

	it('a later edit\'s awaiting_echo state is not overwritten by an earlier one\'s late failure', () => {
		const map = new Map();
		const tokenA = claimPendingEdit(map, 'm1', 'edit A');
		const tokenB = claimPendingEdit(map, 'm1', 'edit B');

		expect(submitPendingEdit(map, 'm1', tokenB, 'sig_B', 200)).toBe(true);
		expect(failPendingEdit(map, 'm1', tokenA, new Error('stale'))).toBe(false);
		expect(map.get('m1')).toMatchObject({ text: 'edit B', status: 'awaiting_echo', targetSignHash: 'sig_B' });
	});

	it('a later edit\'s in-flight state is not stamped with an earlier one\'s error', () => {
		const map = new Map();
		const tokenA = claimPendingEdit(map, 'm1', 'edit A');
		const tokenB = claimPendingEdit(map, 'm1', 'edit B');

		expect(failPendingEdit(map, 'm1', tokenA, new Error('A failed'))).toBe(false);
		expect(map.get('m1')).toMatchObject({ text: 'edit B', status: 'syncing', token: tokenB });
	});

	describe('reconcilePendingEditsWithVerifiedRows: identity is sign_hash, never owner_timestamp or plaintext', () => {
		it('1. clears an awaiting_echo entry once a verified row matches its exact sign_hash', () => {
			const map = new Map();
			const token = claimPendingEdit(map, 'm1', 'edit A');
			submitPendingEdit(map, 'm1', token, 'sig_A', 500);

			const cleared = reconcilePendingEditsWithVerifiedRows(map, [{ id: 'm1', signHash: 'sig_A' }]);

			expect(cleared).toEqual(['m1']);
			expect(map.has('m1')).toBe(false);
		});

		it('2. same message and owner_timestamp but a different sign_hash does not clear the overlay', () => {
			const map = new Map();
			const token = claimPendingEdit(map, 'm1', 'edit A');
			submitPendingEdit(map, 'm1', token, 'sig_A', 500);

			const cleared = reconcilePendingEditsWithVerifiedRows(map, [{ id: 'm1', signHash: 'sig_X', ownerTimestamp: 500 }]);

			expect(cleared).toEqual([]);
			expect(map.get('m1')).toMatchObject({ status: 'awaiting_echo', targetSignHash: 'sig_A' });
		});

		it('3. same plaintext and owner_timestamp but a different sign_hash does not clear the overlay', () => {
			const map = new Map();
			const token = claimPendingEdit(map, 'm1', 'same text');
			submitPendingEdit(map, 'm1', token, 'sig_A', 500);

			const cleared = reconcilePendingEditsWithVerifiedRows(map, [{ id: 'm1', signHash: 'sig_X', ownerTimestamp: 500 }]);

			expect(cleared).toEqual([]);
			expect(map.get('m1').targetSignHash).toBe('sig_A');
		});

		it('4. an old verified A does not clear a newer pending B', () => {
			const map = new Map();
			const tokenA = claimPendingEdit(map, 'm1', 'edit A');
			submitPendingEdit(map, 'm1', tokenA, 'sig_A', 100);
			const tokenB = claimPendingEdit(map, 'm1', 'edit B');
			submitPendingEdit(map, 'm1', tokenB, 'sig_B', 200);

			const cleared = reconcilePendingEditsWithVerifiedRows(map, [{ id: 'm1', signHash: 'sig_A' }]);

			expect(cleared).toEqual([]);
			expect(map.get('m1')).toMatchObject({ text: 'edit B', status: 'awaiting_echo', targetSignHash: 'sig_B' });
		});

		it('does not clear an entry that is still syncing (dispatch has not even completed)', () => {
			const map = new Map();
			claimPendingEdit(map, 'm1', 'edit A');

			const cleared = reconcilePendingEditsWithVerifiedRows(map, [{ id: 'm1', signHash: undefined }]);

			expect(cleared).toEqual([]);
			expect(map.get('m1').status).toBe('syncing');
		});

		it('never matches when both sides lack a known identity', () => {
			const map = new Map();
			const token = claimPendingEdit(map, 'm1', 'edit A');
			submitPendingEdit(map, 'm1', token, null, 500);

			const cleared = reconcilePendingEditsWithVerifiedRows(map, [{ id: 'm1', signHash: null }]);

			expect(cleared).toEqual([]);
			expect(map.get('m1').status).toBe('awaiting_echo');
		});
	});

	it('editing the same message again after the previous edit fully verified is a fresh revision', () => {
		const map = new Map();
		const tokenA = claimPendingEdit(map, 'm1', 'edit A');
		submitPendingEdit(map, 'm1', tokenA, 'sig_A', 100);
		reconcilePendingEditsWithVerifiedRows(map, [{ id: 'm1', signHash: 'sig_A' }]);
		expect(map.has('m1')).toBe(false);

		const tokenB = claimPendingEdit(map, 'm1', 'edit B');
		expect(tokenB).not.toBe(tokenA);
		expect(submitPendingEdit(map, 'm1', tokenB, 'sig_B', 200)).toBe(true);
		expect(reconcilePendingEditsWithVerifiedRows(map, [{ id: 'm1', signHash: 'sig_B' }])).toEqual(['m1']);
		expect(map.has('m1')).toBe(false);
	});
});

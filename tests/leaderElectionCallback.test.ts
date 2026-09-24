import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	startLeaderElection, stopLeaderElection, isLeader, _setAtomicLeaseStoreForTests,
	type AtomicLeaseStore, type FallbackLease,
} from '@/lib/data/outbox';

const USER = 'u_' + 'a'.repeat(128);

const makeLeaseStore = (): AtomicLeaseStore => {
	const map = new Map<string, FallbackLease>();
	return {
		async claim(userHash, candidate, now) {
			const current = map.get(userHash);
			const winner = current && current.instanceId !== candidate.instanceId && current.expiresAt > now ? current : candidate;
			map.set(userHash, winner);
			return winner;
		},
		async release(userHash, ownerId) {
			const current = map.get(userHash);
			if (!current || current.instanceId !== ownerId) return;
			map.delete(userHash);
		},
	};
};

describe('startLeaderElection: becomeLeader fires only after a confirmed atomic claim (no navigator.locks)', () => {
	beforeEach(() => {
		_setAtomicLeaseStoreForTests(makeLeaseStore());
	});

	afterEach(() => {
		stopLeaderElection();
		_setAtomicLeaseStoreForTests(null);
	});

	it('is fail-closed until the claim confirms, then calls becomeLeader and flips isLeader() — never synchronously, never optimistically', async () => {
		let called = false;
		startLeaderElection(USER, () => { called = true; });

		expect(isLeader()).toBe(false);
		expect(called).toBe(false);

		await vi.waitFor(() => {
			expect(isLeader()).toBe(true);
			expect(called).toBe(true);
		});
	});

	it('updates the callback on a second call for the same account, without re-firing the first one spuriously', async () => {
		let firstCalls = 0;
		let secondCalls = 0;
		startLeaderElection(USER, () => { firstCalls++; });
		await vi.waitFor(() => expect(firstCalls).toBe(1));

		startLeaderElection(USER, () => { secondCalls++; });
		await new Promise((r) => setTimeout(r, 20));
		expect(firstCalls).toBe(1);
		expect(secondCalls).toBe(0);
	});

	it('fails closed when no coordination primitive is available at all: becomeLeader never fires, isLeader() stays false', async () => {
		_setAtomicLeaseStoreForTests(null);
		let called = false;
		startLeaderElection(USER, () => { called = true; });

		await new Promise((r) => setTimeout(r, 20));
		expect(isLeader()).toBe(false);
		expect(called).toBe(false);
	});
});

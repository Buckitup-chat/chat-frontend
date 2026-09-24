import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	enqueue, resolveEntry, awaitEntryOutcome, pendingEntries, drainOutbox,
	_setStorageForTests, _setLeaderForTests,
} from '@/lib/data/outbox';
import { createSecureStore, deriveLocalStorageKey } from '@/lib/data/secureStore';

const MY_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);

const message = (text: string) => ([{
	type: 'insert',
	modified: { message_id: `dmsg_${text}`, sender_hash: MY_HASH, content_b64: text },
	syncMetadata: { relation: 'dialog_messages' },
}]);

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

beforeEach(() => {
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
	vi.useRealTimers();
});

describe('a corrupt record scanned and cleaned up is never read as accepted', () => {
	it('waiter stays unsettled through the fail-safe recheck, never resolves as accepted', async () => {
		vi.useFakeTimers();
		const backing = makeStorage();
		_setStorageForTests(backing);
		const id = await enqueue(message('corruptme'), MY_HASH);

		let settled = false;
		let result: unknown;
		const waiter = awaitEntryOutcome(id as string, MY_HASH);
		void waiter.then((r) => { settled = true; result = r; });

		backing.map.set(id as string, 'not json');

		await pendingEntries(MY_HASH);
		expect(backing.map.has(id as string)).toBe(false); // now genuinely "missing"

		await vi.advanceTimersByTimeAsync(20_000);

		expect(settled).toBe(false); // never resolved — no false acceptance
		expect(result).toBeUndefined();
	});
});

describe('a storage read error is never read as accepted', () => {
	it('waiter stays unsettled while reads fail, and settles correctly once storage recovers', async () => {
		const flaky = makeStorage();
		_setStorageForTests(flaky);
		const id = await enqueue(message('flaky'), MY_HASH);
		const realGet = flaky.get.bind(flaky);
		flaky.get = async () => { throw new Error('simulated disk read error'); };

		let settled = false;
		const waiter = awaitEntryOutcome(id as string, MY_HASH);
		void waiter.then(() => { settled = true; });

		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false); // a read error must never be read as acceptance

		flaky.get = realGet;
		await resolveEntry(id);
		await expect(waiter).resolves.toEqual({ kind: 'accepted' });
	});
});

describe('a genuinely foreign (different account) encrypted record is never read as accepted', () => {
	it('an id that only ever belonged to another account never resolves for this one', async () => {
		const raw = makeStorage();
		const keyA = await deriveLocalStorageKey(new Uint8Array(32).fill(1));
		const keyB = await deriveLocalStorageKey(new Uint8Array(32).fill(2));

		_setStorageForTests(createSecureStore(raw, { getKey: async () => keyB }), raw);
		const foreignId = await enqueue(message('theirs'), OTHER_HASH);

		_setStorageForTests(createSecureStore(raw, { getKey: async () => keyA }), raw);

		let settled = false;
		const waiter = awaitEntryOutcome(foreignId as string, MY_HASH);
		void waiter.then(() => { settled = true; });

		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false); // undecryptable-to-us must never read as accepted
	});
});

describe('an accepted outcome never triggers additional transport', () => {
	it('once resolveEntry records acceptance, a later drain never re-dispatches it', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);
		const id = await enqueue(message('once'), MY_HASH);
		await resolveEntry(id);

		const sent: unknown[][] = [];
		const result = await drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });

		expect(sent).toHaveLength(0);
		expect(result.sent).toBe(0);
	});
});

describe('durable terminal acceptance survives a reload boundary', () => {
	it('a fresh awaitEntryOutcome() after a simulated reload sees the marker immediately, no wait needed', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);
		const id = await enqueue(message('reload'), MY_HASH);
		await resolveEntry(id);

		_setStorageForTests({ ...backing });

		const outcome = await awaitEntryOutcome(id as string, MY_HASH);
		expect(outcome).toEqual({ kind: 'accepted' });
	});
});

describe('LIMITATION (L17-10, open): a storage-write failure right after HTTP acceptance', () => {
	it('never falsely reports accepted, but does leave the entry replayable until a write actually lands', async () => {
		const flaky = makeStorage();
		_setStorageForTests(flaky);
		const id = await enqueue(message('storagefail'), MY_HASH);
		const realSet = flaky.set.bind(flaky);
		flaky.set = async (k: string, v: string) => {
			if (k === id) throw new Error('simulated disk write failure');
			return realSet(k, v);
		};

		await resolveEntry(id);

		expect(await pendingEntries(MY_HASH)).toHaveLength(1);
		const outcome = await Promise.race([
			awaitEntryOutcome(id as string, MY_HASH).then(() => 'settled'),
			new Promise((r) => setTimeout(() => r('still-pending'), 20)),
		]);
		expect(outcome).toBe('still-pending');

		flaky.set = realSet;
		const sent: unknown[][] = [];
		const result = await drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });
		expect(result.sent).toBe(1); // replay actually happens — not fixed here
	});
});

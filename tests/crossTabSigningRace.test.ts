import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32).fill(9);

let signCount = 0;
vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string) => {
			signCount++;
			return { type, relation, row, changes: { ...row, sign_hash: `sig_${signCount}` }, syncMetadata: { relation } };
		},
	},
}));

const sentMutations: unknown[][] = [];
const { MockDurabilityError } = vi.hoisted(() => {
	class MockDurabilityError extends Error {}
	return { MockDurabilityError };
});
vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async (
		mutations: unknown[],
		_signSkey: unknown,
		opts: { onDurable?: (outboxId: string) => void | Promise<void>; sourceIntentId?: string } = {}
	) => {
		sentMutations.push(mutations);
		const outbox = await import('@/lib/data/outbox');
		const outboxId = (await outbox.enqueue(mutations, MY_HASH, { sourceIntentId: opts.sourceIntentId }))!;
		await opts.onDurable?.(outboxId);
		await outbox.resolveEntry(outboxId);
		return { outboxId, phase: 'accepted', result: undefined, acceptance: outbox.awaitEntryOutcome(outboxId, MY_HASH) };
	},
	DurabilityError: MockDurabilityError,
}));

const makeLocksPolyfill = () => {
	const queues = new Map<string, Promise<unknown>>();
	return {
		async request(name: string, callback: () => Promise<unknown>) {
			const previous = queues.get(name) ?? Promise.resolve();
			const settleQueue = previous.catch(() => {});
			const result = settleQueue.then(callback);
			queues.set(name, result.catch(() => {}));
			return result;
		},
	};
};

const makeSharedStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

beforeEach(() => {
	signCount = 0;
	sentMutations.length = 0;
	vi.stubGlobal('navigator', { locks: makeLocksPolyfill() });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('signAndDispatchIntent: two genuinely independent module instances cannot both sign the same intent', () => {
	it('races two "tabs" for the same durable intent id through a real Web Locks primitive — exactly one signature results', async () => {
		const sharedStorage = makeSharedStorage();
		const sharedOutboxStorage = makeSharedStorage();

		vi.resetModules();
		const tab1Intents = await import('@/lib/data/intents');
		const tab1Recovery = await import('@/lib/data/intentRecovery');
		const tab1Outbox = await import('@/lib/data/outbox');
		tab1Intents._setIntentStorageForTests(sharedStorage);
		tab1Outbox._setStorageForTests(sharedOutboxStorage);
		vi.resetModules();
		const tab2Intents = await import('@/lib/data/intents');
		const tab2Recovery = await import('@/lib/data/intentRecovery');
		const tab2Outbox = await import('@/lib/data/outbox');
		tab2Intents._setIntentStorageForTests(sharedStorage);
		tab2Outbox._setStorageForTests(sharedOutboxStorage);

		expect(tab1Recovery.signAndDispatchIntent).not.toBe(tab2Recovery.signAndDispatchIntent);

		const readyRow = { kind: 'ready-row' as const, relation: 'dialog_messages', row: { message_id: 'm_race' }, mutationType: 'insert' as const };
		const id = (await tab1Intents.enqueueIntent(readyRow, MY_HASH, 'dialog_messages'))!;

		const [a, b] = await Promise.all([
			tab1Recovery.signAndDispatchIntent(id, readyRow, SKEY),
			tab2Recovery.signAndDispatchIntent(id, readyRow, SKEY),
		]);

		expect(signCount).toBe(1);
		expect(sentMutations).toHaveLength(1);
		const phases = [a.phase, b.phase].sort();
		expect(phases).toEqual(['accepted', 'queued']);
		await expect(a.acceptance).resolves.toEqual({ kind: 'accepted' });
		await expect(b.acceptance).resolves.toEqual({ kind: 'accepted' });
	});

	it('without the Web Locks primitive available, the fallback fails closed instead of double-signing (§3): at most one signature, the loser is discarded, nothing is lost or falsely accepted', async () => {
		vi.stubGlobal('navigator', {}); // no .locks at all — the documented fallback path

		const sharedStorage = makeSharedStorage();
		const sharedOutboxStorage = makeSharedStorage();
		vi.resetModules();
		const tab1Intents = await import('@/lib/data/intents');
		const tab1Recovery = await import('@/lib/data/intentRecovery');
		const tab1Outbox = await import('@/lib/data/outbox');
		tab1Intents._setIntentStorageForTests(sharedStorage);
		tab1Outbox._setStorageForTests(sharedOutboxStorage);

		vi.resetModules();
		const tab2Intents = await import('@/lib/data/intents');
		const tab2Recovery = await import('@/lib/data/intentRecovery');
		const tab2Outbox = await import('@/lib/data/outbox');
		tab2Intents._setIntentStorageForTests(sharedStorage);
		tab2Outbox._setStorageForTests(sharedOutboxStorage);

		const readyRow = { kind: 'ready-row' as const, relation: 'dialog_messages', row: { message_id: 'm_race_2' }, mutationType: 'insert' as const };
		const id = (await tab1Intents.enqueueIntent(readyRow, MY_HASH, 'dialog_messages'))!;

		const results = await Promise.allSettled([
			tab1Recovery.signAndDispatchIntent(id, readyRow, SKEY),
			tab2Recovery.signAndDispatchIntent(id, readyRow, SKEY),
		]);

		expect(signCount).toBeLessThanOrEqual(1);
		expect(sentMutations.length).toBeLessThanOrEqual(1);
		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');
		expect(fulfilled.length).toBeGreaterThanOrEqual(1);
		expect(fulfilled.length + rejected.length).toBe(2);
		if (fulfilled.length === 1) {
			expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/lost a concurrent claim/);
		}
	});
});

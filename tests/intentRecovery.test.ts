import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startLeaderElection, stopLeaderElection } from '@/lib/data/outbox';

let sendImpl: (mutations: unknown[]) => Promise<unknown>;
const sentMutations: unknown[][] = [];

const { MockDurabilityError } = vi.hoisted(() => {
	class MockDurabilityError extends Error {}
	return { MockDurabilityError };
});

vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string) => ({
			type, relation, row, syncMetadata: { relation },
		}),
	},
}));

let outboxIdSeq = 0;
vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async (mutations: unknown[]) => {
		sentMutations.push(mutations);
		const result = await sendImpl(mutations);
		return { outboxId: `test-outbox-${++outboxIdSeq}`, phase: 'accepted', result, acceptance: Promise.resolve({ kind: 'accepted' }) };
	},
	DurabilityError: MockDurabilityError,
}));

const { signAndDispatchIntent, recoverIntents } = await import('@/lib/data/intentRecovery');
const { enqueueIntent, getIntent, intentsOf, _setIntentStorageForTests, _clearIntentsForTests } = await import('@/lib/data/intents');

const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);
const SKEY = new Uint8Array(32);

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

beforeEach(async () => {
	_setIntentStorageForTests(makeStorage());
	await _clearIntentsForTests();
	sentMutations.length = 0;
	sendImpl = async () => ({ txids: [1] });
	stopLeaderElection();
	startLeaderElection(A, () => {});
});

describe('signAndDispatchIntent', () => {
	it('replays the exact row captured at intent creation — not re-derived from anything newer', async () => {
		const capturedRow = { message_id: 'dmsg_1', dialog_hash: 'd1', sender_hash: A, refs_map_b64: 'captured-scope' };
		const id = await enqueueIntent({ relation: 'dialog_messages', row: capturedRow, mutationType: 'insert' }, A, 'dialog_messages');

		await signAndDispatchIntent(id!, { relation: 'dialog_messages', row: capturedRow, mutationType: 'insert' }, SKEY);

		expect(sentMutations).toHaveLength(1);
		expect((sentMutations[0][0] as { row: unknown }).row).toEqual(capturedRow);
	});

	it('leaves the intent claimed (not resolved) when the mock never proves durability — never fabricates a resolved marker without proof', async () => {
		sendImpl = async () => { throw new Error('ingest network error'); };
		const id = await enqueueIntent({ relation: 'dialog_messages', row: { a: 1 }, mutationType: 'insert' }, A, 'dialog_messages');

		await expect(signAndDispatchIntent(id!, { relation: 'dialog_messages', row: { a: 1 } }, SKEY))
			.rejects.toThrow(/network error/i);

		const after = await getIntent(id!);
		expect(after).not.toBeNull();
		expect((after!.intent as Record<string, unknown>).resolved).toBeFalsy();
		expect((after!.intent as Record<string, unknown>).signedMutation).toBeTruthy();
	});

	it('leaves the intent behind on a DurabilityError — nothing durable happened yet', async () => {
		sendImpl = async () => { throw new MockDurabilityError('could not store'); };
		const id = await enqueueIntent({ relation: 'dialog_messages', row: { a: 1 } }, A, 'dialog_messages');

		await expect(signAndDispatchIntent(id!, { relation: 'dialog_messages', row: { a: 1 } }, SKEY)).rejects.toThrow();

		expect(await getIntent(id!)).not.toBeNull();
	});
});

describe('recoverIntents (§3.6)', () => {
	it('resumes every durable intent for the account, oldest first, and resolves each on success', async () => {
		await enqueueIntent({ relation: 'dialog_messages', row: { message_id: 'm1' } }, A, 'dialog_messages');
		await enqueueIntent({ relation: 'dialog_message_reactions', row: { reaction_hash: 'r1' } }, A, 'dialog_message_reactions');

		await recoverIntents(A, SKEY);

		expect(sentMutations).toHaveLength(2);
		expect((await intentsOf(A)).entries).toEqual([]);
	});

	it("one intent's failure does not stop the rest from recovering", async () => {
		await enqueueIntent({ relation: 'dialog_messages', row: { message_id: 'fails' } }, A, 'dialog_messages');
		await enqueueIntent({ relation: 'dialog_messages', row: { message_id: 'succeeds' } }, A, 'dialog_messages');

		let call = 0;
		sendImpl = async () => {
			call++;
			if (call === 1) throw new Error('ingest network error');
			return { txids: [1] };
		};

		await recoverIntents(A, SKEY);

		expect(sentMutations).toHaveLength(2);
	});

	it('never touches another account\'s intents', async () => {
		await enqueueIntent({ relation: 'dialog_messages', row: { message_id: 'mine' } }, A, 'dialog_messages');
		await enqueueIntent({ relation: 'dialog_messages', row: { message_id: 'theirs' } }, B, 'dialog_messages');

		await recoverIntents(A, SKEY);

		expect(sentMutations).toHaveLength(1);
		expect((await intentsOf(B)).entries).toHaveLength(1);
	});

	it('recovering an empty account is a safe no-op', async () => {
		await recoverIntents(A, SKEY);
		expect(sentMutations).toHaveLength(0);
	});
});

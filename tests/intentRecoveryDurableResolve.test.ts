import { describe, it, expect, beforeEach } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const SKEY = new Uint8Array(32);

let releaseNetwork: (() => void) | null = null;
const sent: unknown[][] = [];

import { vi } from 'vitest';
vi.mock('@/api/client', () => ({
	api: {
		createGenericMutation: (relation: string, row: Record<string, unknown>, _skey: unknown, type: string) => ({
			type, modified: row, syncMetadata: { relation },
		}),
		ingestWithAuthEach: async (mutations: unknown[]) => {
			sent.push(mutations);
			await new Promise<void>((resolve) => { releaseNetwork = resolve; });
			return {
				status: 200,
				json: async () => ({ results: mutations.map((_, index) => ({ index, status: 'ok', txid: 1 })) }),
			} as unknown as Response;
		},
	},
}));

const { signAndDispatchIntent } = await import('@/lib/data/intentRecovery');
const { enqueueIntent, getIntent, _setIntentStorageForTests, _clearIntentsForTests } = await import('@/lib/data/intents');
const { _setStorageForTests, stopDrainLoop, _setLeaderForTests } = await import('@/lib/data/outbox');
const { _setAcceptedSnapshotStorageForTests } = await import('@/lib/data/acceptedSnapshot');

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

let intentStorage: ReturnType<typeof makeStorage>;

beforeEach(async () => {
	intentStorage = makeStorage();
	_setIntentStorageForTests(intentStorage);
	await _clearIntentsForTests();
	_setStorageForTests(makeStorage());
	_setLeaderForTests(true);
	_setAcceptedSnapshotStorageForTests(makeStorage());
	sent.length = 0;
	releaseNetwork = null;
});

describe('signAndDispatchIntent: resolves on durable commit, not on network completion (§F-L03)', () => {
	it('the intent is already gone while the HTTP request is still in flight', async () => {
		const row = { message_id: 'dmsg_1', dialog_hash: 'd1', sender_hash: MY_HASH, content_b64: 'x' };
		const id = await enqueueIntent({ relation: 'dialog_messages', row, mutationType: 'insert' }, MY_HASH, 'dialog_messages');

		const dispatched = signAndDispatchIntent(id!, { relation: 'dialog_messages', row, mutationType: 'insert' }, SKEY);

		await vi.waitFor(() => expect(sent).toHaveLength(1));

		expect((await getIntent(id!))?.intent).toMatchObject({ resolved: true, outcome: 'durably-dispatched' });

		releaseNetwork?.();
		await dispatched;
		stopDrainLoop();
	});
});

describe('a resolved marker with no outbox reference is never read as accepted (§4)', () => {
	it('signAndDispatchIntent throws — it never fabricates {kind: "accepted"} for a null/missing linkage', async () => {
		const row = { message_id: 'dmsg_2', dialog_hash: 'd1', sender_hash: MY_HASH, content_b64: 'x' };
		const id = (await enqueueIntent({ relation: 'dialog_messages', row, mutationType: 'insert' }, MY_HASH, 'dialog_messages'))!;
		intentStorage.map.set(id, JSON.stringify({
			id, userHash: MY_HASH, relation: 'dialog_messages', createdAt: Date.now(),
			intent: { resolved: true, outcome: 'durably-dispatched', ref: null, resolvedAt: Date.now() },
		}));

		await expect(signAndDispatchIntent(id, { relation: 'dialog_messages', row, mutationType: 'insert' }, SKEY))
			.rejects.toThrow(/no durable outbox linkage/i);
	});
});

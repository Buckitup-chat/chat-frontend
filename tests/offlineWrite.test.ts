// Does a write survive with no network at all?
//
// The question is not academic: the app is meant to run on a Raspberry Pi with
// no uplink. This exercises the real path — sendMutationsAndAwaitShape with a
// transport that throws the way fetch does when offline — and then the replay
// that happens on reconnect.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const MY_HASH = 'u_' + 'a'.repeat(128);

let online = false;
const sent: unknown[][] = [];

vi.mock('@/api/client', () => ({
	api: {
		// What fetch does with no network: rejects, never reaches a status code.
		ingestWithAuthEach: async (mutations: unknown[]) => {
			if (!online) throw new TypeError('Failed to fetch');
			sent.push(mutations);
			return {
				status: 200,
				json: async () => ({
					results: mutations.map((_, index) => ({ index, status: 'ok', txid: 100 + index })),
				}),
			} as unknown as Response;
		},
	},
}));

// The barrier needs live collections; delivery is what this file is about.
vi.mock('@/lib/data/barrier', () => ({
	awaitShapeVisibility: async () => {},
	collectionForRelation: () => null,
}));

const { sendMutationsAndAwaitShape, drainPendingWrites } = await import('@/lib/data/ingest');
const { pendingEntries, _setStorageForTests } = await import('@/lib/data/outbox');

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) {
			return map.get(k) ?? null;
		},
		async set(k: string, v: string) {
			map.set(k, v);
		},
		async delete(k: string) {
			map.delete(k);
		},
		async keys() {
			return [...map.keys()];
		},
		async clear() {
			map.clear();
		},
	};
};

const message = (text: string) => ({
	type: 'insert',
	modified: { message_id: `dmsg_${text}`, sender_hash: MY_HASH, content_b64: text },
	syncMetadata: { relation: 'dialog_messages' },
});

const SKEY = new Uint8Array(32);
let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
	online = false;
	sent.length = 0;
	storage = makeStorage();
	_setStorageForTests(storage);
});

describe('writing with no network', () => {
	it('reports failure to the caller but keeps the write', async () => {
		await expect(
			sendMutationsAndAwaitShape([message('hello')], SKEY, { retries: 0 })
		).rejects.toThrow(/network error/i);

		// Durability is the point: the signed mutation is on disk before the
		// first send attempt, so a crash right here would not lose it either.
		const pending = await pendingEntries(MY_HASH);
		expect(pending).toHaveLength(1);
		expect(pending[0].relation).toBe('dialog_messages');
	});

	it('delivers the queued write once the network returns', async () => {
		await sendMutationsAndAwaitShape([message('first')], SKEY, { retries: 0 }).catch(() => {});
		await sendMutationsAndAwaitShape([message('second')], SKEY, { retries: 0 }).catch(() => {});
		expect(await pendingEntries(MY_HASH)).toHaveLength(2);

		online = true;
		await drainPendingWrites(MY_HASH, SKEY);

		// Oldest first: a message must not overtake the one typed before it.
		expect(sent).toHaveLength(2);
		expect((sent[0][0] as ReturnType<typeof message>).modified.content_b64).toBe('first');
		expect((sent[1][0] as ReturnType<typeof message>).modified.content_b64).toBe('second');
		expect(await pendingEntries(MY_HASH)).toHaveLength(0);
	});

	it('keeps the queue intact when the network is still down at drain time', async () => {
		await sendMutationsAndAwaitShape([message('x')], SKEY, { retries: 0 }).catch(() => {});

		await drainPendingWrites(MY_HASH, SKEY);

		expect(sent).toHaveLength(0);
		expect(await pendingEntries(MY_HASH)).toHaveLength(1);
	});

	it('does not queue twice when a write succeeds normally', async () => {
		online = true;

		await sendMutationsAndAwaitShape([message('direct')], SKEY, { retries: 0 });

		expect(sent).toHaveLength(1);
		expect(await pendingEntries(MY_HASH)).toHaveLength(0);
	});
});

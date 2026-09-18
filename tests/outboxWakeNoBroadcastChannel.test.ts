import { describe, it, expect, beforeEach } from 'vitest';

const realBroadcastChannel = globalThis.BroadcastChannel;
// @ts-expect-error simulating an environment without BroadcastChannel
delete globalThis.BroadcastChannel;

const { enqueue, onOutboxWake, requeueEntry, recordFailure, quarantinedEntries, _setStorageForTests } =
	await import('@/lib/data/outbox');
const { IngestError } = await import('@/lib/data/ingest');

globalThis.BroadcastChannel = realBroadcastChannel;

const MY_HASH = 'u_' + 'a'.repeat(128);

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const message = (text: string) => ({
	type: 'insert',
	modified: { message_id: `dmsg_${text}`, sender_hash: MY_HASH, content_b64: text },
	syncMetadata: { relation: 'dialog_messages' },
});

beforeEach(() => {
	_setStorageForTests(makeStorage());
});

describe('onOutboxWake without BroadcastChannel (§B.7)', () => {
	it('a fresh enqueue does NOT wake a local subscriber — no BroadcastChannel to fall back on either', async () => {
		const woken: string[] = [];
		const unsubscribe = onOutboxWake((userHash) => woken.push(userHash));
		try {
			await enqueue([message('a')], MY_HASH);
			expect(woken).toEqual([]);
		} finally {
			unsubscribe();
		}
	});

	it('requeueEntry still wakes a local subscriber', async () => {
		const woken: string[] = [];
		const outboxId = await enqueue([message('b')], MY_HASH);
		await recordFailure(outboxId, new IngestError('rejected', { permanent: true }));
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);

		const unsubscribe = onOutboxWake((userHash) => woken.push(userHash));
		try {
			await requeueEntry(outboxId as string);
			expect(woken).toEqual([MY_HASH]);
		} finally {
			unsubscribe();
		}
	});

	it('subscribing does not throw even though there is no channel to attach to', () => {
		const unsubscribe = onOutboxWake(() => {});
		expect(() => unsubscribe()).not.toThrow();
	});
});

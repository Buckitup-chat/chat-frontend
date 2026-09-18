import { describe, it, expect, beforeEach } from 'vitest';

const { enqueue, resolveEntry, discardEntry, findEntryBySourceIntentId, markServerAccepted, markReconciled, _setStorageForTests } =
	await import('@/lib/data/outbox');

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

const message = (id: string) => ({
	type: 'insert',
	modified: { message_id: id, sender_hash: MY_HASH },
	syncMetadata: { relation: 'dialog_messages' },
});

beforeEach(() => {
	_setStorageForTests(makeStorage());
});

describe('findEntryBySourceIntentId (§3)', () => {
	it('finds the durable outbox entry a specific intent id was handed off to', async () => {
		const outboxId = await enqueue([message('m1')], MY_HASH, { sourceIntentId: 'intent-1' });

		const found = await findEntryBySourceIntentId(MY_HASH, 'intent-1');

		expect(found).not.toBeNull();
		expect(found!.outboxId).toBe(outboxId);
	});

	it('returns null when no entry was ever enqueued for that intent id', async () => {
		await enqueue([message('m1')], MY_HASH, { sourceIntentId: 'intent-1' });

		expect(await findEntryBySourceIntentId(MY_HASH, 'intent-999')).toBeNull();
	});

	it('never matches another account\'s entry, even with the same intent id', async () => {
		const OTHER = 'u_' + 'b'.repeat(128);
		await enqueue([message('m1')], OTHER, { sourceIntentId: 'intent-1' });

		expect(await findEntryBySourceIntentId(MY_HASH, 'intent-1')).toBeNull();
	});

	it('still finds the entry after it reaches its terminal accepted marker — the exact crash-recovery case', async () => {
		const outboxId = await enqueue([message('m1')], MY_HASH, { sourceIntentId: 'intent-1' });
		await markServerAccepted(outboxId);
		await markReconciled(outboxId);
		await resolveEntry(outboxId);

		const found = await findEntryBySourceIntentId(MY_HASH, 'intent-1');
		expect(found).not.toBeNull();
		expect(found!.outboxId).toBe(outboxId);
	});

	it('still finds the entry after it is discarded', async () => {
		const outboxId = await enqueue([message('m1')], MY_HASH, { sourceIntentId: 'intent-1' });
		await discardEntry(outboxId!);

		const found = await findEntryBySourceIntentId(MY_HASH, 'intent-1');
		expect(found).not.toBeNull();
		expect(found!.outboxId).toBe(outboxId);
	});
});

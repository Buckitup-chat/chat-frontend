import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	enqueue, pendingEntries, readyEntries, blockedEntries, quarantinedEntries,
	drainOutbox, _setStorageForTests, _setLeaderForTests,
} from '@/lib/data/outbox';

const MY_HASH = 'u_' + 'a'.repeat(128);

const mutation = (tag: string) => ([{
	type: 'insert',
	modified: { message_id: `dmsg_${tag}`, sender_hash: MY_HASH, content_b64: tag },
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

let backing: ReturnType<typeof makeStorage>;

const breakScan = (message = 'storage down') => {
	backing.keys = async () => { throw new Error(message); };
};

beforeEach(() => {
	backing = makeStorage();
	_setStorageForTests(backing);
	_setLeaderForTests(true);
});

afterEach(() => {
	_setLeaderForTests(null);
});

describe('a broken storage.keys() scan fails closed, never "the queue is empty" (§ outbox scan fail-closed)', () => {
	it('1. pendingEntries rejects instead of resolving to an empty list', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		breakScan();

		await expect(pendingEntries(MY_HASH)).rejects.toThrow(/storage down/);

		backing.keys = async () => [...backing.map.keys()];
		const pending = await pendingEntries(MY_HASH);
		expect(pending.map((e) => e.id)).toEqual([aId]);
		expect(pending[0].status ?? 'pending').not.toBe('quarantined');
		expect(pending[0].status ?? 'pending').not.toBe('discarded');
	});

	it('2. readyEntries rejects instead of resolving to an empty (or wrongly non-empty) list', async () => {
		await enqueue(mutation('A'), MY_HASH);
		breakScan();

		await expect(readyEntries(MY_HASH)).rejects.toThrow(/storage down/);
	});

	it('3. quarantinedEntries rejects too — the same shared scan, not silently "nothing quarantined"', async () => {
		await enqueue(mutation('A'), MY_HASH);
		breakScan();

		await expect(quarantinedEntries(MY_HASH)).rejects.toThrow(/storage down/);
	});

	it('4. a dependent B is never treated as ready because its prerequisite A became invisible to a broken scan', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		const bId = await enqueue(mutation('B'), MY_HASH, { dependsOn: [aId] }) as string;
		breakScan();

		await expect(readyEntries(MY_HASH)).rejects.toThrow(/storage down/);
		await expect(blockedEntries(MY_HASH)).rejects.toThrow(/storage down/);

		backing.keys = async () => [...backing.map.keys()];
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('5. drainOutbox never calls transport when the scan is broken, and does not silently report a clean drain', async () => {
		await enqueue(mutation('A'), MY_HASH);
		breakScan();

		const sent: unknown[][] = [];
		const send = async (m: unknown[]) => { sent.push(m); };

		await expect(drainOutbox(MY_HASH, send)).rejects.toThrow(/storage down/);
		expect(sent).toHaveLength(0);

		backing.keys = async () => [...backing.map.keys()];
		const result = await drainOutbox(MY_HASH, send);
		expect(result.sent).toBe(1);
		expect(sent).toHaveLength(1);
	});

	it('6. drainOutbox with a dependency chain never calls transport for either entry while the scan is broken', async () => {
		const aId = await enqueue(mutation('A'), MY_HASH) as string;
		await enqueue(mutation('B'), MY_HASH, { dependsOn: [aId] });
		breakScan();

		const sent: unknown[][] = [];
		const send = async (m: unknown[]) => { sent.push(m); };

		await expect(drainOutbox(MY_HASH, send)).rejects.toThrow(/storage down/);
		expect(sent).toHaveLength(0);

		backing.keys = async () => [...backing.map.keys()];
		const result = await drainOutbox(MY_HASH, send);
		expect(result.sent).toBe(2);
		expect(sent.map((m) => (m[0] as { modified: { message_id: string } }).modified.message_id)).toEqual(['dmsg_A', 'dmsg_B']);
	});
});

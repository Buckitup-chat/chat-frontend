import { describe, it, expect, beforeEach } from 'vitest';
import { dependenciesFor } from '@/lib/data/coordinator';
import {
	enqueue, recordFailure, discardEntry, requeueEntry, resolveEntry,
	readyEntries, blockedEntries, quarantinedEntries, pendingEntries, drainOutbox,
	_setStorageForTests,
} from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';

const MY_HASH = 'u_' + 'a'.repeat(128);

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

const editMessage = (messageId: string) => ([{
	type: 'update',
	modified: {
		message_id: messageId, sender_hash: MY_HASH, dialog_hash: 'dh1',
		content_b64: 'x', parent_sign_hash: null, owner_timestamp: 1,
	},
	syncMetadata: { relation: 'dialog_messages' },
}]);

const storageSlot = (uuid: string) => ([{
	type: 'update',
	modified: { user_hash: MY_HASH, uuid, content_b64: 'x' },
	syncMetadata: { relation: 'user_storage' },
}]);

beforeEach(() => {
	_setStorageForTests(makeStorage());
});

describe('§4.9 audit fix: chained dependency is per-entity, not per-dialog/per-account', () => {
	it('editing message Y does not wait on an unrelated in-flight edit of message X', async () => {
		await enqueue(editMessage('msg_X'), MY_HASH);
		const deps = await dependenciesFor(editMessage('msg_Y'), MY_HASH);
		expect(deps).toEqual([]);
	});

	it('saving one user_storage slot does not wait on an unrelated slot of the same account', async () => {
		await enqueue(storageSlot('slot-profile'), MY_HASH);
		const deps = await dependenciesFor(storageSlot('slot-contacts'), MY_HASH);
		expect(deps).toEqual([]);
	});

	it('still serializes two edits of the exact same message', async () => {
		const firstId = await enqueue(editMessage('msg_X'), MY_HASH);
		const deps = await dependenciesFor(editMessage('msg_X'), MY_HASH);
		expect(deps).toEqual([firstId]);
	});
});

describe('§4.9: a permanently failed predecessor blocks its dependent, visibly', () => {
	it('B stays blocked, not deleted and not dispatched, while A is quarantined', async () => {
		const aId = await enqueue(editMessage('msg_X'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		expect(await quarantinedEntries(MY_HASH)).toHaveLength(1);

		const bDeps = await dependenciesFor(editMessage('msg_X'), MY_HASH);
		const bId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: bDeps });

		const ready = await readyEntries(MY_HASH);
		expect(ready.map((e) => e.id)).not.toContain(bId);

		const blocked = await blockedEntries(MY_HASH);
		expect(blocked.map((e) => e.id)).toContain(bId);
	});
});

describe('§L17-09: Discard is not acceptance — a discarded prerequisite still blocks its dependent', () => {
	const setupAB = async () => {
		const aId = await enqueue(editMessage('msg_X'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		const bDeps = await dependenciesFor(editMessage('msg_X'), MY_HASH);
		const bId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: bDeps });
		return { aId: aId as string, bId: bId as string };
	};

	it('1. an accepted prerequisite (resolveEntry) makes the dependent ready — recorded as a durable accepted marker, not deleted', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);
		const { aId, bId } = await setupAB();

		await resolveEntry(aId);

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
		expect(backing.map.has(aId)).toBe(true);
		expect(JSON.parse(backing.map.get(aId)!).status).toBe('accepted');
		expect(JSON.parse(backing.map.get(aId)!).mutations).toEqual([]); // no signed payload left to (re)send
	});

	it('2. a quarantined prerequisite blocks the dependent', async () => {
		const { bId } = await setupAB();

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('3. explicit Discard A removes A from quarantinedEntries but B remains blocked', async () => {
		const { aId, bId } = await setupAB();

		await discardEntry(aId);

		expect((await quarantinedEntries(MY_HASH)).map((e) => e.id)).not.toContain(aId);
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('4. B stays blocked through a discarded A after a reload (fresh storage handle over the same data)', async () => {
		const backing = makeStorage();
		_setStorageForTests({ ...backing });

		const { aId, bId } = await setupAB();
		await discardEntry(aId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);

		_setStorageForTests({ ...backing });

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('5. a drain after Discard A does not send B', async () => {
		const { aId, bId } = await setupAB();
		await discardEntry(aId);

		const sent: unknown[][] = [];
		const result = await drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });

		expect(sent).toHaveLength(0);
		expect(result.sent).toBe(0);
		expect((await pendingEntries(MY_HASH)).map((e) => e.id)).toContain(bId); // still there, not lost
	});

	it('6. an unrelated independent C is dispatched while B stays blocked', async () => {
		const { bId } = await setupAB();
		const cId = await enqueue(editMessage('msg_UNRELATED'), MY_HASH);

		await drainOutbox(MY_HASH, async () => {});

		const remaining = (await pendingEntries(MY_HASH)).map((e) => e.id);
		expect(remaining).toContain(bId);
		expect(remaining).not.toContain(cId); // C was independent and got sent
	});

	it('7. chain A -> B -> C: discarding A leaves both B and C blocked (C\'s own prerequisite B never resolves)', async () => {
		const { aId, bId } = await setupAB();
		const cDeps = await dependenciesFor(editMessage('msg_X'), MY_HASH);
		expect(cDeps).toContain(bId); // C picks up B, still pending on the same chained scope
		const cId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: cDeps });

		await discardEntry(aId);

		const ready = (await readyEntries(MY_HASH)).map((e) => e.id);
		expect(ready).not.toContain(bId);
		expect(ready).not.toContain(cId);
		const blocked = (await blockedEntries(MY_HASH)).map((e) => e.id);
		expect(blocked).toContain(bId);
		expect(blocked).toContain(cId);
	});

	it('8. discarding B after A was already discarded does not auto-dispatch C', async () => {
		const { aId, bId } = await setupAB();
		const cDeps = await dependenciesFor(editMessage('msg_X'), MY_HASH);
		const cId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: cDeps });
		await discardEntry(aId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(cId);

		await discardEntry(bId);

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(cId);
	});

	it('9. a fresh write on the same scope after Discard A does not inherit a dependency on the terminal A', async () => {
		const { aId } = await setupAB();
		await discardEntry(aId);

		const deps = await dependenciesFor(editMessage('msg_X'), MY_HASH);

		expect(deps).not.toContain(aId);
	});

	it('10. a discarded entry is not pending, never ready, holds no retry timer, and is never sent', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);
		const { aId } = await setupAB();

		await discardEntry(aId);

		expect((await pendingEntries(MY_HASH)).map((e) => e.id)).not.toContain(aId);
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(aId);

		const marker = JSON.parse(backing.map.get(aId)!);
		expect(marker.status).toBe('discarded');
		expect(marker.nextAttemptAt).toBeUndefined();
		expect(marker.mutations).toEqual([]); // no signed payload left to (re)send

		const sent: unknown[][] = [];
		await drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });
		expect(sent).toHaveLength(0);
	});

	it('11. Retry (requeue) on quarantined A before Discard returns it to pending; B stays blocked until A actually resolves', async () => {
		const { aId, bId } = await setupAB();

		await requeueEntry(aId);
		expect((await pendingEntries(MY_HASH)).map((e) => e.id)).toContain(aId);
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId); // pending again, not yet resolved

		await resolveEntry(aId);

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});

	it('12. across a fresh storage handle (another tab / reload), the discarded outcome is never indistinguishable from physical absence', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);
		const { aId, bId } = await setupAB();

		await discardEntry(aId);

		expect(backing.map.has(aId)).toBe(true);
		expect(JSON.parse(backing.map.get(aId)!).status).toBe('discarded');

		_setStorageForTests({ ...backing });
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
	});

	it('13. discarding a leaf entry with no dependents leaves zero active work, but the marker itself is retained', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);
		const aId = await enqueue(editMessage('msg_LEAF'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));

		await discardEntry(aId as string);

		expect(await quarantinedEntries(MY_HASH)).toHaveLength(0);
		expect(await pendingEntries(MY_HASH)).toHaveLength(0);
		expect(backing.map.has(aId as string)).toBe(true); // retained metadata, not active work
		expect(JSON.parse(backing.map.get(aId as string)!).status).toBe('discarded');
	});
	it('14. discarding a chain of dependents does not delete any of their markers — retention has no automatic end', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);
		const { aId, bId } = await setupAB();

		await discardEntry(aId);
		expect(backing.map.has(aId)).toBe(true);

		await discardEntry(bId);
		expect(backing.map.has(aId)).toBe(true); // still retained — B being discarded too changes nothing
		expect(backing.map.has(bId)).toBe(true);
		expect(JSON.parse(backing.map.get(aId)!).status).toBe('discarded');
		expect(JSON.parse(backing.map.get(bId)!).status).toBe('discarded');
	});

	it('Retry (requeue) on an already-discarded A stays a no-op — a terminal marker is never revived', async () => {
		const { aId, bId } = await setupAB();
		await discardEntry(aId);

		await requeueEntry(aId);

		expect((await pendingEntries(MY_HASH)).map((e) => e.id)).not.toContain(aId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId); // still blocked — A never came back
	});

	it('a dependency captured before Discard, but enqueued after it, still blocks — the late-enqueue race', async () => {
		const backing = makeStorage();
		_setStorageForTests(backing);

		const aId = await enqueue(editMessage('msg_RACE'), MY_HASH);
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));

		const bDeps = await dependenciesFor(editMessage('msg_RACE'), MY_HASH);
		expect(bDeps).toEqual([aId]);

		await discardEntry(aId as string);

		expect(backing.map.has(aId as string)).toBe(true);
		expect(JSON.parse(backing.map.get(aId as string)!).status).toBe('discarded');

		const bId = await enqueue(editMessage('msg_RACE'), MY_HASH, { dependsOn: bDeps });

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);

		const sent: unknown[][] = [];
		await drainOutbox(MY_HASH, async (m) => { sent.push(m as unknown[]); });
		expect(sent).toHaveLength(0);

		_setStorageForTests({ ...backing });
		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);
		expect((await blockedEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});
});

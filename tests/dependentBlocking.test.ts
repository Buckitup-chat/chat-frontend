import { describe, it, expect, beforeEach } from 'vitest';
import { dependenciesFor } from '@/lib/data/coordinator';
import { enqueue, recordFailure, discardEntry, readyEntries, blockedEntries, quarantinedEntries, _setStorageForTests } from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';

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

	it('discarding the quarantined predecessor unblocks the dependent', async () => {
		const aId = await enqueue(editMessage('msg_X'), MY_HASH);
		expect(aId).not.toBeNull();
		await recordFailure(aId, new IngestError('rejected', { permanent: true }));
		const bDeps = await dependenciesFor(editMessage('msg_X'), MY_HASH);
		const bId = await enqueue(editMessage('msg_X'), MY_HASH, { dependsOn: bDeps });

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).not.toContain(bId);

		await discardEntry(aId as string);

		expect((await readyEntries(MY_HASH)).map((e) => e.id)).toContain(bId);
	});
});

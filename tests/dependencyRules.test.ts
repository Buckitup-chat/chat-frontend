import { describe, it, expect, beforeEach } from 'vitest';
import { dependenciesFor } from '@/lib/data/coordinator';
import { enqueue, recordFailure, readyEntries, _setStorageForTests } from '@/lib/data/outbox';
import { IngestError } from '@/lib/data/ingest';

const MY_HASH = 'u_' + 'a'.repeat(128);
const OTHER_HASH = 'u_' + 'b'.repeat(128);

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

const userStorageUpdate = (userHash: string) => ([{
	type: 'update',
	modified: { user_hash: userHash, uuid: 'slot-1', content_b64: 'x' },
	syncMetadata: { relation: 'user_storage' },
}]);

const dialogMessage = (dialogHash: string) => ([{
	type: 'insert',
	modified: { message_id: 'dmsg_1', sender_hash: MY_HASH, dialog_hash: dialogHash, content_b64: 'hi' },
	syncMetadata: { relation: 'dialog_messages' },
}]);

const dialogKey = (dialogHash: string) => ([{
	type: 'insert',
	modified: { dialog_hash: dialogHash, sender_hash: MY_HASH, key_b64: 'k' },
	syncMetadata: { relation: 'dialog_keys' },
}]);

const userCard = (userHash: string) => ([{
	type: 'insert',
	modified: { user_hash: userHash, card_b64: 'c' },
	syncMetadata: { relation: 'user_cards' },
}]);

beforeEach(() => {
	_setStorageForTests(makeStorage());
});

describe('dependenciesFor: §7.1 chained same-scope serialization', () => {
	it('a chained write depends on an older, unresolved write of the exact same scope', async () => {
		const firstId = await enqueue(userStorageUpdate(MY_HASH), MY_HASH);
		const deps = await dependenciesFor(userStorageUpdate(MY_HASH), MY_HASH);
		expect(deps).toEqual([firstId]);
	});

	it('does not depend on a write of a DIFFERENT scope (different account slot)', async () => {
		await enqueue(userStorageUpdate(OTHER_HASH), OTHER_HASH);
		const deps = await dependenciesFor(userStorageUpdate(MY_HASH), MY_HASH);
		expect(deps).toEqual([]);
	});

	it('a quarantined same-scope predecessor still blocks — it left the replay path, not existence', async () => {
		const firstId = await enqueue(userStorageUpdate(MY_HASH), MY_HASH);
		await recordFailure(firstId, new IngestError('rejected', { permanent: true }));
		const deps = await dependenciesFor(userStorageUpdate(MY_HASH), MY_HASH);
		expect(deps).toEqual([firstId]);
	});

	it('independent writes of the same conceptual "row family" do not chain on each other', async () => {
		await enqueue(dialogMessage('dh1'), MY_HASH);
		const deps = await dependenciesFor(dialogMessage('dh1'), MY_HASH);
		expect(deps).toEqual([]);
	});
});

describe('dependenciesFor: §7.3 server-enforced existence prerequisites', () => {
	it('a dialog row depends on that dialog\'s still-unresolved dialog_keys entry', async () => {
		const keyId = await enqueue(dialogKey('dh1'), MY_HASH);
		const deps = await dependenciesFor(dialogMessage('dh1'), MY_HASH);
		expect(deps).toEqual([keyId]);
	});

	it('does not depend on a different dialog\'s key', async () => {
		await enqueue(dialogKey('dh-other'), MY_HASH);
		const deps = await dependenciesFor(dialogMessage('dh1'), MY_HASH);
		expect(deps).toEqual([]);
	});

	it('any signed row depends on its own account\'s still-unresolved user_cards entry', async () => {
		const cardId = await enqueue(userCard(MY_HASH), MY_HASH);
		const deps = await dependenciesFor(dialogMessage('dh1'), MY_HASH);
		expect(deps).toEqual([cardId]);
	});

	it('a user_cards mutation does not depend on itself-relation prerequisites', async () => {
		const deps = await dependenciesFor(userCard(MY_HASH), MY_HASH);
		expect(deps).toEqual([]);
	});
});

describe('end-to-end through the real outbox: independent dispatch, chained block', () => {
	it('an independent ready message and a blocked dependent user_storage edit coexist correctly', async () => {
		const stuckId = await enqueue(userStorageUpdate(MY_HASH), MY_HASH);
		await recordFailure(stuckId, new Error('network down'));

		const messageDeps = await dependenciesFor(dialogMessage('dh1'), MY_HASH);
		await enqueue(dialogMessage('dh1'), MY_HASH, { dependsOn: messageDeps });

		const secondStorageDeps = await dependenciesFor(userStorageUpdate(MY_HASH), MY_HASH);
		await enqueue(userStorageUpdate(MY_HASH), MY_HASH, { dependsOn: secondStorageDeps });

		const ready = await readyEntries(MY_HASH);
		const readyRelations = ready.map((e) => e.relation);
		expect(readyRelations).toContain('dialog_messages');
		expect(ready.filter((e) => e.relation === 'user_storage')).toHaveLength(0);
	});
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordAccepted, getAccepted, getAllAcceptedForRelation, freshestOf, _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { startLeaderElection, stopLeaderElection, _setStorageForTests } from '@/lib/data/outbox';

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

describe('acceptedSnapshot: record/get', () => {
	beforeEach(() => {
		_setAcceptedSnapshotStorageForTests(makeStorage());
	});

	it('round-trips a recorded row', async () => {
		await recordAccepted('dialog_messages', 'dmsg_1', { message_id: 'dmsg_1', sign_hash: 'dms_a', owner_timestamp: 100 });
		expect(await getAccepted('dialog_messages', 'dmsg_1')).toEqual({
			message_id: 'dmsg_1', sign_hash: 'dms_a', owner_timestamp: 100,
		});
	});

	it('keeps different relations and entities apart', async () => {
		await recordAccepted('dialog_messages', 'same_id', { owner_timestamp: 1, who: 'message' });
		await recordAccepted('dialog_message_reactions', 'same_id', { owner_timestamp: 1, who: 'reaction' });
		expect(await getAccepted('dialog_messages', 'same_id')).toMatchObject({ who: 'message' });
		expect(await getAccepted('dialog_message_reactions', 'same_id')).toMatchObject({ who: 'reaction' });
	});

	it('returns null for an entity nothing has recorded yet', async () => {
		expect(await getAccepted('dialog_messages', 'never_seen')).toBeNull();
	});

	it('survives a reload — a fresh storage handle over the same bytes still reads it', async () => {
		const backing = makeStorage();
		_setAcceptedSnapshotStorageForTests(backing);
		await recordAccepted('dialog_messages', 'dmsg_1', { message_id: 'dmsg_1', sign_hash: 'dms_a', owner_timestamp: 100 });

		const reloaded = { ...makeStorage(), map: backing.map };
		reloaded.get = async (k: string) => backing.map.get(k) ?? null;
		_setAcceptedSnapshotStorageForTests(reloaded);

		expect(await getAccepted('dialog_messages', 'dmsg_1')).toEqual({
			message_id: 'dmsg_1', sign_hash: 'dms_a', owner_timestamp: 100,
		});
	});

	it('overwrites the previous snapshot for the same entity, not appends', async () => {
		await recordAccepted('dialog_messages', 'dmsg_1', { owner_timestamp: 1, revision: 'first' });
		await recordAccepted('dialog_messages', 'dmsg_1', { owner_timestamp: 2, revision: 'second' });
		expect(await getAccepted('dialog_messages', 'dmsg_1')).toMatchObject({ revision: 'second' });
	});

	it('does not let a stale (older owner_timestamp) recording overwrite a fresher one already stored', async () => {
		await recordAccepted('dialog_messages', 'dmsg_1', { owner_timestamp: 2000, revision: 'newer, recorded first' });
		await recordAccepted('dialog_messages', 'dmsg_1', { owner_timestamp: 1000, revision: 'older, arrives late' });
		expect(await getAccepted('dialog_messages', 'dmsg_1')).toMatchObject({ revision: 'newer, recorded first' });
	});

	it('propagates a storage write failure instead of silently losing the accepted base', async () => {
		const storage = makeStorage();
		storage.set = async () => { throw new Error('quota exceeded'); };
		_setAcceptedSnapshotStorageForTests(storage);

		await expect(
			recordAccepted('dialog_messages', 'dmsg_1', { message_id: 'dmsg_1', sign_hash: 'dms_a', owner_timestamp: 100 })
		).rejects.toThrow('quota exceeded');
	});
});

describe('acceptedSnapshot: a genuine read/storage failure is never mistaken for "snapshot absent"', () => {
	beforeEach(() => {
		_setAcceptedSnapshotStorageForTests(makeStorage());
	});

	it('getAccepted propagates a raw storage read failure instead of returning null', async () => {
		const storage = makeStorage();
		storage.get = async () => { throw new Error('IndexedDB blocked'); };
		_setAcceptedSnapshotStorageForTests(storage);

		await expect(getAccepted('dialog_messages', 'dmsg_1')).rejects.toThrow('IndexedDB blocked');
	});

	it('getAccepted propagates corrupted (non-JSON) stored content instead of returning null', async () => {
		const storage = makeStorage();
		storage.map.set('dialog_messages:dmsg_1', 'not valid json{{{');
		_setAcceptedSnapshotStorageForTests(storage);

		await expect(getAccepted('dialog_messages', 'dmsg_1')).rejects.toThrow();
	});

	it('recordAccepted does not silently treat an unreadable existing record as absent and overwrite it', async () => {
		const storage = makeStorage();
		storage.get = async () => { throw new Error('IndexedDB blocked'); };
		_setAcceptedSnapshotStorageForTests(storage);

		await expect(
			recordAccepted('dialog_messages', 'dmsg_1', { owner_timestamp: 1, revision: 'new' })
		).rejects.toThrow('IndexedDB blocked');
	});

	it('getAllAcceptedForRelation propagates a genuine per-entry failure instead of silently dropping that row', async () => {
		const storage = makeStorage();
		storage.map.set('dialog_messages:dmsg_1', 'not valid json{{{');
		_setAcceptedSnapshotStorageForTests(storage);

		await expect(getAllAcceptedForRelation('dialog_messages')).rejects.toThrow();
	});
});

describe('acceptedSnapshot: recorded by the coordinator on every accepted send (§4.5)', () => {
	beforeEach(() => {
		_setAcceptedSnapshotStorageForTests(makeStorage());
		_setStorageForTests(makeStorage());
		startLeaderElection(MY_HASH, () => {});
	});

	afterEach(() => {
		stopLeaderElection();
	});

	it('records a dialog_messages row as soon as it is accepted', async () => {
		const { dispatchMutations } = await import('@/lib/data/coordinator');
		const mutations = [{
			type: 'insert',
			modified: { message_id: 'dmsg_x', dialog_hash: 'dh1', sender_hash: MY_HASH, sign_hash: 'dms_x', owner_timestamp: 500 },
			syncMetadata: { relation: 'dialog_messages' },
		}];
		await dispatchMutations(mutations, async () => ({ txids: [], results: [] }));

		expect(await getAccepted('dialog_messages', 'dmsg_x')).toMatchObject({ sign_hash: 'dms_x', owner_timestamp: 500 });
	});

	it('records an accepted receipt under its receipt_hash, exactly as signed', async () => {
		const { dispatchMutations } = await import('@/lib/data/coordinator');
		const row = { receipt_hash: 'rcpt_1', peer_hash: MY_HASH, type: 'delivered', owner_timestamp: 1, sign_b64: 'c2ln' };
		const mutations = [{ type: 'insert', modified: row, syncMetadata: { relation: 'dialog_message_receipts' } }];
		await dispatchMutations(mutations, async () => ({ txids: [], results: [] }));
		expect(await getAccepted('dialog_message_receipts', 'rcpt_1', MY_HASH)).toEqual(row);
	});

	it('never records a relation with no entity-identity field', async () => {
		const { dispatchMutations } = await import('@/lib/data/coordinator');
		const mutations = [{
			type: 'insert',
			modified: { some_id: 'x_1', peer_hash: MY_HASH, owner_timestamp: 1 },
			syncMetadata: { relation: 'unidentified_relation' },
		}];
		await dispatchMutations(mutations, async () => ({ txids: [], results: [] }));
		expect(await getAccepted('unidentified_relation', 'x_1')).toBeNull();
	});
});

describe('acceptedSnapshot: freshestOf', () => {
	it('picks the row with the greater owner_timestamp', () => {
		const older = { owner_timestamp: 100 };
		const newer = { owner_timestamp: 200 };
		expect(freshestOf(older, newer)).toBe(newer);
		expect(freshestOf(newer, older)).toBe(newer);
	});

	it('falls back to whichever side is present when the other is missing', () => {
		const row = { owner_timestamp: 100 };
		expect(freshestOf(row, null)).toBe(row);
		expect(freshestOf(undefined, row)).toBe(row);
		expect(freshestOf(null, null)).toBeNull();
	});
});

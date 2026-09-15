import { describe, it, expect, beforeEach } from 'vitest';
import { recordAccepted, getAccepted, freshestOf, _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';

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
});

describe('acceptedSnapshot: recorded by the coordinator on every accepted send (§4.5)', () => {
	beforeEach(() => {
		_setAcceptedSnapshotStorageForTests(makeStorage());
	});

	it('records a dialog_messages row as soon as it is accepted', async () => {
		const { dispatchMutations } = await import('@/lib/data/coordinator');
		const mutations = [{
			type: 'insert',
			modified: { message_id: 'dmsg_x', dialog_hash: 'dh1', sign_hash: 'dms_x', owner_timestamp: 500 },
			syncMetadata: { relation: 'dialog_messages' },
		}];
		await dispatchMutations(mutations, async () => ({ txids: [], results: [] }));

		expect(await getAccepted('dialog_messages', 'dmsg_x')).toMatchObject({ sign_hash: 'dms_x', owner_timestamp: 500 });
	});

	it('never records a relation with no entity-identity field (e.g. a receipt)', async () => {
		const { dispatchMutations } = await import('@/lib/data/coordinator');
		const mutations = [{
			type: 'insert',
			modified: { receipt_hash: 'rcpt_1', owner_timestamp: 1 },
			syncMetadata: { relation: 'dialog_message_receipts' },
		}];
		await dispatchMutations(mutations, async () => ({ txids: [], results: [] }));
		expect(await getAccepted('dialog_message_receipts', 'rcpt_1')).toBeNull();
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

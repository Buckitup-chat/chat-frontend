import { describe, it, expect, vi, beforeEach } from 'vitest';

// HTTP commit ≠ Electric shape visibility. These tests pin the barrier:
// a write must not be considered done — and must not release the next write
// that reads the same collection as its base — until the committed txid has
// been delivered to that collection (review 2026-08-11, finding 1).

const awaitTxId = vi.fn(async () => true);
const storageCollection = { utils: { awaitTxId } };
const messagesCollection = { utils: { awaitTxId } };

vi.mock('../src/lib/data/collections', () => ({
	getDialogCollections: () => ({
		keys: { utils: { awaitTxId } },
		messages: messagesCollection,
		versions: { utils: { awaitTxId } },
		reactions: { utils: { awaitTxId } },
		receipts: { utils: { awaitTxId } },
	}),
	getUserCardsCollection: () => ({ utils: { awaitTxId } }),
	getUserStorageCollection: () => storageCollection,
}));

const { awaitShapeVisibility, collectionForRelation } = await import('../src/lib/data/barrier');

const DIALOG = 'di_' + 'ab'.repeat(64);

beforeEach(() => {
	awaitTxId.mockClear();
	awaitTxId.mockImplementation(async () => true);
});

describe('collectionForRelation', () => {
	it('routes each relation to the collection later writes read as their base', () => {
		expect(collectionForRelation('user_storage', {})).toBe(storageCollection);
		expect(collectionForRelation('dialog_messages', { dialog_hash: DIALOG })).toBe(messagesCollection);
	});

	it('returns null for dialog rows without a dialog_hash to resolve the shape', () => {
		expect(collectionForRelation('dialog_messages', {})).toBeNull();
		expect(collectionForRelation('unknown_table', {})).toBeNull();
	});
});

describe('awaitShapeVisibility', () => {
	it('waits for every returned txid', async () => {
		await awaitShapeVisibility(storageCollection, [7, 8]);
		expect(awaitTxId).toHaveBeenCalledTimes(2);
		expect(awaitTxId.mock.calls.map((c) => c[0])).toEqual([7, 8]);
	});

	it('does not resolve before the shape reports the txid', async () => {
		let releaseShape: (() => void) | null = null;
		awaitTxId.mockImplementationOnce(async () => {
			await new Promise<void>((r) => { releaseShape = r; });
			return true;
		});

		let resolved = false;
		const p = awaitShapeVisibility(storageCollection, [42]).then(() => { resolved = true; });

		await vi.waitFor(() => expect(releaseShape).toBeTruthy());
		expect(resolved).toBe(false); // committed, but the shape has not caught up

		releaseShape!();
		await p;
		expect(resolved).toBe(true);
	});

	// Replication lag must not fail a write the server already accepted.
	it('proceeds when the barrier times out', async () => {
		awaitTxId.mockImplementationOnce(async () => { throw new Error('timeout'); });
		await expect(awaitShapeVisibility(storageCollection, [1])).resolves.toBeUndefined();
	});

	it('is a no-op without a collection or txids', async () => {
		await expect(awaitShapeVisibility(null, [1])).resolves.toBeUndefined();
		await expect(awaitShapeVisibility(storageCollection, [])).resolves.toBeUndefined();
		expect(awaitTxId).not.toHaveBeenCalled();
	});
});

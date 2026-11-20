// The record that resumes an upload after a reload (pq_files §4.1): sealed for
// its account, read back only while worth resuming.
import { beforeEach, describe, expect, it } from 'vitest';
import type { StringStore } from '@/lib/data/secureStore';
import {
	PENDING_UPLOAD_TTL_MS, _setPendingUploadsStoreForTests, forgetAccountPendingUploads, forgetPendingBatch, pendingBatches, savePendingBatch,
	type PendingBatch,
} from '@/lib/data/pendingUploads';
import { CHUNK_SIZE } from '@buckitup/pq-client/fileCrypto';

const owner = 'u_owner';
const other = 'u_other';
let records: Map<string, string>;
let keyBytes: Map<string, number>;

beforeEach(() => {
	records = new Map();
	keyBytes = new Map([[owner, 1], [other, 2]]);
	const storage: StringStore = {
		async get(key) { return records.get(key) ?? null; },
		async set(key, value) { records.set(key, value); },
		async delete(key) { records.delete(key); },
		async keys() { return [...records.keys()]; },
		async clear() { records.clear(); },
	};
	_setPendingUploadsStoreForTests(storage, async (account) => {
		const fill = keyBytes.get(account);
		if (fill === undefined) throw new Error(`no key for ${account}: the account is not signed in`);
		return crypto.subtle.importKey('raw', new Uint8Array(32).fill(fill), 'AES-GCM', false, ['encrypt', 'decrypt']);
	});
});

const batch = (over: Partial<PendingBatch> = {}): PendingBatch => ({
	batchId: 'batch_1',
	peerHash: 'u_peer',
	caption: 'the contract',
	parts: [],
	files: [{
		order: 0, name: 'contract.pdf', size: 10, mimeType: 'application/pdf', createdAt: 1,
		fileId: 'f_' + 'a'.repeat(32), encSecretB64: 'c2VjcmV0LW9mLXRoZS1maWxl', chunkSize: CHUNK_SIZE, chunkCount: 1, digest: 'ab'.repeat(32),
	}],
	updatedAt: Date.now(),
	...over,
});

describe('pending uploads', () => {
	it('keeps the file key and names sealed, and reads them back for their account only', async () => {
		await savePendingBatch(owner, batch());
		const stored = [...records].join('\n');
		expect(stored).not.toContain('c2VjcmV0LW9mLXRoZS1maWxl');
		expect(stored).not.toContain('contract.pdf');
		expect(stored).not.toContain('the contract');
		expect(await pendingBatches(owner)).toEqual([batch({ updatedAt: expect.any(Number) as never })]);
		expect(await pendingBatches(other)).toEqual([]);
	});

	it('drops a record untouched for 48 hours', async () => {
		const now = Date.now();
		await savePendingBatch(owner, batch({ batchId: 'batch_old', updatedAt: now - PENDING_UPLOAD_TTL_MS - 1 }));
		await savePendingBatch(owner, batch({ batchId: 'batch_new', updatedAt: now - PENDING_UPLOAD_TTL_MS + 60_000 }));
		expect((await pendingBatches(owner, now)).map((b) => b.batchId)).toEqual(['batch_new']);
		expect([...records.keys()]).toEqual([`${owner}|batch_new`]);
	});

	it('drops another account\'s record untouched for 48 hours at any sign-in, without that account\'s key', async () => {
		const now = Date.now();
		await savePendingBatch(other, batch({ batchId: 'batch_old', updatedAt: now - PENDING_UPLOAD_TTL_MS - 1 }));
		await savePendingBatch(other, batch({ batchId: 'batch_new', updatedAt: now - 60_000 }));
		expect(JSON.parse(records.get(`${other}|batch_old`)!)).toMatchObject({ updatedAt: now - PENDING_UPLOAD_TTL_MS - 1 });
		keyBytes.delete(other); // the other account never signs in here again
		expect(await pendingBatches(owner, now)).toEqual([]);
		expect([...records.keys()]).toEqual([`${other}|batch_new`]);
	});

	it('drops a malformed record, one with nothing left to send, and one whose chunks were cut at another size', async () => {
		await savePendingBatch(owner, batch({ batchId: 'batch_empty', files: [] }));
		await savePendingBatch(owner, batch({ batchId: 'batch_size', files: [{ ...batch().files[0], chunkSize: 1024 }] }));
		await savePendingBatch(owner, { ...batch({ batchId: 'batch_bad' }), files: [{ order: 0 }] } as unknown as PendingBatch);
		expect(await pendingBatches(owner)).toEqual([]);
		expect(records.size).toBe(0);
	});

	it('keeps a record whose files all landed, until its message is stored for sending', async () => {
		const landed = batch({ files: [], parts: [{ order: 0, part: { kind: 'file', name: 'contract.pdf' } }] });
		await savePendingBatch(owner, landed);
		expect(await pendingBatches(owner)).toEqual([landed]);
	});

	it('skips a record that does not open, and keeps it', async () => {
		await savePendingBatch(owner, batch());
		keyBytes.set(owner, 3);
		expect(await pendingBatches(owner)).toEqual([]);
		expect(records.size).toBe(1);
	});

	it('forgets one batch, or all of an account', async () => {
		await savePendingBatch(owner, batch({ batchId: 'batch_1' }));
		await savePendingBatch(owner, batch({ batchId: 'batch_2' }));
		await savePendingBatch(other, batch({ batchId: 'batch_3' }));
		await forgetPendingBatch(owner, 'batch_1');
		expect((await pendingBatches(owner)).map((b) => b.batchId)).toEqual(['batch_2']);
		await forgetAccountPendingUploads(owner);
		expect([...records.keys()]).toEqual([`${other}|batch_3`]);
	});
});

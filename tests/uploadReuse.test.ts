import { beforeEach, describe, expect, it } from 'vitest';
import type { StringStore } from '@/lib/data/secureStore';
import {
	_setUploadReuseStoreForTests, forgetAccountUploads, rememberUpload, reusableUpload, uploadDigest,
} from '@/lib/data/uploadReuse';

const owner = 'u_owner';
const other = 'u_other';
const reference = { fileId: 'f_existing', encSecretB64: 'secret-for-existing-file' };
let records: Map<string, string>;

beforeEach(() => {
	records = new Map();
	const storage: StringStore = {
		async get(key) { return records.get(key) ?? null; },
		async set(key, value) { records.set(key, value); },
		async delete(key) { records.delete(key); },
		async keys() { return [...records.keys()]; },
		async clear() { records.clear(); },
	};
	const keys = new Map<string, Promise<CryptoKey>>();
	_setUploadReuseStoreForTests(storage, (account) => {
		let key = keys.get(account);
		if (!key) {
			key = crypto.subtle.importKey('raw', new Uint8Array(32).fill(account === owner ? 1 : 2), 'AES-GCM', false, ['encrypt', 'decrypt']);
			keys.set(account, key);
		}
		return key;
	});
});

describe('completed upload reuse', () => {
	it('matches bytes, not a filename, and keeps the key sealed for the owner', async () => {
		const first = await uploadDigest(new TextEncoder().encode('same file'));
		const again = await uploadDigest(new TextEncoder().encode('same file'));
		const different = await uploadDigest(new TextEncoder().encode('other file'));
		expect(again).toBe(first);
		expect(different).not.toBe(first);

		await rememberUpload(owner, first, reference);
		expect([...records.values()].join('')).not.toContain(reference.encSecretB64);
		const available = async (fileId: string, uploader: string) => {
			expect([fileId, uploader]).toEqual([reference.fileId, owner]);
			return { unknown: false, deleted: false, present: 2, total: 2 };
		};
		expect(await reusableUpload(owner, again, available)).toEqual(reference);
		expect(await reusableUpload(owner, different, available)).toBeNull();
		expect(await reusableUpload(other, again, available)).toBeNull();
	});

	it('does not reuse a missing or incomplete file, and forgets a deleted one', async () => {
		const digest = await uploadDigest(new Uint8Array([1, 2, 3]));
		await rememberUpload(owner, digest, reference);
		expect(await reusableUpload(owner, digest, async () =>
			({ unknown: true, deleted: false, present: 0, total: 0 }))).toBeNull();
		expect(await reusableUpload(owner, digest, async () =>
			({ unknown: false, deleted: false, present: 1, total: 2 }))).toBeNull();
		expect(await reusableUpload(owner, digest, async () =>
			({ unknown: false, deleted: true, present: 2, total: 2 }))).toBeNull();
		expect(records.size).toBe(0);
	});

	it('removes only the deleted account\'s references', async () => {
		await rememberUpload(owner, 'a', reference);
		await rememberUpload(other, 'a', reference);
		await forgetAccountUploads(owner);
		expect(records.size).toBe(1);
		expect([...records.keys()][0]).toMatch(/^u_other\|/);
	});
});

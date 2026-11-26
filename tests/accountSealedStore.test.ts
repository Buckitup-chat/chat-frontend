// Records kept per account in one database: sealed with the owner's key, and
// an account's removal takes its records only.
import { beforeEach, describe, expect, it } from 'vitest';
import type { StringStore } from '@/lib/data/secureStore';
import { DecryptFailedError } from '@/lib/data/secureStore';
import { accountSealedStore } from '@/lib/data/accountSealedStore';

let records: Map<string, string>;
const store = accountSealedStore('test-account-sealed');

beforeEach(() => {
	records = new Map();
	const memory: StringStore = {
		async get(key) { return records.get(key) ?? null; },
		async set(key, value) { records.set(key, value); },
		async delete(key) { records.delete(key); },
		async keys() { return [...records.keys()]; },
		async clear() { records.clear(); },
	};
	const keyBytes: Record<string, number> = { u_a: 1, u_a2: 2 };
	store.setForTests(memory, (owner) =>
		crypto.subtle.importKey('raw', new Uint8Array(32).fill(keyBytes[owner] ?? 9), 'AES-GCM', false, ['encrypt', 'decrypt']));
});

describe('a store sealed per account', () => {
	it('seals a record with its owner\'s key, and only the owner opens it', async () => {
		await store.sealed('u_a').set(store.keyOf('u_a', 'r1'), 'the file key');
		expect([...records.values()].join()).not.toContain('the file key');
		expect(await store.sealed('u_a').get(store.keyOf('u_a', 'r1'))).toBe('the file key');
		await expect(store.sealed('u_a2').get(store.keyOf('u_a', 'r1'))).rejects.toBeInstanceOf(DecryptFailedError);
	});

	it('forgets one account\'s records, not those of an account whose hash it begins', async () => {
		await store.sealed('u_a').set(store.keyOf('u_a', 'r1'), 'a');
		await store.sealed('u_a2').set(store.keyOf('u_a2', 'r1'), 'b');
		expect(store.isOwners('u_a', store.keyOf('u_a2', 'r1'))).toBe(false);
		await store.forgetAccount('u_a');
		expect([...records.keys()]).toEqual([store.keyOf('u_a2', 'r1')]);
	});
});

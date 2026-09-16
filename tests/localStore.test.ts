import { describe, it, expect, beforeEach, vi } from 'vitest';
import { kvGet, kvSet, kvDelete, _setStoreForTests } from '@/lib/data/localStore';
import { createSecureStore, deriveLocalStorageKey, type StringStore } from '@/lib/data/secureStore';

const makeRaw = (): StringStore & { map: Map<string, string> } => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k) { return map.get(k) ?? null; },
		async set(k, v) { map.set(k, v); },
		async delete(k) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const USER = 'u_' + 'a'.repeat(128);
const KEY = `us|${USER}|00000000-0000-4000-8000-000000000001`;

const entry = {
	row: {
		user_hash: USER,
		uuid: '00000000-0000-4000-8000-000000000001',
		value_b64: 'ZW5jcnlwdGVkLXByb2ZpbGU=',
		owner_timestamp: 1754000000,
		sign_b64: 'c2lnbmF0dXJl',
	},
	hash_b64: null,
	syncStatus: 'failed',
};

let raw: ReturnType<typeof makeRaw>;

const useAccount = async (seed: number) => {
	const key = await deriveLocalStorageKey(new Uint8Array(32).fill(seed));
	_setStoreForTests(createSecureStore(raw, { getKey: async () => key, hashKeys: true }));
};

beforeEach(() => { raw = makeRaw(); });

describe('localStore encryption', () => {
	it('round-trips a value', async () => {
		await useAccount(1);
		await kvSet(KEY, entry);
		expect(await kvGet(KEY)).toEqual(entry);
	});

	// Not just the value: the key name carries the account id, so a plain
	// listing of the object store would identify the user without any decryption.
	it('leaves neither the value nor the key name readable', async () => {
		await useAccount(1);
		await kvSet(KEY, entry);

		const names = [...raw.map.keys()].join('');
		expect(names).not.toContain(USER);
		expect(names).not.toContain('us|');

		const values = [...raw.map.values()].join('');
		expect(values).not.toContain(USER);
		expect(values).not.toContain('owner_timestamp');
		expect(values).not.toContain('c2lnbmF0dXJl');
	});

	// Record names are derived per account, so the same logical key resolves to
	// a different name for a different user: their record is invisible rather
	// than merely undecryptable — and, importantly, is left untouched.
	it('hides another account\'s record instead of colliding with it', async () => {
		await useAccount(1);
		await kvSet(KEY, entry);
		const theirName = [...raw.map.keys()][0];

		await useAccount(2);
		expect(await kvGet(KEY)).toBeUndefined();

		await kvSet(KEY, { ...entry, syncStatus: 'synced' });
		expect(raw.map.size).toBe(2);
		expect(raw.map.has(theirName)).toBe(true);

		await useAccount(1);
		expect(await kvGet(KEY)).toEqual(entry);
	});

	// A locked vault must surface as a failure. Reporting "no local revision"
	// would let a pending edit be treated as absent and overwritten.
	it('throws instead of reporting an empty result when locked', async () => {
		_setStoreForTests(
			createSecureStore(raw, {
				getKey: async () => { throw new Error('no unlocked account'); },
				hashKeys: true,
			})
		);
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(kvGet(KEY)).rejects.toThrow(/no unlocked account/);
		spy.mockRestore();
	});

	it('deletes a record', async () => {
		await useAccount(1);
		await kvSet(KEY, entry);
		await kvDelete(KEY);
		expect(await kvGet(KEY)).toBeUndefined();
		expect(raw.map.size).toBe(0);
	});

	it('reports a missing record as undefined', async () => {
		await useAccount(1);
		expect(await kvGet(KEY)).toBeUndefined();
	});

	it('keeps two accounts apart under the same logical key', async () => {
		await useAccount(1);
		await kvSet(KEY, entry);

		await useAccount(2);
		const other = { ...entry, syncStatus: 'synced' };
		await kvSet(`us|u_${'b'.repeat(128)}|slot`, other);

		expect(raw.map.size).toBe(2);
		expect(await kvGet(`us|u_${'b'.repeat(128)}|slot`)).toEqual(other);
	});
});

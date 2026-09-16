import { describe, it, expect, beforeEach } from 'vitest';
import { createSecureStore, deriveLocalStorageKey, type StringStore } from '../src/lib/data/secureStore';

// Plain in-memory store standing in for IndexedDB.
const makeMemoryStore = (): StringStore & { raw: Map<string, string> } => {
	const raw = new Map<string, string>();
	return {
		raw,
		async get(k) { return raw.has(k) ? (raw.get(k) as string) : null; },
		async set(k, v) { raw.set(k, v); },
		async delete(k) { raw.delete(k); },
		async keys() { return [...raw.keys()]; },
		async clear() { raw.clear(); },
	};
};

const keyFrom = (seed: number) => deriveLocalStorageKey(new Uint8Array(32).fill(seed));

let inner: ReturnType<typeof makeMemoryStore>;

beforeEach(() => { inner = makeMemoryStore(); });

describe('createSecureStore', () => {
	it('round-trips a value', async () => {
		const key = await keyFrom(1);
		const store = createSecureStore(inner, { getKey: async () => key });

		await store.set('id-1', JSON.stringify({ hello: 'world' }));
		expect(await store.get('id-1')).toBe('{"hello":"world"}');
	});

	// The whole point of the requirement: the envelope must not be readable,
	// not just the payload inside it.
	it('leaves nothing readable in the underlying store', async () => {
		const key = await keyFrom(1);
		const store = createSecureStore(inner, { getKey: async () => key });

		await store.set('id-1', JSON.stringify({ user_hash: 'u_abc', dialog_hash: 'di_def' }));

		const onDisk = [...inner.raw.values()].join('');
		expect(onDisk).not.toContain('u_abc');
		expect(onDisk).not.toContain('di_def');
		expect(onDisk).not.toContain('user_hash');
	});

	it('cannot be read with a different account key', async () => {
		const mine = await keyFrom(1);
		const theirs = await keyFrom(2);

		await createSecureStore(inner, { getKey: async () => mine }).set('id-1', 'secret');

		await expect(
			createSecureStore(inner, { getKey: async () => theirs }).get('id-1')
		).rejects.toThrow(/cannot decrypt/);
	});

	// A locked vault must not look like an empty store: silently returning null
	// would let the outbox conclude there is nothing pending and move on.
	it('propagates a locked vault instead of reporting an empty record', async () => {
		const store = createSecureStore(inner, {
			getKey: async () => { throw new Error('no unlocked account'); },
		});
		inner.raw.set('id-1', 'whatever');

		await expect(store.get('id-1')).rejects.toThrow(/no unlocked account/);
		await expect(store.set('id-2', 'x')).rejects.toThrow(/no unlocked account/);
	});

	it('produces different ciphertext for the same plaintext', async () => {
		const key = await keyFrom(1);
		const store = createSecureStore(inner, { getKey: async () => key });

		await store.set('a', 'same');
		const first = inner.raw.get('a');
		await store.set('a', 'same');

		// fresh IV per write: a rewrite is not distinguishable from a change
		expect(inner.raw.get('a')).not.toBe(first);
		expect(await store.get('a')).toBe('same');
	});

	it('returns null for a missing record', async () => {
		const key = await keyFrom(1);
		const store = createSecureStore(inner, { getKey: async () => key });
		expect(await store.get('nope')).toBeNull();
	});

	it('deletes and clears through to the inner store', async () => {
		const key = await keyFrom(1);
		const store = createSecureStore(inner, { getKey: async () => key });

		await store.set('a', '1');
		await store.set('b', '2');
		await store.delete('a');
		expect(await store.get('a')).toBeNull();
		expect(await store.get('b')).toBe('2');

		await store.clear();
		expect(inner.raw.size).toBe(0);
	});
});

// localStore keys embed the account id (`us|<user_hash>|<uuid>`), so the name
// itself has to be hidden — otherwise the identifier leaks even though the
// value is encrypted.
describe('createSecureStore with hashKeys', () => {
	it('hides the identifier in the key name but keeps lookups working', async () => {
		const key = await keyFrom(1);
		const store = createSecureStore(inner, { getKey: async () => key, hashKeys: true });

		await store.set('us|u_abc|profile', 'value');

		const names = [...inner.raw.keys()].join('');
		expect(names).not.toContain('u_abc');
		expect(names).not.toContain('profile');

		// deterministic: the same logical key still resolves
		expect(await store.get('us|u_abc|profile')).toBe('value');
	});

	it('maps different accounts to different record names', async () => {
		const key = await keyFrom(1);
		const store = createSecureStore(inner, { getKey: async () => key, hashKeys: true });

		await store.set('us|u_aaa|profile', 'a');
		await store.set('us|u_bbb|profile', 'b');

		expect(inner.raw.size).toBe(2);
		expect(await store.get('us|u_aaa|profile')).toBe('a');
		expect(await store.get('us|u_bbb|profile')).toBe('b');
	});
});

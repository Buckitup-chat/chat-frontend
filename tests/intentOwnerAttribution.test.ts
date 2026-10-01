import { describe, it, expect, vi, beforeEach } from 'vitest';

const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);

let currentUserHash: string | null = A;
const keyMaterialFor = (userHash: string) => (userHash === A ? '11'.repeat(16) : '22'.repeat(16));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() { return currentUserHash; },
			exportVaultKeys: async () => ({ crypt_skey: btoa(keyMaterialFor(currentUserHash!)), sign_skey: 'AAAA', evm_skey: 'cc' }),
		}),
	},
}));

const { enqueueIntent, intentsOf, resolveIntent, _setRawIntentStorageForTests } = await import('@/lib/data/intents');
const { clearLocalStorageKey } = await import('@/lib/data/localCrypto');
const { createSecureStore, deriveLocalStorageKey } = await import('@/lib/data/secureStore');

const makeStorage = () => {
	const map = new Map<string, string>();
	const store = {
		map,
		failGet: null as null | ((k: string) => boolean),
		async get(k: string) {
			if (store.failGet?.(k)) throw new Error('disk read error');
			return map.get(k) ?? null;
		},
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
	return store;
};

let raw: ReturnType<typeof makeStorage>;

const signInAs = (userHash: string) => {
	currentUserHash = userHash;
	clearLocalStorageKey();
};

const issueFor = async (key: string, userHash: string) => {
	signInAs(userHash);
	return (await intentsOf(userHash)).issues.find((i) => i.key === key);
};

beforeEach(() => {
	signInAs(A);
	raw = makeStorage();
	_setRawIntentStorageForTests(raw);
});

describe('an intent that cannot be read is attributed by its owner record', () => {
	it('this account\'s unreadable intent is "current" for it and "other" for another account — before and after a switch', async () => {
		const id = await enqueueIntent({ kind: 'ready-row', relation: 'user_cards', row: {} }, A, 'user_cards') as string;
		raw.failGet = (k) => k === id;

		expect(await issueFor(id, A)).toMatchObject({ kind: 'unavailable', owner: 'current' });
		expect(await issueFor(id, B)).toMatchObject({ kind: 'unavailable', owner: 'other' });
		expect(await issueFor(id, A)).toMatchObject({ owner: 'current' }); // the switch changed nothing
	});

	it('another account\'s unreadable intent is never this account\'s', async () => {
		signInAs(B);
		const id = await enqueueIntent({ kind: 'ready-row', relation: 'user_cards', row: {} }, B, 'user_cards') as string;
		raw.failGet = (k) => k === id;

		expect(await issueFor(id, A)).toMatchObject({ owner: 'other' });
	});

	it('an owner record that cannot be read proves nothing: the intent is "unknown", not this account\'s', async () => {
		const id = await enqueueIntent({ kind: 'ready-row', relation: 'user_cards', row: {} }, A, 'user_cards') as string;
		raw.failGet = (k) => k === id || k === `owner|${id}`;

		expect(await issueFor(id, A)).toMatchObject({ kind: 'unavailable', owner: 'unknown' });
	});

	it('an unreadable intent with no owner record is "unknown" — a userHash in its payload is not evidence', async () => {
		raw.map.set('intent-orphan', JSON.stringify({ id: 'intent-orphan', userHash: A, relation: 'user_cards', intent: {} }));
		raw.failGet = (k) => k === 'intent-orphan';

		expect(await issueFor('intent-orphan', A)).toMatchObject({ kind: 'unavailable', owner: 'unknown' });
	});

	it('a record this account\'s key decrypts but that does not parse is this account\'s; another account cannot open it at all', async () => {
		const keyA = await deriveLocalStorageKey(Uint8Array.from(atob(btoa(keyMaterialFor(A))), (c) => c.charCodeAt(0)));
		await createSecureStore(raw, { getKey: async () => keyA }).set('intent-corrupt', 'not json');

		expect(await issueFor('intent-corrupt', A)).toMatchObject({ kind: 'corrupt', owner: 'current' });
		expect(await issueFor('intent-corrupt', B)).toMatchObject({ kind: 'foreign', owner: 'other' });
	});

	it('another account scanning never rewrites the owner record, and resolution keeps it and the intent\'s purpose', async () => {
		const id = await enqueueIntent({ kind: 'ready-row', relation: 'user_cards', purpose: 'bootstrap-prerequisite', row: {} }, A, 'user_cards') as string;
		const ownerRecord = raw.map.get(`owner|${id}`);

		await issueFor(id, B);
		expect(raw.map.get(`owner|${id}`)).toBe(ownerRecord);

		signInAs(A);
		await resolveIntent(id, { outcome: 'durably-dispatched', ref: 'outbox-1' });
		expect(raw.map.get(`owner|${id}`)).toBe(ownerRecord);
		const [marker] = (await intentsOf(A, { includeResolved: true })).entries;
		expect(marker.intent).toMatchObject({ resolved: true, ref: 'outbox-1', purpose: 'bootstrap-prerequisite' });
	});

	it('an intent that fails to store leaves no owner record claiming it', async () => {
		const realSet = raw.set.bind(raw);
		raw.set = async (k: string, v: string) => { if (!k.startsWith('owner|')) throw new Error('disk full'); return realSet(k, v); };

		expect(await enqueueIntent({ text: 'x' }, A, 'dialog_messages')).toBeNull();
		expect([...raw.map.keys()]).toEqual([]);
	});
});

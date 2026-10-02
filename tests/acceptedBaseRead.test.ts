import { describe, it, expect, vi, beforeEach } from 'vitest';

const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);
let ambientUserHash: string | null = A;
let vaultOpen = true;

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() { return ambientUserHash; },
			exportVaultKeys: async () => {
				if (!vaultOpen) throw new Error('Vault not loaded');
				const seed = ambientUserHash === A ? 1 : 2;
				return { crypt_skey: btoa(String.fromCharCode(...new Uint8Array(32).fill(seed))) };
			},
		}),
	},
}));

const {
	readAcceptedBase, recordAccepted, acceptedState, _setRawAcceptedSnapshotStorageForTests,
} = await import('@/lib/data/acceptedSnapshot');
const { clearLocalStorageKey, getLocalStorageKey, getLocalStorageKeyFor } = await import('@/lib/data/localCrypto');
const { createSecureStore } = await import('@/lib/data/secureStore');
const { StorageReadError } = await import('@/lib/data/indexedDbStore');
const { AccountMismatchError, VaultLockedError } = await import('@/lib/data/keyCustody');

const makeRaw = () => {
	const map = new Map<string, string>();
	const writes: string[] = [];
	return {
		map,
		writes,
		failGet: null as null | (() => Error),
		async get(k: string) { if (this.failGet) throw this.failGet(); return map.get(k) ?? null; },
		async set(k: string, v: string) { writes.push(k); map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

const card = (userHash: string, extra: Record<string, unknown> = {}) => ({
	user_hash: userHash, sign_pkey: 'c2lnbg==', contact_pkey: 'Y29udGFjdA==', contact_cert: 'Y2VydA==',
	crypt_pkey: 'Y3J5cHQ=', crypt_cert: 'Y2VydA==', name: 'Me', deleted_flag: false, owner_timestamp: 100,
	sign_b64: 'c2ln', ...extra,
});
const slot = (userHash: string, uuid: string, extra: Record<string, unknown> = {}) => ({
	user_hash: userHash, uuid, value_b64: 'dmFsdWU=', deleted_flag: false, parent_sign_hash: null,
	owner_timestamp: 100, sign_b64: 'c2ln', sign_hash: 'uss_' + 'c'.repeat(128), ...extra,
});

let raw: ReturnType<typeof makeRaw>;
const sealAsA = (key: string, text: string) => createSecureStore(raw, { getKey: () => getLocalStorageKeyFor(A) }).set(key, text);
const tamper = (key: string) => {
	const value = raw.map.get(key)!;
	raw.map.set(key, value.slice(0, -4) + (value.at(-4) === 'A' ? 'B' : 'A') + value.slice(-3));
};

beforeEach(() => {
	ambientUserHash = A;
	vaultOpen = true;
	raw = makeRaw();
	_setRawAcceptedSnapshotStorageForTests(raw);
});

describe('readAcceptedBase: every outcome is stated', () => {
	it('a key storage answered is not there is missing', async () => {
		expect(await readAcceptedBase('user_cards', A, A)).toEqual({ kind: 'missing' });
		expect(await readAcceptedBase('user_storage', `${A}|slot-1`, A)).toEqual({ kind: 'missing' });
	});

	it('a stored row under a closed vault is locked', async () => {
		await recordAccepted('user_cards', A, card(A), A);
		clearLocalStorageKey();
		ambientUserHash = null;
		expect(await readAcceptedBase('user_cards', A, A)).toEqual({ kind: 'locked' });

		ambientUserHash = A;
		vaultOpen = false;
		expect(await readAcceptedBase('user_cards', A, A)).toEqual({ kind: 'locked' });
	});

	it('a strict adapter read failure is unavailable/io', async () => {
		raw.failGet = () => new StorageReadError('get', { cause: new DOMException('gone', 'UnknownError') });
		expect(await readAcceptedBase('user_cards', A, A)).toEqual({ kind: 'unavailable', failure: 'io' });
	});

	it('ciphertext that does not open is corrupt/undecryptable', async () => {
		await recordAccepted('user_cards', A, card(A), A);
		tamper(`user_cards:${A}`);
		expect(await readAcceptedBase('user_cards', A, A)).toEqual({ kind: 'corrupt', failure: 'undecryptable' });
	});

	it('decrypted bytes that are not JSON are corrupt/undecodable', async () => {
		await sealAsA(`user_cards:${A}`, '{"user_hash": ');
		expect(await readAcceptedBase('user_cards', A, A)).toEqual({ kind: 'corrupt', failure: 'undecodable' });
	});

	it('JSON that is not a row of the relation is corrupt/invalid', async () => {
		for (const text of ['42', '"a string"', 'null', '[]', JSON.stringify({ ...card(A), owner_timestamp: '100' }), JSON.stringify({ user_hash: A })]) {
			await sealAsA(`user_cards:${A}`, text);
			expect(await readAcceptedBase('user_cards', A, A)).toEqual({ kind: 'corrupt', failure: 'invalid' });
		}
		await sealAsA(`user_storage:${A}|slot-1`, JSON.stringify({ ...slot(A, 'slot-1'), sign_hash: undefined }));
		expect(await readAcceptedBase('user_storage', `${A}|slot-1`, A)).toEqual({ kind: 'corrupt', failure: 'invalid' });
	});

	it('a row naming another account is corrupt/foreign_owner', async () => {
		await sealAsA(`user_cards:${A}`, JSON.stringify(card(B)));
		expect(await readAcceptedBase('user_cards', A, A)).toEqual({ kind: 'corrupt', failure: 'foreign_owner' });
		await sealAsA(`user_storage:${A}|slot-1`, JSON.stringify(slot(B, 'slot-1')));
		expect(await readAcceptedBase('user_storage', `${A}|slot-1`, A)).toEqual({ kind: 'corrupt', failure: 'foreign_owner' });
	});

	it('a row of this account stored under another entity key is corrupt/invalid: no key opens another slot or card', async () => {
		await sealAsA(`user_storage:${A}|slot-1`, JSON.stringify(slot(A, 'slot-2')));
		expect(await readAcceptedBase('user_storage', `${A}|slot-1`, A)).toEqual({ kind: 'corrupt', failure: 'invalid' });
		await sealAsA(`user_cards:${B}`, JSON.stringify(card(A)));
		expect(await readAcceptedBase('user_cards', B, A)).toEqual({ kind: 'corrupt', failure: 'invalid' });
	});

	it('a valid user_cards row is present', async () => {
		await recordAccepted('user_cards', A, card(A), A);
		expect(await readAcceptedBase('user_cards', A, A)).toEqual({ kind: 'present', row: card(A) });
	});

	it('a valid user_storage row is present', async () => {
		await recordAccepted('user_storage', `${A}|slot-1`, slot(A, 'slot-1'), A);
		expect(await readAcceptedBase('user_storage', `${A}|slot-1`, A)).toEqual({ kind: 'present', row: slot(A, 'slot-1') });
	});

	it('a tombstone is present, not missing', async () => {
		const tombstone = slot(A, 'slot-1', { deleted_flag: true, value_b64: '' });
		await recordAccepted('user_storage', `${A}|slot-1`, tombstone, A);
		expect(await readAcceptedBase('user_storage', `${A}|slot-1`, A)).toEqual({ kind: 'present', row: tombstone });
		await recordAccepted('user_cards', A, card(A, { deleted_flag: true }), A);
		expect((await readAcceptedBase('user_cards', A, A)).kind).toBe('present');
	});

	it('an account switch is not a storage state: AccountMismatchError aborts the read', async () => {
		await recordAccepted('user_cards', A, card(A), A);
		clearLocalStorageKey();
		ambientUserHash = B;
		await expect(readAcceptedBase('user_cards', A, A)).rejects.toBeInstanceOf(AccountMismatchError);
	});
});

describe('acceptedState is a reading of readAcceptedBase, not a second classification', () => {
	it('a card that is not this account\'s valid card is unconfirmed, never clear', async () => {
		await sealAsA(`user_cards:${A}`, JSON.stringify(card(B)));
		expect(await acceptedState('user_cards', A, A)).toEqual({ kind: 'unconfirmed' });
		await sealAsA(`user_cards:${A}`, JSON.stringify({ user_hash: A }));
		expect(await acceptedState('user_cards', A, A)).toEqual({ kind: 'unconfirmed' });
	});

	it('present is clear and missing is absent', async () => {
		expect(await acceptedState('user_cards', A, A)).toEqual({ kind: 'absent' });
		await recordAccepted('user_cards', A, card(A), A);
		expect(await acceptedState('user_cards', A, A)).toEqual({ kind: 'clear', row: card(A) });
	});

	it('an account switch aborts it too', async () => {
		await recordAccepted('user_cards', A, card(A), A);
		clearLocalStorageKey();
		ambientUserHash = B;
		await expect(acceptedState('user_cards', A, A)).rejects.toBeInstanceOf(AccountMismatchError);
	});
});

describe('recordAccepted keeps what it cannot read', () => {
	const KEY = `user_storage:${A}|slot-1`;
	const put = (ts: number, extra: Record<string, unknown> = {}) => recordAccepted('user_storage', `${A}|slot-1`, slot(A, 'slot-1', { owner_timestamp: ts, ...extra }), A);

	it('ciphertext that does not open is not overwritten', async () => {
		await put(100);
		tamper(KEY);
		const kept = raw.map.get(KEY);
		raw.writes.length = 0;

		await expect(put(200)).rejects.toThrow(/kept, not overwritten/);
		expect(raw.writes).toEqual([]);
		expect(raw.map.get(KEY)).toBe(kept);
	});

	it('an existing record that is not JSON is not overwritten', async () => {
		await sealAsA(KEY, 'not json {{{');
		const kept = raw.map.get(KEY);
		raw.writes.length = 0;

		await expect(put(200)).rejects.toThrow(/kept, not overwritten/);
		expect(raw.writes).toEqual([]);
		expect(raw.map.get(KEY)).toBe(kept);
	});

	it('an existing record that is JSON but not an object is not overwritten', async () => {
		await sealAsA(KEY, '[1,2]');
		raw.writes.length = 0;
		await expect(put(200)).rejects.toThrow(/kept, not overwritten/);
		expect(raw.writes).toEqual([]);
	});

	it('a storage read failure writes nothing', async () => {
		await put(100);
		raw.writes.length = 0;
		raw.failGet = () => new StorageReadError('get', { cause: new Error('io') });

		await expect(put(200)).rejects.toBeInstanceOf(StorageReadError);
		expect(raw.writes).toEqual([]);
	});

	it('a locked vault writes nothing', async () => {
		await put(100);
		raw.writes.length = 0;
		clearLocalStorageKey();
		ambientUserHash = null;

		await expect(put(200)).rejects.toBeInstanceOf(VaultLockedError);
		expect(raw.writes).toEqual([]);
	});

	it('an account switch writes nothing', async () => {
		await put(100);
		raw.writes.length = 0;
		clearLocalStorageKey();
		ambientUserHash = B;

		await expect(put(200)).rejects.toBeInstanceOf(AccountMismatchError);
		expect(raw.writes).toEqual([]);
	});

	it('a missing record is written', async () => {
		await put(100);
		expect(raw.writes).toEqual([KEY]);
		expect(await readAcceptedBase('user_storage', `${A}|slot-1`, A)).toMatchObject({ kind: 'present', row: { owner_timestamp: 100 } });
	});

	it('a readable older row is replaced by a fresher one', async () => {
		await put(100);
		await put(200);
		expect(await readAcceptedBase('user_storage', `${A}|slot-1`, A)).toMatchObject({ kind: 'present', row: { owner_timestamp: 200 } });
	});

	it('a readable fresher row is not replaced by a stale one', async () => {
		await put(200);
		raw.writes.length = 0;
		await put(100);
		expect(raw.writes).toEqual([]);
		expect(await readAcceptedBase('user_storage', `${A}|slot-1`, A)).toMatchObject({ kind: 'present', row: { owner_timestamp: 200 } });
	});
});

describe('recordAccepted for base relations: only a proven row is replaced, only a valid row is written', () => {
	const MARKER = 'STORED-CONTENT-MARKER';
	const SLOT_KEY = `${A}|slot-1`;
	const RAW_KEY = `user_storage:${SLOT_KEY}`;

	const refusedOver = async (existing: string | null, attempt: () => Promise<unknown>) => {
		if (existing !== null) await sealAsA(RAW_KEY, existing);
		const before = raw.map.get(RAW_KEY);
		raw.writes.length = 0;

		const error = await attempt().then(() => null, (e: unknown) => e as Error);
		expect(error).toBeInstanceOf(Error);
		expect(error!.message).not.toContain(MARKER);
		expect(raw.writes).toEqual([]);
		expect(raw.map.get(RAW_KEY)).toBe(before);
	};
	const write = (row: Record<string, unknown>) => recordAccepted('user_storage', SLOT_KEY, row, A);

	it('a readable stored row of another owner is not overwritten', async () => {
		await refusedOver(JSON.stringify(slot(B, 'slot-1', { value_b64: MARKER, owner_timestamp: 1 })), () => write(slot(A, 'slot-1', { owner_timestamp: 500 })));
	});

	it('a readable stored row of this owner under another entity key is not overwritten', async () => {
		await refusedOver(JSON.stringify(slot(A, 'slot-2', { value_b64: MARKER, owner_timestamp: 1 })), () => write(slot(A, 'slot-1', { owner_timestamp: 500 })));
	});

	it('a readable stored object that is not a valid row is not overwritten', async () => {
		await refusedOver(JSON.stringify({ user_hash: A, uuid: 'slot-1', note: MARKER }), () => write(slot(A, 'slot-1', { owner_timestamp: 500 })));
	});

	it('an incoming row of another owner is not written, not even into an empty store', async () => {
		await refusedOver(null, () => write(slot(B, 'slot-1', { value_b64: MARKER })));
	});

	it('an incoming row naming another entity than its key is not written', async () => {
		await refusedOver(null, () => write(slot(A, 'slot-2', { value_b64: MARKER })));
	});

	it('an incoming row that is not a valid row of the relation is not written', async () => {
		await refusedOver(null, () => write({ ...slot(A, 'slot-1', { value_b64: MARKER }), sign_hash: 42 }));
		await refusedOver(null, () => recordAccepted('user_cards', A, { ...card(A, { name: MARKER }), crypt_cert: undefined }, A));
	});

	it('a base relation without an owner is refused before any storage access', async () => {
		let reads = 0;
		const realGet = raw.get.bind(raw);
		raw.get = async (k: string) => { reads++; return realGet(k); };
		await refusedOver(null, () => recordAccepted('user_storage', SLOT_KEY, slot(A, 'slot-1', { value_b64: MARKER })));
		expect(reads).toBe(0);
	});

	it('a valid row goes into an empty store, replaces an older valid row, and loses to a fresher one', async () => {
		await write(slot(A, 'slot-1', { owner_timestamp: 100 }));
		expect(raw.writes).toEqual([RAW_KEY]);

		await write(slot(A, 'slot-1', { owner_timestamp: 200 }));
		expect(await readAcceptedBase('user_storage', SLOT_KEY, A)).toMatchObject({ kind: 'present', row: { owner_timestamp: 200 } });

		raw.writes.length = 0;
		await write(slot(A, 'slot-1', { owner_timestamp: 150 }));
		expect(raw.writes).toEqual([]);
		expect(await readAcceptedBase('user_storage', SLOT_KEY, A)).toMatchObject({ kind: 'present', row: { owner_timestamp: 200 } });
	});

	it('dialog relations keep the generic rule: any readable object, no owner needed, freshest wins', async () => {
		const KEY = 'dialog_messages:dmsg_1';
		await createSecureStore(raw, { getKey: getLocalStorageKey }).set(KEY, JSON.stringify({ owner_timestamp: 1, anything: 'goes' }));

		await recordAccepted('dialog_messages', 'dmsg_1', { owner_timestamp: 2, message_id: 'dmsg_1' });
		raw.writes.length = 0;
		await recordAccepted('dialog_messages', 'dmsg_1', { owner_timestamp: 1, message_id: 'stale' });

		expect(raw.writes).toEqual([]);
		expect(JSON.parse((await createSecureStore(raw, { getKey: getLocalStorageKey }).get(KEY))!)).toEqual({ owner_timestamp: 2, message_id: 'dmsg_1' });
	});
});

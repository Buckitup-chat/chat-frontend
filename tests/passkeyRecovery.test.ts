import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { deriveVaultLocator, sealVault } from '@buckitup/pq-client/vaultEnvelope';
import { createPrfPasskey, readLockSeed, assertPrf } from '@buckitup/pq-client/vaultLock';
import { toBase64 } from '@buckitup/pq-client/signature';
import { TransportError } from '@buckitup/pq-client/transport';
import { fetchVault, assertVaultReadableAnonymously } from '@/lib/recovery/vault';
import { SessionFencedError } from '@/lib/data/sessionGuard';
import {
	enablePasskeyRecovery, recoverWithPasskey, retirePasskeyRecovery, credentialKey, recoverySalt, recoveryWrapKey,
	fingerprintOf, isCopyStale, detectPrfSupport, renewPasskeyRecoveryAtLogin,
	PasskeyRecoveryError, type PasskeyEnvelopeEntry,
} from '@/lib/recovery/passkeyRecovery';
import type { BackupContents } from '@/lib/backupContents';
import { prfAuthenticator } from './helpers/prfAuthenticator';

vi.mock('@/lib/data/readSession', () => ({ bearerFor: () => 'Bearer session-token', handleShapeAuth401: async () => false }));

type Row = { user_hash: string; uuid: string; value_b64: string; deleted_flag: boolean };

const account = (): BackupContents => {
	const { publicKey, secretKey } = ml_dsa87.keygen(crypto.getRandomValues(new Uint8Array(32)));
	return {
		identity: { user_hash: 'u_' + bytesToHex(sha3_512(publicKey)), name: 'Alice', sign_pkey: toBase64(publicKey) },
		keys: { sign_skey: toBase64(secretKey), crypt_skey: 'Y3J5cHQ=', evm_skey: 'ab', contact_skey: 'cd' },
	};
};

let rows: Row[];
let answer: 'ok' | number | 'network' | 'timeout';
let reads: number;
let slot: Record<string, PasskeyEnvelopeEntry>;
let backup: BackupContents;
let authorizations: Array<string | null>;
let switched: boolean;
let deviceBoundAsked: number;
let deviceBoundReasons: string[];
let deviceBoundAnswer: () => Promise<boolean>;

const deps = () => ({
	owner: backup.identity.user_hash,
	assertCurrent: () => {
		if (switched) throw new SessionFencedError('passkey recovery: the account changed; nothing more was written');
	},
	assertReadable: assertVaultReadableAnonymously,
	publish: async (wrapKey: Uint8Array, json: string) => {
		const uuid = deriveVaultLocator(wrapKey);
		rows = rows.filter((r) => !(r.uuid === uuid && r.user_hash === backup.identity.user_hash));
		rows.push({ user_hash: backup.identity.user_hash, uuid, value_b64: await sealVault(json, wrapKey), deleted_flag: false });
		return uuid;
	},
	tombstone: async (uuid: string) => {
		rows = rows.filter((r) => !(r.uuid === uuid && r.user_hash === backup.identity.user_hash));
		rows.push({ user_hash: backup.identity.user_hash, uuid, value_b64: '', deleted_flag: true });
	},
	recordEntry: async (key: string, entry: PasskeyEnvelopeEntry | null) => {
		if (entry) slot[key] = entry;
		else delete slot[key];
	},
	confirmDeviceBound: (reason: string) => {
		deviceBoundAsked++;
		deviceBoundReasons.push(reason);
		return deviceBoundAnswer();
	},
});

beforeEach(() => {
	rows = [];
	answer = 'ok';
	reads = 0;
	slot = {};
	backup = account();
	authorizations = [];
	switched = false;
	deviceBoundAsked = 0;
	deviceBoundReasons = [];
	deviceBoundAnswer = async () => true;
	vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
		reads++;
		authorizations.push((init?.headers as Record<string, string> | undefined)?.Authorization ?? null);
		if (answer === 'network') throw new TypeError('Failed to fetch');
		if (answer === 'timeout') throw new DOMException('signal timed out', 'TimeoutError');
		if (typeof answer === 'number') return new Response(JSON.stringify({ error: 'read_session_required', shape: 'user_storage' }), { status: answer });
		const where = decodeURIComponent(new URL(url, 'http://localhost').searchParams.get('where') ?? '');
		const uuid = /uuid='([^']+)'/.exec(where)?.[1];
		return new Response(JSON.stringify(rows.filter((r) => r.uuid === uuid).map((value) => ({ value }))), { status: 200 });
	});
});
afterEach(() => vi.unstubAllGlobals());

const who = { rpId: 'localhost', vaultId: 'vault1', name: 'Alice' };

const enabled = async (auth = prfAuthenticator('at-create')) => {
	const { record } = await createPrfPasskey(auth.credentials, who);
	const result = await enablePasskeyRecovery({
		credentials: auth.credentials, lock: record, label: 'Laptop', exportBackup: async () => backup, ...deps(), now: () => 1_700_000_000_000,
	});
	if (!result) throw new Error('test: recovery was declined');
	return { auth, lock: record, ...result };
};

const recover = (auth: ReturnType<typeof prfAuthenticator>) =>
	recoverWithPasskey({ credentials: auth.credentials, rpId: 'localhost', fetchVault });

const reasonOf = async (p: Promise<unknown>) => {
	const e = await p.then(() => null, (err) => err);
	expect(e).toBeInstanceOf(PasskeyRecoveryError);
	return (e as PasskeyRecoveryError).reason;
};

describe('turning passkey recovery on', () => {
	it('asks the vault\'s own passkey, publishes the backup and lists it in the slot', async () => {
		const { auth, lock, key, entry } = await enabled();
		expect(key).toBe(credentialKey(lock.credentialId));
		expect(entry).toEqual({ label: 'Laptop', locator: rows[0].uuid, synced: true, eligible: true, created_at: 1_700_000_000, fingerprint: fingerprintOf(backup), state: 'active' });
		expect(slot).toEqual({ [key]: entry });
		expect(auth.calls).toEqual(['create', 'get']);
		expect(JSON.stringify(slot)).not.toContain(lock.credentialId);
	});

	it('records a passkey that cannot sync as such', async () => {
		const { entry } = await enabled(prfAuthenticator('at-create', { backupEligible: false, backupState: false }));
		expect(entry).toMatchObject({ synced: false, eligible: false });
	});

	it('turns on a passkey that syncs without asking anything more, also one with no confirmed backup yet', async () => {
		const { auth, entry } = await enabled();
		expect(deviceBoundAsked).toBe(0);
		expect(auth.calls).toEqual(['create', 'get']);
		expect(entry).toMatchObject({ eligible: true, synced: true });
		const unsynced = await enabled(prfAuthenticator('at-create', { backupEligible: true, backupState: false }));
		expect(deviceBoundAsked).toBe(0);
		expect(unsynced.entry).toMatchObject({ eligible: true, synced: false, state: 'active' });
	});

	it('leaves a pending entry, not an unlisted envelope, when the publish fails', async () => {
		const auth = prfAuthenticator('at-create');
		const { record } = await createPrfPasskey(auth.credentials, who);
		const failure = new Error('server refused');
		await expect(enablePasskeyRecovery({
			credentials: auth.credentials, lock: record, label: 'Laptop', exportBackup: async () => backup,
			...deps(), publish: async () => { throw failure; },
		})).rejects.toBe(failure);
		expect(Object.values(slot)).toEqual([expect.objectContaining({ state: 'pending' })]);
		expect(rows).toEqual([]);
	});

	it('a backup whose keys are not its account\'s is neither listed nor published', async () => {
		const auth = prfAuthenticator('at-create');
		const { record } = await createPrfPasskey(auth.credentials, who);
		const spoiled = { ...backup, identity: { ...backup.identity, user_hash: 'u_' + 'ab'.repeat(64) } };
		await expect(enablePasskeyRecovery({
			credentials: auth.credentials, lock: record, label: 'Laptop', exportBackup: async () => spoiled, ...deps(),
		})).rejects.toMatchObject({ reason: 'invalid' });
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
	});

	it('a dismissed prompt or a passkey without PRF writes nothing', async () => {
		const auth = prfAuthenticator('at-create');
		const { record } = await createPrfPasskey(auth.credentials, who);
		auth.refuseNext();
		const opts = { credentials: auth.credentials, lock: record, label: 'L', exportBackup: async () => backup, ...deps() };
		expect(await reasonOf(enablePasskeyRecovery(opts))).toBe('cancelled');
		const get = auth.credentials.get;
		auth.credentials.get = async (o) => ({ ...(await get(o)), getClientExtensionResults: () => ({ prf: {} }) }) as unknown as PublicKeyCredential;
		expect(await reasonOf(enablePasskeyRecovery(opts))).toBe('no-prf');
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
	});

	it('is refused, with nothing written, where a device that is not signed in cannot read the envelope', async () => {
		const auth = prfAuthenticator('at-create');
		const { record } = await createPrfPasskey(auth.credentials, who);
		answer = 401;
		expect(await reasonOf(enablePasskeyRecovery({ credentials: auth.credentials, lock: record, label: 'L', exportBackup: async () => backup, ...deps() }))).toBe('unauthorized');
		expect(authorizations).toEqual([null]);
		answer = 'network';
		expect(await reasonOf(enablePasskeyRecovery({ credentials: auth.credentials, lock: record, label: 'L', exportBackup: async () => backup, ...deps() }))).toBe('network');
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
	});

	it('stops before any write when another account is opened during the passkey prompt', async () => {
		const auth = prfAuthenticator('at-create');
		const { record } = await createPrfPasskey(auth.credentials, who);
		const get = auth.credentials.get;
		auth.credentials.get = async (o) => {
			switched = true;
			return get(o);
		};
		let exported = 0;
		const result = enablePasskeyRecovery({
			credentials: auth.credentials, lock: record, label: 'L', exportBackup: async () => { exported++; return backup; }, ...deps(),
		});
		expect(await reasonOf(result)).toBe('account-changed');
		expect(exported).toBe(0);
		expect(reads).toBe(0);
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
	});

	it('refuses a backup of another account than the one it began for', async () => {
		const auth = prfAuthenticator('at-create');
		const { record } = await createPrfPasskey(auth.credentials, who);
		const other = account();
		expect(await reasonOf(enablePasskeyRecovery({
			credentials: auth.credentials, lock: record, label: 'L', exportBackup: async () => other, ...deps(),
		}))).toBe('account-changed');
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
	});
});

describe('turning it on for a passkey that cannot sync (BE = 0)', () => {
	type Auth = ReturnType<typeof prfAuthenticator>;

	const recording = (auth: Auth, onSecond?: (options: NonNullable<Parameters<Auth['credentials']['get']>[0]>) => Promise<PublicKeyCredential>) => {
		const get = auth.credentials.get;
		const boundTo: Array<string | null> = [];
		auth.credentials.get = async (options) => {
			const allowed = options!.publicKey!.allowCredentials?.[0];
			boundTo.push(allowed ? toBase64(new Uint8Array(allowed.id as Uint8Array)) : null);
			return boundTo.length === 2 && onSecond ? onSecond(options!) : get(options);
		};
		return boundTo;
	};

	const deviceBound = async () => {
		const auth = prfAuthenticator('at-create', { backupEligible: false, backupState: false });
		const { record } = await createPrfPasskey(auth.credentials, who);
		const keys: Uint8Array[] = [];
		const base = deps();
		const opts = {
			credentials: auth.credentials, lock: record, label: 'Laptop', exportBackup: async () => backup, ...base,
			assertReadable: (key: Uint8Array) => { keys.push(key); return base.assertReadable(key); },
			publish: (key: Uint8Array, json: string) => { keys.push(key); return base.publish(key, json); },
		};
		return { auth, lock: record, opts, keys };
	};
	const allZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);

	it('declined: resolves to nothing, with no slot entry, no envelope and no read', async () => {
		const { auth, opts } = await deviceBound();
		const boundTo = recording(auth);
		deviceBoundAnswer = async () => false;
		expect(await enablePasskeyRecovery(opts)).toBeNull();
		expect(deviceBoundAsked).toBe(1);
		expect(boundTo).toHaveLength(1);
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
		expect(reads).toBe(0);
	});

	it('asks before anything is written, holding no PRF value: a "yes" asks the same passkey again', async () => {
		const { auth, lock, opts, keys } = await deviceBound();
		const boundTo = recording(auth);
		deviceBoundAnswer = async () => {
			expect(boundTo).toHaveLength(1);
			expect(reads).toBe(0);
			expect(slot).toEqual({});
			return true;
		};
		const result = await enablePasskeyRecovery(opts);
		expect(deviceBoundAsked).toBe(1);
		expect(boundTo).toEqual([lock.credentialId, lock.credentialId]);
		expect(auth.calls).toEqual(['create', 'get', 'get']);
		expect(result!.entry).toMatchObject({ eligible: false, synced: false, state: 'active' });
		expect(slot).toEqual({ [credentialKey(lock.credentialId)]: result!.entry });
		expect(keys).toHaveLength(2);
		expect(keys.every(allZero)).toBe(true);
		const found = await recover(auth);
		expect(found.backup.identity.user_hash).toBe(backup.identity.user_hash);
		found.prepared.seed.fill(0);
	});

	it.each([
		['dismissed', async () => { throw new DOMException('cancelled', 'NotAllowedError'); }, 'cancelled'],
		['refused by the browser', async () => { throw new DOMException('rp', 'SecurityError'); }, 'passkey-failed'],
		['answered without PRF', null, 'no-prf'],
		['answered by another passkey', 'other', 'wrong-passkey'],
	] as const)('a second assertion %s writes nothing', async (_, second, reason) => {
		const { auth, opts } = await deviceBound();
		const { record: other } = await createPrfPasskey(auth.credentials, { ...who, vaultId: 'vault2' });
		const get = auth.credentials.get;
		recording(auth, async (options) => {
			if (second === 'other') {
				auth.choose(other.credentialId);
				return get({ publicKey: { ...options.publicKey!, allowCredentials: undefined } });
			}
			if (second === null) return { ...(await get(options)), getClientExtensionResults: () => ({ prf: {} }) } as unknown as PublicKeyCredential;
			return second();
		});
		expect(await reasonOf(enablePasskeyRecovery(opts))).toBe(reason);
		expect(deviceBoundAsked).toBe(1);
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
		expect(reads).toBe(0);
	});

	it('a failure after the second assertion wipes the wrap key and leaves no envelope', async () => {
		const { opts, keys } = await deviceBound();
		answer = 'network';
		expect(await reasonOf(enablePasskeyRecovery(opts))).toBe('network');
		expect(keys).toHaveLength(1);
		expect(allZero(keys[0])).toBe(true);
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
	});

	it('stops when another account is opened while the person decides, without asking the passkey again', async () => {
		const { auth, opts } = await deviceBound();
		const boundTo = recording(auth);
		deviceBoundAnswer = async () => { switched = true; return true; };
		expect(await reasonOf(enablePasskeyRecovery(opts))).toBe('account-changed');
		expect(boundTo).toHaveLength(1);
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
	});

	it('does not ask again when renewing a copy already listed as staying on this device', async () => {
		const { auth, opts } = await deviceBound();
		const first = await enablePasskeyRecovery(opts);
		expect(deviceBoundAsked).toBe(1);
		const boundTo = recording(auth);
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		const renewed = await enablePasskeyRecovery({ ...opts, previous: first!.entry });
		expect(deviceBoundAsked).toBe(1);
		expect(boundTo).toHaveLength(1);
		expect(renewed!.entry.fingerprint).toBe(fingerprintOf(backup));
	});
});

describe('turning it on for a passkey whose assertion did not say whether it syncs', () => {
	const flagless = () => {
		const auth = prfAuthenticator('at-create');
		const get = auth.credentials.get;
		auth.credentials.get = async (options) => ({ ...(await get(options)), response: {} }) as unknown as PublicKeyCredential;
		return auth;
	};

	it('asks, saying it could not tell, and records the flags as unknown rather than as "does not sync"', async () => {
		const auth = flagless();
		const { entry } = await enabled(auth);
		expect(deviceBoundReasons).toEqual(['unknown']);
		expect(auth.calls).toEqual(['create', 'get', 'get']);
		expect(entry).toMatchObject({ eligible: null, synced: null, state: 'active' });
	});

	it('declined: nothing is written', async () => {
		const auth = flagless();
		const { record } = await createPrfPasskey(auth.credentials, who);
		deviceBoundAnswer = async () => false;
		expect(await enablePasskeyRecovery({ credentials: auth.credentials, lock: record, label: 'L', exportBackup: async () => backup, ...deps() })).toBeNull();
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
	});

	it('says "does not sync" only for BE = 0, and asks nothing for BE = 1', async () => {
		const { entry } = await enabled(prfAuthenticator('at-create', { backupEligible: false, backupState: false }));
		expect(deviceBoundReasons).toEqual(['not-eligible']);
		expect(entry).toMatchObject({ eligible: false, synced: false });
		await enabled(prfAuthenticator('at-create'));
		expect(deviceBoundReasons).toEqual(['not-eligible']);
	});

	it('does not ask again when renewing a copy whose sync was already unknown', async () => {
		const auth = flagless();
		const { lock, entry } = await enabled(auth);
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		await enablePasskeyRecovery({ credentials: auth.credentials, lock, label: 'L', previous: entry, exportBackup: async () => backup, ...deps() });
		expect(deviceBoundAsked).toBe(1);
	});
});

describe('a sealed copy whose backup has changed since', () => {
	it('is stale once the account exports a key the copy lacks, a changed value or a changed identity field, and not before', async () => {
		const { entry } = await enabled();
		expect(isCopyStale(entry, fingerprintOf(backup))).toBe(false);
		const withSeed = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		expect(isCopyStale(entry, fingerprintOf(withSeed))).toBe(true);
		const otherValue = { ...backup, keys: { ...backup.keys, crypt_skey: 'b3RoZXI=' } };
		expect(isCopyStale(entry, fingerprintOf(otherValue))).toBe(true);
		const otherIdentity = { ...backup, identity: { ...backup.identity, crypt_cert: 'new-cert' } };
		expect(isCopyStale(entry, fingerprintOf(otherIdentity))).toBe(true);
	});

	it('is not stale for the order of fields, or for what is only shown or kept on this device', async () => {
		const { entry } = await enabled();
		const reordered = {
			keys: Object.fromEntries(Object.entries(backup.keys).reverse()),
			identity: Object.fromEntries(Object.entries(backup.identity).reverse()) as BackupContents['identity'],
		};
		expect(isCopyStale(entry, fingerprintOf(reordered))).toBe(false);
		const shown = { ...backup, identity: { ...backup.identity, name: 'Renamed', avatar: 'data:image/png;base64,AA', avatarId: 'a1', userStorage: { notes: 'n' }, vaultId: 'v9', vaultLock: 'prf' } };
		expect(isCopyStale(entry, fingerprintOf(shown))).toBe(false);
	});

	it('is renewed by turning it on again: the new key is in the envelope and the entry keeps its creation time', async () => {
		const { auth, lock, entry } = await enabled();
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		const renewed = await enablePasskeyRecovery({
			credentials: auth.credentials, lock, label: entry.label, previous: entry, exportBackup: async () => backup,
			...deps(), now: () => 1_800_000_000_000,
		});
		expect(renewed!.entry.created_at).toBe(entry.created_at);
		expect(renewed!.entry.fingerprint).toBe(fingerprintOf(backup));
		expect(rows).toHaveLength(1);
		const found = await recover(auth);
		expect(found.backup.keys.meta_seed).toBe('ff');
		found.prepared.seed.fill(0);
	});
});

describe('renewing an enabled copy at sign-in', () => {
	const loginPrf = async (auth: ReturnType<typeof prfAuthenticator>, lock: Awaited<ReturnType<typeof enabled>>['lock']) =>
		(await assertPrf(auth.credentials, { rpId: lock.rpId, credentialId: lock.credentialId, first: recoverySalt() })).first;

	const renew = async (
		auth: ReturnType<typeof prfAuthenticator>,
		lock: Awaited<ReturnType<typeof enabled>>['lock'],
		over: Partial<Parameters<typeof renewPasskeyRecoveryAtLogin>[0]> = {},
	) => {
		const prf = await loginPrf(auth, lock);
		const outcome = await renewPasskeyRecoveryAtLogin({
			prf, flags: { backupEligible: true, backupState: true }, lock, ...deps(),
			readEntry: async (key) => slot[key] ?? null,
			exportBackup: async () => backup,
			...over,
		}).catch((e) => e);
		return { prf, outcome };
	};

	it('reseals what the account now exports, with the prompt already made, and keeps the entry active throughout', async () => {
		const { auth, lock, key, entry } = await enabled();
		const before = rows[0].value_b64;
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		const states: string[] = [];
		const { outcome } = await renew(auth, lock, {
			recordEntry: async (k, e) => {
				states.push(`${e?.state}@${rows[0].value_b64 === before ? 'old' : 'new'}`);
				if (e) slot[k] = e;
			},
		});
		expect(outcome).toBe('renewed');
		expect(states).toEqual(['active@new']);
		expect(slot[key]).toEqual({ ...entry, fingerprint: fingerprintOf(backup) });
		expect(rows).toHaveLength(1);
		expect(rows[0].value_b64).not.toBe(before);
		const found = await recover(auth);
		expect(found.backup.keys.meta_seed).toBe('ff');
		found.prepared.seed.fill(0);
	});

	it('takes the passkey\'s flags from the sign-in assertion when it renews', async () => {
		const { auth, lock, key } = await enabled();
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		await renew(auth, lock, { flags: { backupEligible: true, backupState: false } });
		expect(slot[key]).toMatchObject({ synced: false, eligible: true });
	});

	it('writes nothing when the copy already holds what the account exports', async () => {
		const { auth, lock } = await enabled();
		const writes = vi.fn();
		const { outcome } = await renew(auth, lock, { publish: async (...a) => { writes(...a); return 'u'; }, recordEntry: async () => writes() });
		expect(outcome).toBe('current');
		expect(writes).not.toHaveBeenCalled();
	});

	it('leaves a passkey that never turned it on, and a setup left unfinished, alone', async () => {
		const { auth, lock, key, entry } = await enabled();
		const writes = vi.fn();
		const quiet = { publish: async () => { writes(); return 'u'; }, recordEntry: async () => writes() };
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		expect((await renew(auth, lock, { ...quiet, readEntry: async () => null })).outcome).toBe('not-enabled');
		expect((await renew(auth, lock, { ...quiet, readEntry: async () => ({ ...entry, state: 'pending' as const }) })).outcome).toBe('unfinished');
		expect(writes).not.toHaveBeenCalled();
		expect(slot[key]).toEqual(entry);
	});

	it('does not say it renewed when the envelope was not accepted: the old fingerprint stays, so it still reads as stale', async () => {
		const { auth, lock, key, entry } = await enabled();
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		const { outcome } = await renew(auth, lock, { publish: async () => { throw new TransportError('503', { status: 503 }); } });
		expect(outcome).toBeInstanceOf(PasskeyRecoveryError);
		expect(slot[key]).toEqual(entry);
		expect(isCopyStale(slot[key], fingerprintOf(backup))).toBe(true);
	});

	it('does not say it renewed when the slot was not written after the envelope: the next sign-in finds it stale and tries again', async () => {
		const { auth, lock, key, entry } = await enabled();
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		const failed = await renew(auth, lock, { recordEntry: async () => { throw new TransportError('offline', { network: true }); } });
		expect((failed.outcome as PasskeyRecoveryError).reason).toBe('network');
		expect(slot[key]).toEqual(entry);
		expect((await renew(auth, lock)).outcome).toBe('renewed');
		expect(slot[key].fingerprint).toBe(fingerprintOf(backup));
	});

	it('stops before its next write when another account is opened meanwhile', async () => {
		const { auth, lock, key, entry } = await enabled();
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		const before = rows[0].value_b64;
		const { outcome } = await renew(auth, lock, { exportBackup: async () => { switched = true; return backup; } });
		expect((outcome as PasskeyRecoveryError).reason).toBe('account-changed');
		expect(rows[0].value_b64).toBe(before);
		expect(slot[key]).toEqual(entry);
	});

	it('refuses a backup of another account, and a copy this passkey\'s value does not derive', async () => {
		const { auth, lock, entry } = await enabled();
		const foreign = account();
		expect(((await renew(auth, lock, { exportBackup: async () => foreign })).outcome as PasskeyRecoveryError).reason).toBe('account-changed');
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		const other = await renew(auth, lock, { readEntry: async () => ({ ...entry, locator: 'someone-elses' }) });
		expect((other.outcome as PasskeyRecoveryError).reason).toBe('foreign');
	});

	it('wipes the value on every path', async () => {
		const { auth, lock, entry } = await enabled();
		backup = { ...backup, keys: { ...backup.keys, meta_seed: 'ff' } };
		const wiped = (prf: Uint8Array) => expect([...prf].every((b) => b === 0)).toBe(true);
		wiped((await renew(auth, lock)).prf);
		wiped((await renew(auth, lock, { readEntry: async () => null })).prf);
		wiped((await renew(auth, lock, { readEntry: async () => ({ ...entry, state: 'pending' as const }) })).prf);
		wiped((await renew(auth, lock, { publish: async () => { throw new Error('x'); } })).prf);
		wiped((await renew(auth, lock, { readEntry: async () => { throw new Error('x'); } })).prf);
	});
});

describe('whether the browser can do PRF', () => {
	afterEach(() => vi.unstubAllGlobals());
	const browser = (capabilities?: () => Promise<Record<string, boolean>>) => {
		vi.stubGlobal('navigator', { credentials: { get: async () => null } });
		vi.stubGlobal('PublicKeyCredential', { getClientCapabilities: capabilities, isUserVerifyingPlatformAuthenticatorAvailable: async () => false });
	};

	it('says so only when the browser says no, never because no platform authenticator is there', async () => {
		browser(async () => ({ 'extension:prf': true }));
		expect(await detectPrfSupport()).toBe('supported');
		browser(async () => ({ 'extension:prf': false }));
		expect(await detectPrfSupport()).toBe('unsupported');
		browser(async () => ({}));
		expect(await detectPrfSupport()).toBe('unknown');
		browser(async () => { throw new Error('nope'); });
		expect(await detectPrfSupport()).toBe('unknown');
		browser(undefined);
		expect(await detectPrfSupport()).toBe('unknown');
	});

	it('is unsupported without WebAuthn at all', async () => {
		vi.stubGlobal('navigator', {});
		expect(await detectPrfSupport()).toBe('unsupported');
	});
});

describe('recovering with the passkey', () => {
	it('opens the envelope with a discoverable assertion and prepares a new lock for the same passkey', async () => {
		const { auth, lock } = await enabled();
		const before = auth.calls.length;
		const { backup: restored, prepared } = await recover(auth);
		expect(restored.identity.user_hash).toBe(backup.identity.user_hash);
		expect(prepared.lock.credentialId).toBe(lock.credentialId);
		expect(prepared.lock.salt).not.toBe(lock.salt);
		expect(prepared.seed).toEqual(await readLockSeed(auth.credentials, prepared.lock));
		expect(auth.calls.slice(before)).toEqual(['get', 'get']);
	});

	it('asks a second time, bound to the passkey, when the authenticator ignores the second salt', async () => {
		const auth = prfAuthenticator('at-create', { second: false });
		const { lock } = await enabled(auth);
		const before = auth.calls.length;
		const { prepared } = await recover(auth);
		expect(auth.calls.slice(before)).toEqual(['get', 'get']);
		expect(prepared.lock.credentialId).toBe(lock.credentialId);
		expect(prepared.seed).toEqual(await readLockSeed(auth.credentials, prepared.lock));
	});

	it('skips a foreign row at the same address', async () => {
		const { auth, entry } = await enabled();
		rows.unshift({ user_hash: 'u_' + 'f'.repeat(128), uuid: entry.locator, value_b64: await sealVault('{}', new Uint8Array(32).fill(5)), deleted_flag: false });
		const { backup: restored } = await recover(auth);
		expect(restored.identity.user_hash).toBe(backup.identity.user_hash);
	});

	it('cannot turn recovery on when the selected passkey returns no PRF extension result', async () => {
		const auth = prfAuthenticator('at-create');
		const { record } = await createPrfPasskey(auth.credentials, who);
		const get = auth.credentials.get;
		let assertions = 0;
		auth.credentials.get = async (options) => {
			assertions++;
			const credential = await get(options);
			expect(toBase64(new Uint8Array(credential.rawId))).toBe(record.credentialId);
			return { ...credential, getClientExtensionResults: () => ({}) } as PublicKeyCredential;
		};
		expect(await reasonOf(enablePasskeyRecovery({
			credentials: auth.credentials, lock: record, label: 'Laptop', exportBackup: async () => backup, ...deps(),
		}))).toBe('no-prf');
		expect(assertions).toBe(1);
		expect(reads).toBe(0);
		expect(slot).toEqual({});
		expect(rows).toEqual([]);
	});

	it('tells absent from foreign, and never reports a failed read as absent', async () => {
		const auth = prfAuthenticator('at-create');
		await createPrfPasskey(auth.credentials, who);
		expect(await reasonOf(recover(auth))).toBe('absent');

		const prf = await auth.credentials.get({ publicKey: { challenge: new Uint8Array(32), userVerification: 'required', extensions: { prf: { eval: { first: recoverySalt() } } } } }) as PublicKeyCredential;
		const locator = deriveVaultLocator(recoveryWrapKey(new Uint8Array(prf.getClientExtensionResults().prf!.results!.first as ArrayBuffer)));
		rows.push({ user_hash: 'u_x', uuid: locator, value_b64: await sealVault('{}', new Uint8Array(32).fill(5)), deleted_flag: false });
		expect(await reasonOf(recover(auth))).toBe('foreign');

		for (const [failure, reason] of [[401, 'unauthorized'], [500, 'server'], ['network', 'network'], ['timeout', 'network']] as const) {
			answer = failure;
			expect(await reasonOf(recover(auth))).toBe(reason);
		}
	});

	it('a dismissed prompt and a passkey without PRF read nothing from the server', async () => {
		const auth = prfAuthenticator('at-create');
		await createPrfPasskey(auth.credentials, who);
		auth.refuseNext();
		expect(await reasonOf(recover(auth))).toBe('cancelled');
		const none = prfAuthenticator('none');
		await createPrfPasskey(none.credentials, who).catch(() => {});
		expect(await reasonOf(recover(none))).toBe('no-prf');
		expect(reads).toBe(0);
	});

	it('refuses an envelope whose account does not match its keys', async () => {
		backup = { ...backup, identity: { ...backup.identity, user_hash: 'u_' + 'ab'.repeat(64) } };
		const auth = prfAuthenticator('at-create');
		const { record } = await createPrfPasskey(auth.credentials, who);
		const answerPrf = await auth.credentials.get({ publicKey: { challenge: new Uint8Array(32), userVerification: 'required', allowCredentials: [{ type: 'public-key', id: Uint8Array.from(atob(record.credentialId), (c) => c.charCodeAt(0)) }], extensions: { prf: { eval: { first: recoverySalt() } } } } }) as PublicKeyCredential;
		await deps().publish(recoveryWrapKey(new Uint8Array(answerPrf.getClientExtensionResults().prf!.results!.first as ArrayBuffer)), JSON.stringify(backup));
		expect(await reasonOf(recover(auth))).toBe('invalid');
	});
});

describe('recovering where the browser takes one PRF salt per assertion', () => {
	type Auth = ReturnType<typeof prfAuthenticator>;
	type Request = { salts: number; boundTo: string | null };

	const oneSaltBrowser = (auth: Auth, refusal: () => unknown, onBound?: (options: NonNullable<Parameters<Auth['credentials']['get']>[0]>) => Promise<PublicKeyCredential>) => {
		const get = auth.credentials.get;
		const requests: Request[] = [];
		auth.credentials.get = async (options) => {
			const pk = options!.publicKey!;
			const allowed = pk.allowCredentials?.[0];
			const twoSalts = Boolean(pk.extensions!.prf!.eval!.second);
			requests.push({ salts: twoSalts ? 2 : 1, boundTo: allowed ? toBase64(new Uint8Array(allowed.id as Uint8Array)) : null });
			if (twoSalts) throw refusal();
			return allowed && onBound ? onBound(options!) : get(options);
		};
		return requests;
	};

	const watchedFetch = () => {
		const keys: Uint8Array[] = [];
		return { keys, fetchVault: (key: Uint8Array) => { keys.push(key); return fetchVault(key); } };
	};
	const allZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);

	it.each([
		['NotSupportedError', () => new DOMException('two salts', 'NotSupportedError')],
		['TypeError', () => new TypeError('two salts')],
	])('a %s on the two-salt request: recovers with the recovery salt alone, then asks the same passkey for the lock', async (_, refusal) => {
		const { auth, lock } = await enabled();
		const requests = oneSaltBrowser(auth, refusal);
		const fetch = watchedFetch();
		const { backup: restored, prepared } = await recoverWithPasskey({ credentials: auth.credentials, rpId: 'localhost', fetchVault: fetch.fetchVault });
		expect(requests).toEqual([
			{ salts: 2, boundTo: null },
			{ salts: 1, boundTo: null },
			{ salts: 1, boundTo: lock.credentialId },
		]);
		expect(restored.identity.user_hash).toBe(backup.identity.user_hash);
		expect(prepared.lock.credentialId).toBe(lock.credentialId);
		expect(prepared.lock.salt).not.toBe(lock.salt);
		expect(prepared.seed).toEqual(await readLockSeed(auth.credentials, prepared.lock));
		expect(auth.calls.filter((c) => c === 'create')).toHaveLength(1);
		expect(fetch.keys).toHaveLength(1);
		expect(allZero(fetch.keys[0])).toBe(true);
	});

	it('a two-salt assertion that silently omits PRF retries with one salt for the same passkey', async () => {
		const { auth, lock } = await enabled();
		const get = auth.credentials.get;
		const requests: Request[] = [];
		auth.credentials.get = async (options) => {
			const pk = options!.publicKey!;
			const allowed = pk.allowCredentials?.[0];
			const twoSalts = Boolean(pk.extensions!.prf!.eval!.second);
			requests.push({ salts: twoSalts ? 2 : 1, boundTo: allowed ? toBase64(new Uint8Array(allowed.id as Uint8Array)) : null });
			const answer = await get(options);
			return twoSalts ? { ...answer, getClientExtensionResults: () => ({ prf: {} }) } as PublicKeyCredential : answer;
		};
		const { backup: restored, prepared } = await recover(auth);
		expect(restored.identity.user_hash).toBe(backup.identity.user_hash);
		expect(prepared.lock.credentialId).toBe(lock.credentialId);
		expect(requests).toEqual([
			{ salts: 2, boundTo: null },
			{ salts: 1, boundTo: lock.credentialId },
			{ salts: 1, boundTo: lock.credentialId },
		]);
	});

	it('the same saved passkey cannot restore when its provider omits PRF on both requests', async () => {
		const { auth, lock } = await enabled();
		const originalRows = structuredClone(rows);
		const originalSlot = structuredClone(slot);
		const get = auth.credentials.get;
		const requests: Request[] = [];
		auth.credentials.get = async (options) => {
			const pk = options!.publicKey!;
			const allowed = pk.allowCredentials?.[0];
			requests.push({
				salts: pk.extensions!.prf!.eval!.second ? 2 : 1,
				boundTo: allowed ? toBase64(new Uint8Array(allowed.id as Uint8Array)) : null,
			});
			const credential = await get(options);
			expect(toBase64(new Uint8Array(credential.rawId))).toBe(lock.credentialId);
			return { ...credential, getClientExtensionResults: () => ({}) } as PublicKeyCredential;
		};
		reads = 0;
		expect(await reasonOf(recover(auth))).toBe('no-prf');
		expect(requests).toEqual([
			{ salts: 2, boundTo: null },
			{ salts: 1, boundTo: lock.credentialId },
		]);
		expect(reads).toBe(0);
		expect(rows).toEqual(originalRows);
		expect(slot).toEqual(originalSlot);
		expect(auth.calls.filter((call) => call === 'create')).toHaveLength(1);
	});

	it('does not retry when the first assertion returned no credential', async () => {
		const { auth } = await enabled();
		let requests = 0;
		auth.credentials.get = async () => { requests++; return null as unknown as PublicKeyCredential; };
		reads = 0;
		expect(await reasonOf(recover(auth))).toBe('no-prf');
		expect(requests).toBe(1);
		expect(reads).toBe(0);
	});

	it('rejects a different credential on the one-salt retry after the first result omitted PRF', async () => {
		const { auth, lock } = await enabled();
		const { record: other } = await createPrfPasskey(auth.credentials, { ...who, vaultId: 'vault2' });
		auth.choose(lock.credentialId);
		const get = auth.credentials.get;
		let requests = 0;
		auth.credentials.get = async (options) => {
			requests++;
			if (requests === 1) {
				const answer = await get(options);
				return { ...answer, getClientExtensionResults: () => ({ prf: {} }) } as PublicKeyCredential;
			}
			auth.choose(other.credentialId);
			return get({ publicKey: { ...options!.publicKey!, allowCredentials: [] } });
		};
		reads = 0;
		expect(await reasonOf(recover(auth))).toBe('wrong-passkey');
		expect(requests).toBe(2);
		expect(reads).toBe(0);
	});

	it('binds the lock\'s assertion to the passkey that opened the envelope, not to whichever one the person would pick next', async () => {
		const { auth, lock } = await enabled();
		const { record: other } = await createPrfPasskey(auth.credentials, { ...who, vaultId: 'vault2' });
		auth.choose(lock.credentialId);
		const get = auth.credentials.get;
		auth.credentials.get = async (options) => {
			const answer = await get(options);
			auth.choose(other.credentialId);
			return answer;
		};
		const requests = oneSaltBrowser(auth, () => new DOMException('two salts', 'NotSupportedError'));
		const { prepared } = await recover(auth);
		expect(requests.at(-1)).toEqual({ salts: 1, boundTo: lock.credentialId });
		expect(prepared.lock.credentialId).toBe(lock.credentialId);
		expect(prepared.seed).toEqual(await readLockSeed(auth.credentials, prepared.lock));
	});

	it('refuses another passkey answering the bound assertion, with the wrap key wiped', async () => {
		const { auth, lock } = await enabled();
		const { record: other } = await createPrfPasskey(auth.credentials, { ...who, vaultId: 'vault2' });
		const get = auth.credentials.get;
		oneSaltBrowser(auth, () => new DOMException('two salts', 'NotSupportedError'), async (options) => {
			auth.choose(other.credentialId);
			return get({ publicKey: { ...options.publicKey!, allowCredentials: [] } });
		});
		auth.choose(lock.credentialId);
		const fetch = watchedFetch();
		const result = recoverWithPasskey({ credentials: auth.credentials, rpId: 'localhost', fetchVault: fetch.fetchVault });
		expect(await reasonOf(result)).toBe('wrong-passkey');
		expect(allZero(fetch.keys[0])).toBe(true);
	});

	it('does not ask again after a dismissed prompt, on the two-salt request or the lock\'s', async () => {
		const { auth } = await enabled();
		reads = 0;
		const cancelled = oneSaltBrowser(auth, () => new DOMException('cancelled', 'NotAllowedError'));
		expect(await reasonOf(recover(auth))).toBe('cancelled');
		expect(cancelled).toEqual([{ salts: 2, boundTo: null }]);
		expect(reads).toBe(0);

		const { auth: second } = await enabled();
		const requests = oneSaltBrowser(second, () => new DOMException('two salts', 'NotSupportedError'), async () => {
			throw new DOMException('cancelled', 'NotAllowedError');
		});
		const fetch = watchedFetch();
		const result = recoverWithPasskey({ credentials: second.credentials, rpId: 'localhost', fetchVault: fetch.fetchVault });
		expect(await reasonOf(result)).toBe('cancelled');
		expect(requests).toHaveLength(3);
		expect(allZero(fetch.keys[0])).toBe(true);
	});

	it('reports a refused passkey request as the passkey\'s failure, and a failed read as the server\'s', async () => {
		const { auth } = await enabled();
		reads = 0;
		const get = auth.credentials.get;
		auth.credentials.get = async () => { throw new TypeError('no PRF here'); };
		expect(await reasonOf(recover(auth))).toBe('no-prf');
		for (const failure of [new DOMException('rp', 'SecurityError'), new DOMException('slow', 'TimeoutError')]) {
			auth.credentials.get = async () => { throw failure; };
			expect(await reasonOf(recover(auth))).toBe('passkey-failed');
		}
		expect(reads).toBe(0);

		auth.credentials.get = get;
		oneSaltBrowser(auth, () => new DOMException('two salts', 'NotSupportedError'));
		for (const [failure, reason] of [['network', 'network'], ['timeout', 'network'], [500, 'server']] as const) {
			answer = failure;
			expect(await reasonOf(recover(auth))).toBe(reason);
		}
		answer = 'ok';
		rows = [];
		expect(await reasonOf(recover(auth))).toBe('absent');
	});
});

describe('withdrawing an envelope', () => {
	it('tombstones it, then drops the slot entry; the passkey then finds nothing', async () => {
		const { auth, key, entry } = await enabled();
		await retirePasskeyRecovery({ key, locator: entry.locator }, deps());
		expect(rows).toEqual([expect.objectContaining({ uuid: entry.locator, deleted_flag: true, value_b64: '' })]);
		expect(slot).toEqual({});
		expect(await reasonOf(recover(auth))).toBe('absent');
	});

	it('keeps the slot entry when the tombstone is not accepted', async () => {
		const { key, entry } = await enabled();
		await expect(retirePasskeyRecovery({ key, locator: entry.locator }, { ...deps(), tombstone: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
		expect(slot[key]).toEqual(entry);
	});
});

import { describe, it, expect } from 'vitest';
import {
	createPrfPasskey, readLockSeed, lockSeedFromPrf, PrfUnsupportedError, PrfMissingError, PasskeyMismatchError, VAULT_LOCK_VERSION,
	assertPrf, lockRecordFor, lockSaltOf, backupFlagsOf,
} from '@/lib/pq/vaultLock';
import { prfAuthenticator } from './helpers/prfAuthenticator';

const who = { rpId: 'localhost', vaultId: 'vault1', name: 'Alice' };

describe('vault lock from WebAuthn PRF', () => {
	it('create and a later get give the same seed, with one prompt each', async () => {
		const auth = prfAuthenticator('at-create');
		const { record, seed } = await createPrfPasskey(auth.credentials, who);
		expect(record).toMatchObject({ v: VAULT_LOCK_VERSION, rpId: 'localhost', transports: ['internal'] });
		expect(seed).toHaveLength(32);
		expect(await readLockSeed(auth.credentials, record)).toEqual(seed);
		expect(auth.calls).toEqual(['create', 'get']);
	});

	it('puts the vault ID in user.id and nothing derived from the seed', async () => {
		let userId: Uint8Array | null = null;
		const auth = prfAuthenticator('at-create');
		const create = auth.credentials.create;
		auth.credentials.create = async (options) => {
			userId = new Uint8Array(options!.publicKey!.user.id as ArrayBuffer);
			return create(options);
		};
		await createPrfPasskey(auth.credentials, who);
		expect(new TextDecoder().decode(userId!)).toBe('vault1');
	});

	it('each passkey gets its own salt, so two vaults never share a seed', async () => {
		const auth = prfAuthenticator('at-create');
		const a = await createPrfPasskey(auth.credentials, who);
		const b = await createPrfPasskey(auth.credentials, { ...who, vaultId: 'vault2' });
		expect(a.record.salt).not.toBe(b.record.salt);
		expect(a.seed).not.toEqual(b.seed);
	});

	it('an authenticator that computes PRF only at get costs a second prompt, not a fallback', async () => {
		const auth = prfAuthenticator('at-get');
		const { record, seed } = await createPrfPasskey(auth.credentials, who);
		expect(auth.calls).toEqual(['create', 'get']);
		expect(await readLockSeed(auth.credentials, record)).toEqual(seed);
	});

	it.each([
		['none', 'authenticator'],
		['at-get-without-value', 'authenticator'],
		['browser-none', 'browser'],
	] as const)('no PRF value (%s) is PrfUnsupportedError naming the passkey made', async (support, reason) => {
		const auth = prfAuthenticator(support === 'at-get-without-value' ? 'none' : support);
		if (support === 'at-get-without-value') {
			const create = auth.credentials.create;
			auth.credentials.create = async (options) => {
				const credential = await create(options);
				return { ...credential, getClientExtensionResults: () => ({ prf: { enabled: true } }) } as unknown as PublicKeyCredential;
			};
		}
		const error = await createPrfPasskey(auth.credentials, who).catch((e) => e);
		expect(error).toBeInstanceOf(PrfUnsupportedError);
		expect(error.reason).toBe(reason);
		expect(error.credentialId).toMatch(/^[A-Za-z0-9+/]+=*$/);
	});

	it('a dismissed prompt is the browser error, never PrfUnsupportedError', async () => {
		const auth = prfAuthenticator('at-create');
		auth.refuseNext();
		const error = await createPrfPasskey(auth.credentials, who).catch((e) => e);
		expect(error.name).toBe('NotAllowedError');

		const { record } = await createPrfPasskey(auth.credentials, who);
		auth.refuseNext();
		expect((await readLockSeed(auth.credentials, record).catch((e) => e)).name).toBe('NotAllowedError');
	});

	it('a PRF vault whose passkey answers without a value is PrfMissingError', async () => {
		const withPrf = prfAuthenticator('at-create');
		const { record } = await createPrfPasskey(withPrf.credentials, who);
		const get = withPrf.credentials.get;
		withPrf.credentials.get = async (options) => {
			const credential = await get(options);
			return { ...credential, getClientExtensionResults: () => ({ prf: {} }) } as unknown as PublicKeyCredential;
		};
		await expect(readLockSeed(withPrf.credentials, record)).rejects.toBeInstanceOf(PrfMissingError);
	});

	it('asks only the vault\'s own passkey, with the stored salt', async () => {
		const auth = prfAuthenticator('at-create');
		const { record, seed } = await createPrfPasskey(auth.credentials, who);
		const otherSalt = { ...record, salt: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) };
		expect(await readLockSeed(auth.credentials, otherSalt)).not.toEqual(seed);
		const unknown = { ...record, credentialId: btoa('not-a-credential') };
		expect((await readLockSeed(auth.credentials, unknown).catch((e) => e)).name).toBe('NotAllowedError');
	});

	it('refuses a PRF value that is not 32 bytes', () => {
		expect(() => lockSeedFromPrf(new Uint8Array(16))).toThrow(PrfMissingError);
	});

	it('wipes the PRF value once the seed is derived', async () => {
		let returned: ArrayBuffer | null = null;
		const auth = prfAuthenticator('at-create');
		const create = auth.credentials.create;
		auth.credentials.create = async (options) => {
			const credential = await create(options);
			returned = (credential.getClientExtensionResults().prf!.results!.first as ArrayBuffer);
			return credential;
		};
		await createPrfPasskey(auth.credentials, who);
		expect(new Uint8Array(returned!).every((b) => b === 0)).toBe(true);
	});

	it('a lock for an existing passkey has a fresh salt and needs no new passkey', async () => {
		const auth = prfAuthenticator('at-create');
		const { record, seed } = await createPrfPasskey(auth.credentials, who);
		const again = lockRecordFor({ credentialId: record.credentialId, rpId: 'localhost' });
		expect(again).toMatchObject({ v: VAULT_LOCK_VERSION, credentialId: record.credentialId, transports: [] });
		expect(again.salt).not.toBe(record.salt);
		expect(await readLockSeed(auth.credentials, again)).not.toEqual(seed);
		expect(auth.calls).toEqual(['create', 'get']);
	});

	it('a discoverable assertion answers with the passkey picked, both salts in one prompt', async () => {
		const auth = prfAuthenticator('at-create');
		const a = await createPrfPasskey(auth.credentials, who);
		await createPrfPasskey(auth.credentials, { ...who, vaultId: 'vault2' });
		auth.choose(a.record.credentialId);
		const answer = await assertPrf(auth.credentials, {
			rpId: 'localhost', first: new Uint8Array(32).fill(1), second: lockSaltOf(a.record),
		});
		expect(answer.credentialId).toBe(a.record.credentialId);
		expect(answer.first).toHaveLength(32);
		expect(lockSeedFromPrf(answer.second!)).toEqual(a.seed);
		expect(auth.calls).toEqual(['create', 'create', 'get']);
	});

	it('an authenticator that ignores the second salt gives only the first', async () => {
		const auth = prfAuthenticator('at-create', { second: false });
		await createPrfPasskey(auth.credentials, who);
		const answer = await assertPrf(auth.credentials, { rpId: 'localhost', first: new Uint8Array(32), second: new Uint8Array(32).fill(2) });
		expect(answer.second).toBeNull();
	});

	it('refuses an answer from another passkey than the one asked for', async () => {
		const auth = prfAuthenticator('at-create');
		const { record } = await createPrfPasskey(auth.credentials, who);
		const get = auth.credentials.get;
		const other = btoa(String.fromCharCode(...new Uint8Array(16).fill(9)));
		auth.credentials.get = async (options) => {
			const credential = await get(options);
			return { ...credential, rawId: Uint8Array.from(atob(other), (c) => c.charCodeAt(0)).buffer, getClientExtensionResults: credential.getClientExtensionResults } as unknown as PublicKeyCredential;
		};
		await expect(readLockSeed(auth.credentials, record)).rejects.toBeInstanceOf(PasskeyMismatchError);
	});

	it('reads the backup flags from the authenticator data', async () => {
		for (const [backupEligible, backupState] of [[true, true], [true, false], [false, false]]) {
			const auth = prfAuthenticator('at-create', { backupEligible, backupState });
			const { record } = await createPrfPasskey(auth.credentials, who);
			const answer = await assertPrf(auth.credentials, { rpId: 'localhost', credentialId: record.credentialId, first: new Uint8Array(32) });
			expect(answer.flags).toEqual({ backupEligible, backupState });
		}
		expect(backupFlagsOf(new Uint8Array(10).buffer)).toBeNull();
	});
});

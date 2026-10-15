import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const credentialID = 'bitwarden-credential';
const publicKey = { algoCOSE: -7, raw: 'raw-key', spki: 'spki-key' };
const { auth } = vi.hoisted(() => ({
	auth: vi.fn(async () => ({
		response: { credentialID: 'bitwarden-credential', userID: new Uint8Array(34) },
	})),
}));

vi.mock('../node_modules/@lo-fi/local-data-lock/node_modules/@lo-fi/webauthn-local-client/dist/bundlers/walc.mjs', () => ({
	supportsWebAuthn: true,
	regDefaults: () => ({}),
	register: async () => null,
	auth,
	authDefaults: () => ({}),
	verifyAuthResponse: async () => true,
	packPublicKeyJSON: (key: unknown) => key,
	unpackPublicKeyJSON: (key: unknown) => key,
	toBase64String: () => 'entry-hash',
	fromBase64String: () => new Uint8Array(),
	toUTF8String: () => '',
	fromUTF8String: () => new Uint8Array(),
	resetAbortReason: () => {},
}));

const disk = new Map<string, unknown>();
const storage = {
	storageType: 'test',
	async has(key: string) { return disk.has(key); },
	async get(key: string) { return disk.get(key) ?? null; },
	async set(key: string, value: unknown) { disk.set(key, value); },
	async remove(key: string) { disk.delete(key); },
	async keys() { return [...disk.keys()]; },
	async entries() { return [...disk.entries()]; },
};

let lock: {
	configure: (options: { accountStorage: typeof storage; cacheLifetime: number }) => void;
	getLockKey: (options: { relyingPartyID: string }) => Promise<{ localIdentity: string }>;
};

beforeAll(async () => {
	vi.stubGlobal('sodium', {
		crypto_sign_SEEDBYTES: 32,
		randombytes_buf: (size: number) => new Uint8Array(size),
		crypto_hash: () => new Uint8Array(32),
		crypto_sign_seed_keypair: () => ({ publicKey: new Uint8Array(32), privateKey: new Uint8Array(64) }),
		crypto_sign_ed25519_pk_to_curve25519: () => new Uint8Array(32),
		crypto_sign_ed25519_sk_to_curve25519: () => new Uint8Array(32),
	});
	const sourcePath = '../node_modules/@lo-fi/local-data-lock/src/ldl.js';
	lock = await import(sourcePath);
});

beforeEach(() => {
	disk.clear();
	auth.mockClear();
	lock.configure({ accountStorage: storage, cacheLifetime: 0 });
});

describe('Bitwarden passkey and the local-data-lock identity registry', () => {
	it('reproduces the production error when Bitwarden returns a passkey absent from local-identities', async () => {
		await storage.set('pq-vaults-registry', [{ user_hash: 'selected-account', vaultId: 'vault-1' }]);
		await expect(lock.getLockKey({ relyingPartyID: 'buckitup.xyz' })).rejects.toThrow(
			'Auth verification requested but skipped, against unrecognized passkey (no matching local-identity)',
		);
		expect(auth).toHaveBeenCalledOnce();
	});

	it('also rejects a present identity entry whose integrity hash is invalid', async () => {
		await storage.set('local-identities', {
			'known-identity': {
				lastSeq: 1,
				passkeys: [{ credentialID, seq: 1, publicKey, hash: 'corrupt-hash' }],
			},
		});

		await expect(lock.getLockKey({ relyingPartyID: 'buckitup.xyz' })).rejects.toThrow(
			'Auth verification requested but skipped, against unrecognized passkey (no matching local-identity)',
		);
	});

	it('accepts the same passkey when its credential ID has a valid local identity entry', async () => {
		await storage.set('local-identities', {
			'known-identity': {
				lastSeq: 1,
				passkeys: [{ credentialID, seq: 1, publicKey, hash: 'entry-hash' }],
			},
		});

		await expect(lock.getLockKey({ relyingPartyID: 'buckitup.xyz' })).resolves.toMatchObject({ localIdentity: 'known-identity' });
		expect(auth).toHaveBeenCalledOnce();
	});
});

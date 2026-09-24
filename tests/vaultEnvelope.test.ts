// The recovery payload: a wrap key, the vault sealed under it, and an address
// a client with no account can compute. Every negative case must throw rather
// than return something empty-looking — a recovery that silently yields an
// empty vault is worse than one that fails.
import { describe, it, expect } from 'vitest';
import {
	newWrapKey, deriveVaultLocator, sealVault, openVault, VaultEnvelopeError,
} from '@/lib/pq/vaultEnvelope';

const VAULT = JSON.stringify({ sign_skey: 'a'.repeat(64), crypt_skey: 'b'.repeat(64), evm_skey: 'c' });

describe('the wrap key and the address it implies', () => {
	it('gives every secret its own address', () => {
		expect(deriveVaultLocator(newWrapKey())).not.toBe(deriveVaultLocator(newWrapKey()));
	});

	it('gives one secret the same address every time — that is how a new device finds it', () => {
		const s = newWrapKey();
		expect(deriveVaultLocator(s)).toBe(deriveVaultLocator(s));
	});

	// CLAUDE.md, §Review: a root derivation in src/lib/pq is pinned byte for
	// byte, because changing a salt keeps every behavioural test green while
	// making every vault already written at the old address unfindable. This
	// literal is the tripwire that forces a conscious version bump.
	it('derives one fixed address for one fixed key', () => {
		expect(deriveVaultLocator(new Uint8Array(32).fill(7)))
			.toBe('2343fce9-653e-815e-a4b2-ab5fb58ee552');
	});

	it('produces a uuid the server column will accept (v8, RFC 4122 variant)', () => {
		const locator = deriveVaultLocator(newWrapKey());
		expect(locator).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it('refuses a key of the wrong size instead of deriving a shared address', () => {
		expect(() => deriveVaultLocator(new Uint8Array(16))).toThrow(VaultEnvelopeError);
	});
});

describe('sealing the vault', () => {
	it('round-trips under the same key', async () => {
		const s = newWrapKey();
		expect(await openVault(await sealVault(VAULT, s), s)).toBe(VAULT);
	});

	it('is noise to a different key', async () => {
		const sealed = await sealVault(VAULT, newWrapKey());
		await expect(openVault(sealed, newWrapKey())).rejects.toThrow(VaultEnvelopeError);
	});

	it('detects a tampered row rather than returning half a vault', async () => {
		const s = newWrapKey();
		const sealed = await sealVault(VAULT, s);
		const bytes = Buffer.from(sealed, 'base64');
		bytes[bytes.length - 1] ^= 0xff;
		await expect(openVault(bytes.toString('base64'), s)).rejects.toThrow(VaultEnvelopeError);
	});

	it('never repeats a ciphertext for the same input', async () => {
		const s = newWrapKey();
		expect(await sealVault(VAULT, s)).not.toBe(await sealVault(VAULT, s));
	});

	it('rejects something that is not a sealed vault', async () => {
		await expect(openVault(Buffer.from('hello').toString('base64'), newWrapKey()))
			.rejects.toThrow(VaultEnvelopeError);
	});
});

describe('what openVault blames when it fails', () => {
	// A row at this address may belong to somebody else — the locator is public
	// from the moment a share is handed out — so "your secret is wrong" has to
	// be reserved for the case where the secret really is wrong.
	it('reads a row that arrived as PostgreSQL hex, not only as base64', async () => {
		const s = newWrapKey();
		const sealed = await sealVault(VAULT, s);
		const hex = '\\x' + Buffer.from(sealed, 'base64').toString('hex');
		expect(await openVault(hex, s)).toBe(VAULT);
	});

	it('calls an unreadable value unreadable rather than a wrong key', async () => {
		await expect(openVault('not base64 at all !!!', newWrapKey()))
			.rejects.toThrow(/unreadable value/);
	});

	it('calls a truncated row structural rather than a wrong key', async () => {
		// Shorter than version + nonce + tag can possibly be.
		const stub = Buffer.from([1, 2, 3, 4, 5]).toString('base64');
		await expect(openVault(stub, newWrapKey())).rejects.toThrow(/not a sealed vault$/);
	});
});

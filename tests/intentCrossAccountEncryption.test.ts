import { describe, it, expect, vi, beforeEach } from 'vitest';

const A = 'u_' + 'a'.repeat(128);
const B = 'u_' + 'b'.repeat(128);

let currentUserHash: string | null = A;
let deferExportVaultKeys = false;
let releaseExportVaultKeys: (() => void) | null = null;
let exportVaultKeysCallCount = 0;

const keyMaterialFor = (userHash: string) => (userHash === A ? '11'.repeat(16) : '22'.repeat(16));

vi.mock('@/libs/EncryptionManagerPQ', () => ({
	EncryptionManagerPQ: {
		getInstance: () => ({
			get currentUserHash() { return currentUserHash; },
			exportVaultKeys: async () => {
				exportVaultKeysCallCount++;
				if (deferExportVaultKeys) {
					await new Promise<void>((resolve) => { releaseExportVaultKeys = resolve; });
				}
				return { crypt_skey: btoa(keyMaterialFor(currentUserHash!)), sign_skey: 'AAAA', evm_skey: 'cc' };
			},
		}),
	},
}));

const { enqueueIntent, getIntent, intentsOf, _setRawIntentStorageForTests } = await import('@/lib/data/intents');
const { clearLocalStorageKey } = await import('@/lib/data/localCrypto');

const makeStorage = () => {
	const map = new Map<string, string>();
	return {
		map,
		async get(k: string) { return map.get(k) ?? null; },
		async set(k: string, v: string) { map.set(k, v); },
		async delete(k: string) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

let raw: ReturnType<typeof makeStorage>;

beforeEach(() => {
	currentUserHash = A;
	deferExportVaultKeys = false;
	releaseExportVaultKeys = null;
	exportVaultKeysCallCount = 0;
	clearLocalStorageKey();
	raw = makeStorage();
	_setRawIntentStorageForTests(raw);
});

describe('enqueueIntent: pinned encryption survives an account switch mid-write (§1)', () => {
	it('a switch during the write\'s own key derivation refuses the write — nothing durable, no cross-account ciphertext', async () => {
		deferExportVaultKeys = true;
		const call = enqueueIntent({ text: 'hello' }, A, 'dialog_messages');

		await vi.waitFor(() => expect(exportVaultKeysCallCount).toBe(1));
		currentUserHash = B; // switch happens WHILE the write is still in flight
		releaseExportVaultKeys?.();

		const id = await call;
		expect(id).toBeNull(); // enqueueIntent catches and reports failure, never partial success
		expect(raw.map.size).toBe(0); // nothing was ever written under either account
	});

	it('a switch strictly between two writes refuses the second one immediately — cache hit does not bypass the check', async () => {
		const firstId = await enqueueIntent({ text: 'first, under A' }, A, 'dialog_messages');
		expect(firstId).not.toBeNull(); // A's key is now cached

		currentUserHash = B; // switch happens between the two captures, not mid-write
		const secondId = await enqueueIntent({ text: 'second, claims to be A but ambient is B' }, A, 'dialog_messages');

		expect(secondId).toBeNull();
		expect(raw.map.size).toBe(1); // only the first (genuinely-under-A) write exists
	});

	it('A can read its own durable intent back after a logout/relogin (key re-derived, same result)', async () => {
		const id = await enqueueIntent({ text: 'mine' }, A, 'dialog_messages');
		expect(id).not.toBeNull();

		currentUserHash = null; // logout
		clearLocalStorageKey();
		currentUserHash = A; // relogin as the SAME account

		const reloaded = await getIntent(id!);
		expect(reloaded?.intent).toEqual({ text: 'mine' });
	});

	it('B can never read or recover an intent A durably wrote, even in the same physical storage', async () => {
		const id = await enqueueIntent({ text: 'A\'s secret' }, A, 'dialog_messages');
		expect(id).not.toBeNull();

		currentUserHash = B;
		clearLocalStorageKey();

		await expect(getIntent(id!)).rejects.toThrow();
		expect((await intentsOf(B)).entries).toEqual([]);
	});
});

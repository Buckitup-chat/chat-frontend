import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setIntentStorageForTests } from '@/lib/data/intents';
import { _setStorageForTests as setOutboxStorage } from '@/lib/data/outbox';
import { prfAuthenticator } from './helpers/prfAuthenticator';

let cardRows;
let serverRows;
let auth;
const lofiCalls = [];

vi.mock('@/lib/data/collections', () => ({
	resetUserStorageCollection: () => {},
	getUserCardsCollection: () => ({
		async preload() {},
		get: (k) => cardRows.get(k),
		get toArray() { return [...cardRows.values()]; },
	}),
}));
vi.mock('@/lib/data/ingest', async () => {
	const actual = await vi.importActual('@/lib/data/ingest');
	return {
		...actual,
		sendMutationsAndAwaitShape: async (mutations) => {
			for (const m of mutations) {
				const row = m.modified ?? m.changes;
				if (m.syncMetadata?.relation === 'user_cards') cardRows.set(row.user_hash, { ...cardRows.get(row.user_hash), ...row });
			}
			return { outboxId: 'test-outbox-id', phase: 'accepted', result: { txids: [] }, acceptance: Promise.resolve({ kind: 'accepted' }) };
		},
		drainPendingWrites: async () => {},
		stopDrainLoop: () => {},
	};
});
vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	putStorageRow: async ({ userHash, uuid, valueB64, deletedFlag = false }) => {
		serverRows = serverRows.filter((r) => !(r.user_hash === userHash && r.uuid === uuid));
		serverRows.push({ user_hash: userHash, uuid, value_b64: valueB64, deleted_flag: deletedFlag });
		return {};
	},
	getPublicStorageRowsByUuid: async (uuid) => serverRows.filter((r) => r.uuid === uuid && !r.deleted_flag),
	putStorageJsonPatch: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	saveStorageJsonPatch: async () => 'synced',
}));
vi.mock('@/lib/data/deviceOwner', () => ({ claimDeviceIfUnowned: async () => ({ claim: 'unavailable' }) }));
const openedHandles = [];
let legacyVault = null;
let forgetLegacy = async () => {};
const forgotten = [];
vi.mock('@/libs/accountVault', async () => {
	const actual = await vi.importActual('@/libs/accountVault');
	return {
		...actual,
		createPrfVault: async (...args) => {
			const made = await actual.createPrfVault(...args);
			openedHandles.push(made.vault);
			return made;
		},
		openPrfVault: async (...args) => {
			const handle = await actual.openPrfVault(...args);
			openedHandles.push(handle);
			return handle;
		},
		openLegacyVault: (id) => (legacyVault ? legacyVault(id) : actual.openLegacyVault(id)),
		forgetLegacyLock: async (accountID) => {
			forgotten.push(accountID);
			await forgetLegacy(accountID);
		},
	};
});

const memoryStore = () => ({
	_map: new Map(),
	async get(k) { return this._map.get(k) ?? null; },
	async set(k, v) { this._map.set(k, v); },
	async delete(k) { this._map.delete(k); },
	async keys() { return [...this._map.keys()]; },
	async clear() { this._map.clear(); },
});

let EncryptionManagerPQ;
let vaultStorage;

beforeAll(async () => {
	await sodium.ready;
	globalThis.sodium = sodium;
	globalThis.location = { hostname: 'localhost', origin: 'http://localhost' };
	globalThis.PublicKeyCredential = {
		isConditionalMediationAvailable: async () => false,
		isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
	};
	const route = (ceremony) => async (options) => {
		if (options?.publicKey?.extensions?.prf) return auth.credentials[ceremony](options);
		lofiCalls.push(ceremony);
		throw new DOMException('lo-fi asked for a passkey', 'NotAllowedError');
	};
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { credentials: { create: route('create'), get: route('get') } },
	});
	({ EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ'));
	({ vaultStorage } = await import('@/libs/accountVault'));
});

beforeEach(async () => {
	vi.restoreAllMocks();
	await clearSiteData();
	cardRows = new Map();
	serverRows = [];
	auth = prfAuthenticator('at-create');
	lofiCalls.length = 0;
	openedHandles.length = 0;
	legacyVault = null;
	forgetLegacy = async () => {};
	forgotten.length = 0;
	_setIntentStorageForTests(memoryStore());
	setOutboxStorage(memoryStore());
	_setAcceptedSnapshotStorageForTests(memoryStore());
});

const freshManager = () => {
	EncryptionManagerPQ.instance = null;
	return EncryptionManagerPQ.getInstance();
};

const clearSiteData = async () => {
	const store = vaultStorage();
	for (const key of await store.keys()) await store.remove(key);
	_setIntentStorageForTests(memoryStore());
	setOutboxStorage(memoryStore());
	_setAcceptedSnapshotStorageForTests(memoryStore());
};

const newAccount = async (name = 'Alice') => {
	const em = freshManager();
	const card = await em.createUserVault({ name });
	const backup = { identity: { ...card }, keys: { ...(await em.exportVaultKeys()), meta_seed: await em.guardianMetaSeed() } };
	await em.logout();
	return { card, backup };
};

const ceremonies = () => auth.calls.join(',');

const lockedOut = (handle) => expect(handle.get('sign_skey')).rejects.toMatchObject({ name: 'VaultLockedError' });

const failStorage = (op, prefix) => {
	const store = vaultStorage();
	const real = store[op].bind(store);
	vi.spyOn(store, op).mockImplementation(async (key, ...rest) => {
		if (key.startsWith(prefix)) throw new DOMException('write failed', 'QuotaExceededError');
		return real(key, ...rest);
	});
};
const failWrites = (prefix) => failStorage('set', prefix);

const asLegacyAccount = async (card) => {
	const store = vaultStorage();
	const cards = await store.get('pq-vaults-registry');
	await store.set('pq-vaults-registry', cards.map((c) => (c.user_hash === card.user_hash ? { ...c, vaultLock: 'legacy' } : c)));
	await store.remove(`pq-vault-lock-${card.vaultId}`);
	const row = await store.get(`local-vault-${card.vaultId}`);
	await store.set(`local-vault-${card.vaultId}`, { ...row, accountID: `ldl-${card.vaultId}` });
};

const dropCardOnly = async (card) => {
	const store = vaultStorage();
	const cards = await store.get('pq-vaults-registry');
	await store.set('pq-vaults-registry', cards.filter((c) => c.user_hash !== card.user_hash));
};

const standInLegacyVault = async (id) => ({ id, clear: () => vaultStorage().remove(`local-vault-${id}`), lock: () => true });

const vaultRecordsOf = async (vaultId) => {
	const store = vaultStorage();
	const present = [];
	for (const key of [`local-vault-${vaultId}`, `pq-vault-lock-${vaultId}`, `pq-vault-owner-${vaultId}`]) {
		if ((await store.get(key)) != null) present.push(key.replace(`-${vaultId}`, ''));
	}
	return present;
};

describe('a PRF vault in the app', () => {
	it('is made with one passkey, and a sign-in opens it with one assertion', async () => {
		const { card } = await newAccount();
		expect(card.vaultLock).toBe('prf');
		expect(await vaultStorage().get(`pq-vault-lock-${card.vaultId}`)).toMatchObject({ credentialId: auth.credentialIds()[0] });

		const em = freshManager();
		await em.login(card.user_hash);
		expect(em.isAuth).toBe(true);
		expect(ceremonies()).toBe('create,get');
		expect(lofiCalls).toEqual([]);
	});

	it('a dismissed prompt at sign-in is the error: nothing falls back to lo-fi', async () => {
		const { card } = await newAccount();
		auth.refuseNext();
		const em = freshManager();
		await expect(em.login(card.user_hash)).rejects.toMatchObject({ name: 'NotAllowedError' });
		expect(em.isAuth).toBe(false);
		expect(lofiCalls).toEqual([]);
	});

	it('without its lock record it is reported missing, never opened as a legacy vault', async () => {
		const { card } = await newAccount();
		await vaultStorage().remove(`pq-vault-lock-${card.vaultId}`);
		await expect(freshManager().login(card.user_hash)).rejects.toMatchObject({ name: 'LocalVaultMissingError' });
		expect(ceremonies()).toBe('create');
		expect(lofiCalls).toEqual([]);
	});

	it('keeps its guardian seed across sign-ins', async () => {
		const { card, backup } = await newAccount();
		expect(backup.keys.meta_seed).toMatch(/^[0-9a-f]{64}$/);
		const em = freshManager();
		await em.login(card.user_hash);
		expect(await em.guardianMetaSeed()).toBe(backup.keys.meta_seed);
		expect(lofiCalls).toEqual([]);
	});

	it('is locked again when the sign-in it was opened for fails', async () => {
		const { card } = await newAccount();
		const { openPrfVault } = await vi.importActual('@/libs/accountVault');
		const vault = await openPrfVault(card.vaultId, await vaultStorage().get(`pq-vault-lock-${card.vaultId}`));
		await vault.set('sign_skey', 'not a key');
		vault.lock();

		await expect(freshManager().login(card.user_hash)).rejects.toThrow('Failed to load secret key from vault');
		await lockedOut(openedHandles.at(-1));
	});

	it('is locked again when its owner record cannot be written at sign-in', async () => {
		const { card } = await newAccount();
		await vaultStorage().remove(`pq-vault-owner-${card.vaultId}`);
		failWrites('pq-vault-owner-');
		const em = freshManager();
		await expect(em.login(card.user_hash)).rejects.toMatchObject({ name: 'QuotaExceededError' });
		expect(em.isAuth).toBe(false);
		await lockedOut(openedHandles.at(-1));
	});

	it('made at registration is locked when the account fails before its session', async () => {
		failWrites('pq-vault-owner-');
		const em = freshManager();
		await expect(em.createUserVault({ name: 'Alice' })).rejects.toMatchObject({ name: 'QuotaExceededError' });
		expect(em.isAuth).toBe(false);
		expect(openedHandles).toHaveLength(1);
		await lockedOut(openedHandles[0]);
	});

	it('is locked on logout', async () => {
		const { card } = await newAccount();
		const em = freshManager();
		await em.login(card.user_hash);
		await em.logout();
		await lockedOut(openedHandles.at(-1));
	});

	it('is deleted without a prompt, its row and lock record gone', async () => {
		const { card } = await newAccount();
		const em = freshManager();
		await em.deleteUserVault(card.user_hash);
		expect(await vaultStorage().get(`local-vault-${card.vaultId}`)).toBeFalsy();
		expect(await vaultStorage().get(`pq-vault-lock-${card.vaultId}`)).toBeFalsy();
		expect(await em.getLocalUserCards()).toEqual([]);
		expect(ceremonies()).toBe('create');
		expect(lofiCalls).toEqual([]);
	});

	it('without its lock record is deleted and destroyed without a prompt, never through lo-fi', async () => {
		const alice = await newAccount('Alice');
		const bob = await newAccount('Bob');
		for (const { card } of [alice, bob]) await vaultStorage().remove(`pq-vault-lock-${card.vaultId}`);
		const em = freshManager();
		await em.deleteUserVault(alice.card.user_hash);
		await em.destroyUserVault({ userHash: bob.card.user_hash });
		for (const { card } of [alice, bob]) {
			expect(await vaultStorage().get(`local-vault-${card.vaultId}`)).toBeFalsy();
			expect(await vaultStorage().get(`pq-vault-owner-${card.vaultId}`)).toBeFalsy();
		}
		expect(await em.getLocalUserCards()).toEqual([]);
		expect(ceremonies()).toBe('create,create');
		expect(lofiCalls).toEqual([]);
	});

	it('that does not clear keeps its card, and the caller gets the error', async () => {
		const { card } = await newAccount();
		const store = vaultStorage();
		const remove = store.remove.bind(store);
		vi.spyOn(store, 'remove').mockImplementation(async (key) => {
			if (key.startsWith('local-vault-')) throw new DOMException('write failed', 'QuotaExceededError');
			return remove(key);
		});
		const em = freshManager();
		await expect(em.deleteUserVault(card.user_hash)).rejects.toMatchObject({ name: 'QuotaExceededError' });
		expect((await em.getLocalUserCards()).map((c) => c.user_hash)).toEqual([card.user_hash]);
		expect(await store.get(`local-vault-${card.vaultId}`)).toBeTruthy();
	});

	it('is destroyed without a prompt, its row and lock record checked gone', async () => {
		const { card } = await newAccount();
		const em = freshManager();
		await em.destroyUserVault({ userHash: card.user_hash });
		expect(await vaultStorage().get(`local-vault-${card.vaultId}`)).toBeFalsy();
		expect(await vaultStorage().get(`pq-vault-lock-${card.vaultId}`)).toBeFalsy();
		expect(await em.getLocalUserCards()).toEqual([]);
		expect(ceremonies()).toBe('create');
		expect(lofiCalls).toEqual([]);
	});
});

describe('removing a legacy account', () => {
	it('whose vault is not cleared, because its passkey prompt was dismissed, keeps its card', async () => {
		const { card } = await newAccount();
		await asLegacyAccount(card);
		legacyVault = async () => { throw new DOMException('The passkey prompt was dismissed', 'NotAllowedError'); };
		const em = freshManager();
		await expect(em.deleteUserVault(card.user_hash)).rejects.toMatchObject({ name: 'NotAllowedError' });
		expect((await em.getLocalUserCards()).map((c) => c.user_hash)).toEqual([card.user_hash]);
		expect(await vaultStorage().get(`local-vault-${card.vaultId}`)).toBeTruthy();
	});

	it('beside a PRF session leaves that session, its vault and its guardian seed as they were', async () => {
		const alice = await newAccount('Alice');
		const bob = await newAccount('Bob');
		await asLegacyAccount(bob.card);
		legacyVault = standInLegacyVault;

		const em = freshManager();
		await em.login(alice.card.user_hash);
		const session = openedHandles.at(-1);
		await em.deleteUserVault(bob.card.user_hash);

		expect(em.isAuth).toBe(true);
		expect(em.currentUserHash).toBe(alice.card.user_hash);
		expect(await em.guardianMetaSeed()).toBe(alice.backup.keys.meta_seed);
		expect(await session.get('meta_seed')).toBe(alice.backup.keys.meta_seed);
		expect(await vaultStorage().get(`local-vault-${bob.card.vaultId}`)).toBeFalsy();
		expect((await em.getLocalUserCards()).map((c) => c.user_hash)).toEqual([alice.card.user_hash]);
	});
});

describe.each(['deleteUserVault', 'destroyUserVault'])('%s that fails part-way', (method) => {
	const removeAccount = (em, card) => (method === 'deleteUserVault'
		? em.deleteUserVault(card.user_hash)
		: em.destroyUserVault({ userHash: card.user_hash }));

	it.each([
		['removing the lock record', () => failStorage('remove', 'pq-vault-lock-'), ['pq-vault-lock', 'pq-vault-owner']],
		['removing the owner record', () => failStorage('remove', 'pq-vault-owner-'), ['pq-vault-owner']],
		['saving the card registry', () => failStorage('set', 'pq-vaults-registry'), []],
	])('at %s keeps the card on disk, opens nothing meanwhile, and a second run finishes', async (_, fail, left) => {
		const { card } = await newAccount();
		fail();
		await expect(removeAccount(freshManager(), card)).rejects.toMatchObject({ name: 'QuotaExceededError' });
		vi.restoreAllMocks();

		const restarted = freshManager();
		expect((await restarted.getLocalUserCards()).map((c) => c.user_hash)).toEqual([card.user_hash]);
		expect(await vaultRecordsOf(card.vaultId)).toEqual(left);
		await expect(restarted.login(card.user_hash)).rejects.toMatchObject({ name: 'LocalVaultMissingError' });

		await removeAccount(restarted, card);
		expect(await freshManager().getLocalUserCards()).toEqual([]);
		expect(await vaultRecordsOf(card.vaultId)).toEqual([]);
		expect(ceremonies()).toBe('create');
		expect(lofiCalls).toEqual([]);
	});
});

describe('destroying a vault found only by its ID', () => {
	it('with its lock record, as a recovery\'s temporary account leaves it, drops it as PRF', async () => {
		const { card } = await newAccount();
		await dropCardOnly(card);
		await freshManager().destroyUserVault({ userHash: card.user_hash, vaultId: card.vaultId });
		expect(await vaultRecordsOf(card.vaultId)).toEqual([]);
		expect(ceremonies()).toBe('create');
		expect(lofiCalls).toEqual([]);
	});

	it('without card or lock record removes the row as it is: no passkey flow is started on a guess', async () => {
		const { card } = await newAccount();
		await dropCardOnly(card);
		await vaultStorage().remove(`pq-vault-lock-${card.vaultId}`);
		await freshManager().destroyUserVault({ userHash: card.user_hash, vaultId: card.vaultId });
		expect(await vaultRecordsOf(card.vaultId)).toEqual([]);
		expect(forgotten).toEqual([]);
		expect(ceremonies()).toBe('create');
		expect(lofiCalls).toEqual([]);
	});

	it('a legacy row without its card is removed the same way, and its passkey record forgotten', async () => {
		const { card } = await newAccount();
		await asLegacyAccount(card);
		await dropCardOnly(card);
		await freshManager().destroyUserVault({ userHash: card.user_hash, vaultId: card.vaultId });
		expect(await vaultRecordsOf(card.vaultId)).toEqual([]);
		expect(forgotten).toEqual([`ldl-${card.vaultId}`]);
		expect(lofiCalls).toEqual([]);
	});
});

describe('the legacy passkey record of a deleted account', () => {
	it('is forgotten before the deletion resolves', async () => {
		const { card } = await newAccount();
		await asLegacyAccount(card);
		legacyVault = standInLegacyVault;
		const finished = [];
		forgetLegacy = async (id) => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			finished.push(id);
		};
		await freshManager().deleteUserVault(card.user_hash);
		expect(finished).toEqual([`ldl-${card.vaultId}`]);
	});

	it('that cannot be forgotten is reported, and the deletion still completes', async () => {
		const { card } = await newAccount();
		await asLegacyAccount(card);
		legacyVault = standInLegacyVault;
		forgetLegacy = async () => { throw new DOMException('write failed', 'QuotaExceededError'); };
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await freshManager().deleteUserVault(card.user_hash);
		expect(await freshManager().getLocalUserCards()).toEqual([]);
		expect(await vaultRecordsOf(card.vaultId)).toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('legacy passkey could not be removed'), expect.anything());
	});
});

describe('importing an account', () => {
	it('from a backup on a cleared device makes a new PRF passkey and vault, and signs in again later', async () => {
		const { backup } = await newAccount();
		await clearSiteData();
		const em = freshManager();
		const result = await em.importVaultKeys(backup.keys, { ...backup.identity });
		expect(result).toEqual({ status: 'active', userHash: backup.identity.user_hash });
		const card = (await em.getLocalUserCards())[0];
		expect(card.vaultLock).toBe('prf');
		expect(card.vaultId).not.toBe(backup.identity.vaultId);
		await em.logout();

		await freshManager().login(card.user_hash);
		expect(ceremonies()).toBe('create,create,get');
		expect(lofiCalls).toEqual([]);
	});

	it('that fails before its session locks the vault it made', async () => {
		const { backup } = await newAccount();
		await clearSiteData();
		openedHandles.length = 0;
		failWrites('pq-vault-owner-');
		const em = freshManager();
		await expect(em.importVaultKeys(backup.keys, { ...backup.identity })).rejects.toMatchObject({ name: 'QuotaExceededError' });
		expect(em.isAuth).toBe(false);
		expect(openedHandles).toHaveLength(1);
		await lockedOut(openedHandles[0]);
	});

	it('onto a device that holds the account reuses its PRF vault and passkey, and keeps its guardian seed', async () => {
		const { card, backup } = await newAccount();
		const em = freshManager();
		const result = await em.importVaultKeys(backup.keys, { ...backup.identity, name: 'Alice' }, { lock: 'legacy' });
		expect(result).toEqual({ status: 'active', userHash: card.user_hash });
		const [after] = await em.getLocalUserCards();
		expect(after).toMatchObject({ vaultId: card.vaultId, vaultLock: 'prf' });
		expect(await em.guardianMetaSeed()).toBe(backup.keys.meta_seed);
		expect(ceremonies()).toBe('create,get');
		expect(lofiCalls).toEqual([]);
	});
});

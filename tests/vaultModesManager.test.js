import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { _setAcceptedSnapshotStorageForTests } from '@/lib/data/acceptedSnapshot';
import { _setIntentStorageForTests } from '@/lib/data/intents';
import { _setStorageForTests as setOutboxStorage } from '@/lib/data/outbox';
import { assertPrf, lockRecordFor, lockSaltOf, lockSeedFromPrf } from '@buckitup/pq-client/vaultLock';
import { prfAuthenticator } from './helpers/prfAuthenticator';

let cardRows;
let serverRows;
let auth;
const lofiCalls = [];
let duringPrompt = null;

vi.mock('@/lib/data/collections', () => ({
	resetUserStorageCollection: () => {},
	getUserCardsCollection: () => ({
		preload: () => (hangCardWrites ? new Promise(() => {}) : Promise.resolve()),
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
let failEnvelopeWrites = false;
let hangCardWrites = false;
vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	putStorageRow: async ({ userHash, uuid, valueB64, deletedFlag = false }) => {
		if (failEnvelopeWrites) throw new Error('the server did not answer');
		serverRows = serverRows.filter((r) => !(r.user_hash === userHash && r.uuid === uuid));
		serverRows.push({ user_hash: userHash, uuid, value_b64: valueB64, deleted_flag: deletedFlag });
		return {};
	},
	getPublicStorageRowsByUuid: async (uuid) => serverRows.filter((r) => r.uuid === uuid && !r.deleted_flag),
	putStorageJsonPatch: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	saveStorageJsonPatch: async () => 'synced',
}));
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
		if (duringPrompt) {
			const run = duringPrompt;
			duringPrompt = null;
			await run();
		}
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
	duringPrompt = null;
	failEnvelopeWrites = false;
	hangCardWrites = false;
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
	it('changes the passkey only after copying and checking the complete vault', async () => {
		const { card } = await newAccount();
		const em = freshManager();
		await em.login(card.user_hash);
		await em.saveRecoveryProgress({ phase: 'waiting', share: 3 });
		const keys = await em.exportVaultKeys();
		const metaSeed = await em.guardianMetaSeed();
		const result = await em.rotateVaultPasskey();
		expect(result.oldCredentialId).toBe(auth.credentialIds()[0]);
		expect(result.newCredentialId).toBe(auth.credentialIds()[1]);
		expect(result.card.vaultId).not.toBe(card.vaultId);
		expect(await vaultRecordsOf(card.vaultId)).toEqual([]);
		expect((await em.exportVaultKeys()).sign_skey).toBe(keys.sign_skey);
		expect(await em.guardianMetaSeed()).toBe(metaSeed);
		expect(await em.loadRecoveryProgress()).toEqual({ phase: 'waiting', share: 3 });
		await em.logout();
		const reopened = freshManager();
		await reopened.login(card.user_hash);
		expect((await reopened.exportVaultKeys()).sign_skey).toBe(keys.sign_skey);
		expect((await vaultStorage().keys()).filter((key) => key.startsWith('pq-passkey-rotation-'))).toEqual([]);
	});

	it('keeps the old passkey and vault when the new registry pointer cannot be saved', async () => {
		const { card } = await newAccount();
		const em = freshManager();
		await em.login(card.user_hash);
		failStorage('set', 'pq-vaults-registry');
		await expect(em.rotateVaultPasskey()).rejects.toMatchObject({ name: 'QuotaExceededError' });
		vaultStorage().set.mockRestore();
		expect((await em.getLocalUserCards())[0].vaultId).toBe(card.vaultId);
		expect(await em.hasLocalVault(card.user_hash)).toBe(true);
		expect((await vaultStorage().keys()).filter((key) => key.startsWith('pq-passkey-rotation-'))).toEqual([]);
		await em.logout();
		await expect(freshManager().login(card.user_hash)).resolves.toBeTruthy();
	});

	it('a cancelled new-passkey prompt leaves the old account usable', async () => {
		const { card } = await newAccount();
		const em = freshManager();
		await em.login(card.user_hash);
		auth.refuseNext();
		await expect(em.rotateVaultPasskey()).rejects.toMatchObject({ name: 'NotAllowedError' });
		expect((await em.getLocalUserCards())[0].vaultId).toBe(card.vaultId);
		expect((await vaultStorage().keys()).filter((key) => key.startsWith('pq-passkey-rotation-'))).toEqual([]);
		await em.logout();
		await expect(freshManager().login(card.user_hash)).resolves.toBeTruthy();
	});

	it('an interrupted change before the registry switch clears its new vault on restart', async () => {
		const { card } = await newAccount();
		const em = freshManager();
		await em.login(card.user_hash);
		const store = vaultStorage();
		const realSet = store.set.bind(store);
		const set = vi.spyOn(store, 'set').mockImplementation(async (key, value) => {
			if (key === 'pq-vaults-registry') throw new DOMException('write failed', 'QuotaExceededError');
			return realSet(key, value);
		});
		const realRemove = store.remove.bind(store);
		const remove = vi.spyOn(store, 'remove').mockImplementation(async (key) => {
			if (key.startsWith('local-vault-') && key !== `local-vault-${card.vaultId}`) throw new Error('disk busy');
			return realRemove(key);
		});
		await expect(em.rotateVaultPasskey()).rejects.toMatchObject({ name: 'QuotaExceededError' });
		set.mockRestore();
		remove.mockRestore();
		const [marker] = (await store.keys()).filter((key) => key.startsWith('pq-passkey-rotation-'));
		expect(marker).toBeTruthy();
		await em.logout();
		const restarted = freshManager();
		expect(await restarted.clearPasskeyRotations()).toBe(0);
		expect((await restarted.getLocalUserCards())[0].vaultId).toBe(card.vaultId);
		expect((await store.keys()).filter((key) => key.startsWith('pq-passkey-rotation-'))).toEqual([]);
		await expect(restarted.login(card.user_hash)).resolves.toBeTruthy();
	});

	it('remembers the old vault for cleanup if deletion fails after the new passkey is committed', async () => {
		const { card } = await newAccount();
		const em = freshManager();
		await em.login(card.user_hash);
		failStorage('remove', `local-vault-${card.vaultId}`);
		const result = await em.rotateVaultPasskey();
		expect(result.card.vaultId).not.toBe(card.vaultId);
		expect((await vaultStorage().keys()).filter((key) => key.startsWith('pq-passkey-rotation-'))).toHaveLength(1);
		vaultStorage().remove.mockRestore();
		await em.logout();
		expect(await freshManager().clearPasskeyRotations()).toBe(0);
		expect(await vaultRecordsOf(card.vaultId)).toEqual([]);
		await expect(freshManager().login(card.user_hash)).resolves.toBeTruthy();
	});

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

	it.each([
		['another account\'s user_hash', (b) => { b.identity.user_hash = 'u_' + 'ab'.repeat(64); }],
		['another account\'s signing key', (b, other) => { b.keys.sign_skey = other.keys.sign_skey; }],
		['no crypt key', (b) => { delete b.keys.crypt_skey; }],
	])('refuses a backup with %s before any prompt or write', async (_, spoil) => {
		const { backup } = await newAccount('Alice');
		const { backup: other } = await newAccount('Bob');
		await clearSiteData();
		spoil(backup, other);
		const before = ceremonies();
		const em = freshManager();
		await expect(em.importVaultKeys(backup.keys, { ...backup.identity })).rejects.toMatchObject({ name: 'BackupMismatchError' });
		expect(ceremonies()).toBe(before);
		expect(await em.getLocalUserCards()).toEqual([]);
		expect((await vaultStorage().keys()).filter((k) => k.startsWith('local-vault-'))).toEqual([]);
	});
});

describe('restoring with the same passkey after the site data is cleared', () => {
	const prepareLock = async () => {
		const probe = await assertPrf(auth.credentials, { rpId: 'localhost', first: new Uint8Array(32) });
		probe.first.fill(0);
		const lock = lockRecordFor({ credentialId: probe.credentialId, rpId: 'localhost' });
		const answer = await assertPrf(auth.credentials, { rpId: 'localhost', credentialId: lock.credentialId, first: lockSaltOf(lock) });
		const seed = lockSeedFromPrf(answer.first);
		answer.first.fill(0);
		return { lock, seed };
	};

	it('makes a new vault under a new salt without a new passkey, and the next sign-in opens it', async () => {
		const { card: before, backup } = await newAccount();
		const oldLock = await vaultStorage().get(`pq-vault-lock-${before.vaultId}`);
		await clearSiteData();

		const prepared = await prepareLock();
		const em = freshManager();
		const result = await em.importVaultKeys(backup.keys, { ...backup.identity }, { lock: prepared });
		expect(result.status).toBe('active');
		const card = (await em.getLocalUserCards())[0];
		const newLock = await vaultStorage().get(`pq-vault-lock-${card.vaultId}`);
		expect(card).toMatchObject({ user_hash: before.user_hash, vaultLock: 'prf' });
		expect(card.vaultId).not.toBe(before.vaultId);
		expect(newLock.credentialId).toBe(oldLock.credentialId);
		expect(newLock.salt).not.toBe(oldLock.salt);
		expect(prepared.seed.every((b) => b === 0)).toBe(false);
		await em.logout();
		expect(prepared.seed.every((b) => b === 0)).toBe(true);

		const again = freshManager();
		await again.login(before.user_hash);
		expect(again.isAuth).toBe(true);
		expect(auth.calls.filter((c) => c === 'create')).toHaveLength(1);
		expect(lofiCalls).toEqual([]);
	});

	it('leaves nothing on this device when the card cannot be stored, so the restore can be run again', async () => {
		const { backup } = await newAccount();
		await clearSiteData();
		cardRows.clear();

		const prepared = await prepareLock();
		const em = freshManager();
		await expect(em.importVaultKeys(backup.keys, { ...backup.identity }, { lock: prepared })).rejects.toMatchObject({ name: 'AccountImportIncompleteError' });
		expect(em.isAuth).toBe(false);
		expect(await em.getLocalUserCards()).toEqual([]);
		expect((await vaultStorage().keys()).filter((k) => /^(local-vault|pq-vault)-/.test(k))).toEqual([]);
		expect(prepared.seed.every((b) => b === 0)).toBe(true);
	});

	describe('when the vault a failed restore made cannot be cleared', () => {
		const LEFTOVER = 'pq-restore-leftover-';
		const leftovers = async () => (await vaultStorage().keys()).filter((k) => k.startsWith(LEFTOVER)).map((k) => k.slice(LEFTOVER.length));
		const vaultRows = async () => (await vaultStorage().keys()).filter((k) => k.startsWith('local-vault-'));
		const vaultsStuck = () => {
			failStorage('remove', 'local-vault-');
			return () => vaultStorage().remove.mockRestore();
		};

		it('a card that could not be stored: the account is not listed, the error is the import\'s, and the vault is marked', async () => {
			const { backup } = await newAccount();
			await clearSiteData();
			const cards = new Map(cardRows);
			cardRows.clear();
			const unstick = vaultsStuck();
			const prepared = await prepareLock();
			const em = freshManager();
			await expect(em.importVaultKeys(backup.keys, { ...backup.identity }, { lock: prepared })).rejects.toMatchObject({ name: 'AccountImportIncompleteError' });
			expect(em.isAuth).toBe(false);
			expect(await em.getLocalUserCards()).toEqual([]);
			expect(await em.hasLocalVault(backup.identity.user_hash)).toBe(false);
			const [stuck] = await leftovers();
			expect(await vaultRows()).toEqual([`local-vault-${stuck}`]);

			expect(await em.clearRestoreLeftovers()).toBe(1);
			unstick();
			expect(await em.clearRestoreLeftovers()).toBe(0);
			expect(await leftovers()).toEqual([]);
			expect((await vaultStorage().keys()).filter((k) => /^(local-vault|pq-vault)-/.test(k))).toEqual([]);

			for (const [k, v] of cards) cardRows.set(k, v);
			const again = freshManager();
			expect((await again.importVaultKeys(backup.keys, { ...backup.identity }, { lock: await prepareLock() })).status).toBe('active');
		});

		it('keys that could not be written, over a card whose vault was missing: the card comes back as it was', async () => {
			const { card: before, backup } = await newAccount();
			await vaultStorage().remove(`local-vault-${before.vaultId}`);
			await vaultStorage().remove(`pq-vault-lock-${before.vaultId}`);
			const listed = await freshManager().getLocalUserCards();
			failWrites('pq-vault-owner-');
			const unstick = vaultsStuck();
			const prepared = await prepareLock();
			const em = freshManager();
			await expect(em.importVaultKeys(backup.keys, { ...backup.identity }, { lock: prepared })).rejects.toMatchObject({ name: 'QuotaExceededError' });
			expect(em.isAuth).toBe(false);
			expect(await em.getLocalUserCards()).toEqual(listed);
			expect(await em.hasLocalVault(before.user_hash)).toBe(false);
			const [stuck] = await leftovers();
			expect(stuck).not.toBe(before.vaultId);
			expect(await vaultRows()).toEqual([`local-vault-${stuck}`]);

			vaultStorage().set.mockRestore();
			unstick();
			const again = freshManager();
			expect((await again.importVaultKeys(backup.keys, { ...backup.identity }, { lock: await prepareLock() })).status).toBe('active');
			const [restored] = await again.getLocalUserCards();
			expect(await leftovers()).toEqual([]);
			expect(await vaultRows()).toEqual([`local-vault-${restored.vaultId}`]);
			expect(restored.vaultId).not.toBe(stuck);
		});

		const failWritesAfter = (key, after) => {
			const store = vaultStorage();
			const real = store.set.bind(store);
			let seen = 0;
			const spy = vi.spyOn(store, 'set').mockImplementation(async (k, ...rest) => {
				if (k === key && ++seen > after) throw new DOMException('write failed', 'QuotaExceededError');
				return real(k, ...rest);
			});
			return () => spy.mockRestore();
		};
		const registryOnDisk = async () => (await vaultStorage().get('pq-vaults-registry')) ?? [];

		it.each([
			['no account was here', false],
			['the account was listed without its vault', true],
		])('the registry cannot be put back (%s): after a restart no card points at the failed vault, and it can be repaired', async (_, listedBefore) => {
			const { card: before, backup } = await newAccount();
			if (listedBefore) {
				await vaultStorage().remove(`local-vault-${before.vaultId}`);
				await vaultStorage().remove(`pq-vault-lock-${before.vaultId}`);
			} else {
				await clearSiteData();
			}
			const listed = await registryOnDisk();
			const cards = new Map(cardRows);
			cardRows.clear();
			const prepared = await prepareLock();
			const em = freshManager();
			const registryWritable = failWritesAfter('pq-vaults-registry', 1);
			const failure = await em.importVaultKeys(backup.keys, { ...backup.identity }, { lock: prepared }).catch((e) => e);
			registryWritable();
			expect(failure).toMatchObject({ name: 'AccountImportIncompleteError', undoFailures: [expect.objectContaining({ name: 'QuotaExceededError' })] });

			const restarted = freshManager();
			const failedVault = (c) => c.user_hash === before.user_hash && c.vaultId !== before.vaultId;
			expect((await restarted.getLocalUserCards()).filter(failedVault)).toEqual([]);
			expect(restarted.isAuth).toBe(false);

			expect(await restarted.clearRestoreLeftovers()).toBe(0);
			expect(await registryOnDisk()).toEqual(listed);
			expect((await vaultStorage().keys()).filter((k) => k.startsWith('local-vault-') || k.startsWith('pq-restore-'))).toEqual([]);
			for (const [k, v] of cards) cardRows.set(k, v);
			expect((await freshManager().importVaultKeys(backup.keys, { ...backup.identity }, { lock: await prepareLock() })).status).toBe('active');
			expect((await vaultStorage().keys()).filter((k) => k.startsWith('pq-restore-'))).toEqual([]);
		});

		it('a restore whose vault cannot even be marked stops before any key is written, and leaves nothing listed', async () => {
			const { backup } = await newAccount();
			await clearSiteData();
			failStorage('set', 'pq-restore-');
			const em = freshManager();
			const failure = await em.importVaultKeys(backup.keys, { ...backup.identity }, { lock: await prepareLock() }).catch((e) => e);
			expect(failure).toMatchObject({ name: 'QuotaExceededError' });
			expect(await em.getLocalUserCards()).toEqual([]);
			expect(em.isAuth).toBe(false);
			expect(await vaultRows()).toEqual([]);
		});

		it.each([
			['no account was here', false],
			['the account was listed without its vault', true],
		])('the leftover mark, the registry and the vault all fail to be undone (%s): after a restart the failed card is not shown and the vault is still found', async (_, listedBefore) => {
			const { card: before, backup } = await newAccount();
			if (listedBefore) {
				await vaultStorage().remove(`local-vault-${before.vaultId}`);
				await vaultStorage().remove(`pq-vault-lock-${before.vaultId}`);
			} else {
				await clearSiteData();
			}
			const listed = await registryOnDisk();
			const cards = new Map(cardRows);
			cardRows.clear();
			const prepared = await prepareLock();
			const em = freshManager();
			failStorage('set', LEFTOVER);
			const store = vaultStorage();
			const set = store.set.getMockImplementation();
			let registryWrites = 0;
			store.set.mockImplementation(async (k, ...rest) => {
				if (k === 'pq-vaults-registry' && ++registryWrites > 1) throw new DOMException('write failed', 'QuotaExceededError');
				return set(k, ...rest);
			});
			const unstick = vaultsStuck();
			const failure = await em.importVaultKeys(backup.keys, { ...backup.identity }, { lock: prepared }).catch((e) => e);
			store.set.mockRestore();
			expect(failure).toMatchObject({ name: 'AccountImportIncompleteError', undoFailures: [expect.anything(), expect.anything(), expect.anything()] });

			const restarted = freshManager();
			expect((await restarted.getLocalUserCards()).filter((c) => c.user_hash === before.user_hash && c.vaultId !== before.vaultId)).toEqual([]);
			expect(await restarted.getLocalUserCards()).toEqual(listed);
			expect(await restarted.clearRestoreLeftovers()).toBe(1);
			expect(await restarted.getLocalUserCards()).toEqual(listed);
			unstick();
			expect(await restarted.clearRestoreLeftovers()).toBe(0);
			expect(await registryOnDisk()).toEqual(listed);
			expect((await vaultStorage().keys()).filter((k) => k.startsWith('local-vault-') || k.startsWith('pq-restore-'))).toEqual([]);
			for (const [k, v] of cards) cardRows.set(k, v);
			expect((await freshManager().importVaultKeys(backup.keys, { ...backup.identity }, { lock: await prepareLock() })).status).toBe('active');
		});

		it.each([
			['right after the card, before its owner record', () => {
				const store = vaultStorage();
				const real = store.set.bind(store);
				vi.spyOn(store, 'set').mockImplementation((k, ...rest) => (k.startsWith('pq-vault-owner-') ? new Promise(() => {}) : real(k, ...rest)));
				return () => store.set.mockRestore();
			}],
			['while the card goes to the server', () => {
				hangCardWrites = true;
				return () => { hangCardWrites = false; };
			}],
		])('a tab closed %s: after a restart the account is either whole or gone, never listed on a vault it cannot use', async (_, closeTab) => {
			const { card: before, backup } = await newAccount();
			await clearSiteData();
			const reopen = closeTab();
			const em = freshManager();
			let settled = false;
			em.importVaultKeys(backup.keys, { ...backup.identity }, { lock: await prepareLock() }).finally(() => { settled = true; }).catch(() => {});
			await vi.waitFor(async () => expect((await registryOnDisk()).map((c) => c.user_hash)).toEqual([before.user_hash]));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(settled).toBe(false);
			reopen();

			const safe = async () => {
				const restarted = freshManager();
				const listed = (await restarted.getLocalUserCards()).filter((c) => c.user_hash === before.user_hash);
				if (!listed.length) {
					expect(await vaultRows()).toEqual([]);
					return 'gone';
				}
				expect(await restarted.hasLocalVault(before.user_hash)).toBe(true);
				const [card] = listed;
				const { openPrfVault } = await import('@/libs/accountVault');
				const vault = await openPrfVault(card.vaultId, await vaultStorage().get(`pq-vault-lock-${card.vaultId}`));
				expect(await vault.get('sign_skey')).toBeTruthy();
				expect(await vault.get('crypt_skey')).toBeTruthy();
				expect(await vault.get('evm_skey')).toBe(backup.keys.evm_skey);
				expect(await vault.get('contact_skey')).toBe(backup.keys.contact_skey);
				vault.lock();
				return 'whole';
			};
			const atRestart = await safe();
			await freshManager().clearRestoreLeftovers();
			expect(await safe()).toBe(atRestart);
		});

		it('neither the mark nor the vault can be written off: after a restart clearRestoreLeftovers still finds the vault', async () => {
			const { backup } = await newAccount();
			await clearSiteData();
			cardRows.clear();
			const prepared = await prepareLock();
			const em = freshManager();
			failStorage('set', LEFTOVER);
			const unstick = vaultsStuck();
			await expect(em.importVaultKeys(backup.keys, { ...backup.identity }, { lock: prepared })).rejects.toMatchObject({ name: 'AccountImportIncompleteError' });
			vaultStorage().set.mockRestore();
			expect(await em.getLocalUserCards()).toEqual([]);
			const [stuck] = await vaultRows();
			expect(stuck).toBeTruthy();

			const restarted = freshManager();
			expect(await restarted.clearRestoreLeftovers()).toBe(1);
			unstick();
			expect(await restarted.clearRestoreLeftovers()).toBe(0);
			expect(await vaultRows()).toEqual([]);
		});

		it('never clears a marked vault a card points at, nor the one the session is open with', async () => {
			const em = freshManager();
			const card = await em.createUserVault({ name: 'Alice' });
			const { card: other } = await newAccount('Bob');
			const signedIn = freshManager();
			await signedIn.login(card.user_hash);
			for (const id of [card.vaultId, other.vaultId]) await vaultStorage().set(`${LEFTOVER}${id}`, { userHash: 'u_x' });
			expect(await signedIn.clearRestoreLeftovers()).toBe(2);
			expect(await vaultRecordsOf(card.vaultId)).toContain('local-vault');
			expect(await vaultRecordsOf(other.vaultId)).toContain('local-vault');
			expect(signedIn.isAuth).toBe(true);
			expect((await signedIn.exportVaultKeys()).sign_skey).toBeTruthy();
		});
	});

	it('tells an account whose keys are here from one listed without them', async () => {
		const { card } = await newAccount();
		const em = freshManager();
		expect(await em.hasLocalVault(card.user_hash)).toBe(true);
		await vaultStorage().remove(`local-vault-${card.vaultId}`);
		expect(await em.hasLocalVault(card.user_hash)).toBe(false);
		expect(await em.hasLocalVault('u_' + 'ab'.repeat(64))).toBe(false);
	});

	it('is refused for an account whose vault is still on this device', async () => {
		const { card, backup } = await newAccount();
		const prepared = await prepareLock();
		const em = freshManager();
		await expect(em.importVaultKeys(backup.keys, { ...backup.identity }, { lock: prepared })).rejects.toThrow(/already on this device/);
		expect((await em.getLocalUserCards()).map((c) => c.vaultId)).toEqual([card.vaultId]);
		expect(lofiCalls).toEqual([]);
	});
});

describe('passkey recovery, end to end', () => {
	let slots;
	const enableIn = async (em, card) => {
		const { enablePasskeyRecovery } = await import('@/lib/recovery/passkeyRecovery');
		const { assertVaultReadableAnonymously } = await import('@/lib/recovery/vault');
		const scope = em.passkeyRecoveryScope();
		const slot = (slots[scope.userHash] ??= {});
		return enablePasskeyRecovery({
			credentials: navigator.credentials,
			owner: scope.userHash,
			lock: await scope.vaultLock(),
			label: 'This browser',
			assertCurrent: scope.assertCurrent,
			assertReadable: (wrapKey) => scope.pinned(() => assertVaultReadableAnonymously(wrapKey)),
			exportBackup: () => scope.pinned(async () => ({
				identity: { ...(await em.getLocalUserCards()).find((c) => c.user_hash === em.currentUserHash) ?? card },
				keys: { ...(await em.exportVaultKeys()), meta_seed: await em.guardianMetaSeed() },
			})),
			publish: scope.publish,
			recordEntry: (key, entry) => scope.pinned(async () => {
				if (entry) slot[key] = entry;
				else delete slot[key];
			}),
		});
	};

	beforeEach(() => {
		slots = {};
	});

	it('stops when another account is signed in during the passkey prompt: no backup is sealed under the first account\'s passkey', async () => {
		const { PasskeyRecoveryError } = await import('@/lib/recovery/passkeyRecovery');
		const { card: alice } = await newAccount('Alice');
		const { card: bob } = await newAccount('Bob');
		const em = freshManager();
		await em.login(alice.user_hash);
		duringPrompt = () => em.login(bob.user_hash);
		const failure = await enableIn(em, alice).catch((e) => e);
		expect(failure).toBeInstanceOf(PasskeyRecoveryError);
		expect(failure.reason).toBe('account-changed');
		expect(em.currentUserHash).toBe(bob.user_hash);
		expect(serverRows).toEqual([]);
		expect(slots).toEqual({ [alice.user_hash]: {} });
		expect(lofiCalls).toEqual([]);
	});

	describe('renewal at the next sign-in', () => {
		const slotIn = (em, userHash) => {
			const slot = (slots[userHash] ??= {});
			em.loadSlotJson = vi.fn(async () => ({ passkeys: { ...slot } }));
			em.patchSlotJson = async (_name, patch) => {
				for (const [key, entry] of Object.entries(patch.passkeys)) slot[key] = entry;
				return { passkeys: { ...slot } };
			};
			return slot;
		};
		const exportingMore = (em) => {
			const real = em.exportVaultKeys.bind(em);
			vi.spyOn(em, 'exportVaultKeys').mockImplementation(async () => ({ ...(await real()), added_key: 'ff' }));
		};
		const envelopeOf = (locator) => serverRows.find((r) => r.uuid === locator)?.value_b64;

		const turnedOn = async () => {
			const { card } = await newAccount();
			const first = freshManager();
			await first.login(card.user_hash);
			const { key, entry } = await enableIn(first, card);
			await first.logout();
			return { card, key, entry };
		};

		it('reseals an enabled copy that no longer matches the account, from the sign-in\'s own assertion: one prompt, and the entry stays active', async () => {
			const { openVault, deriveVaultLocator } = await import('@buckitup/pq-client/vaultEnvelope');
			const { assertPrf } = await import('@buckitup/pq-client/vaultLock');
			const { recoverySalt, recoveryWrapKey, fingerprintOf } = await import('@/lib/recovery/passkeyRecovery');
			const { card, key, entry } = await turnedOn();
			const before = envelopeOf(entry.locator);
			const promptsBefore = auth.calls.length;

			const em = freshManager();
			const slot = slotIn(em, card.user_hash);
			exportingMore(em);
			await em.login(card.user_hash);
			expect(auth.calls.length).toBe(promptsBefore + 1);
			await vi.waitFor(() => expect(slot[key].fingerprint).not.toBe(entry.fingerprint));
			expect(auth.calls.length).toBe(promptsBefore + 1);

			expect(slot[key]).toMatchObject({ state: 'active', created_at: entry.created_at, locator: entry.locator, label: entry.label });
			expect(envelopeOf(entry.locator)).not.toBe(before);
			const wrapKey = recoveryWrapKey((await assertPrf(auth.credentials, { rpId: 'localhost', first: recoverySalt() })).first);
			expect(deriveVaultLocator(wrapKey)).toBe(entry.locator);
			const sealed = JSON.parse(await openVault(envelopeOf(entry.locator), wrapKey));
			expect(sealed.keys.added_key).toBe('ff');
			expect(slot[key].fingerprint).toBe(fingerprintOf(sealed));
			expect(lofiCalls).toEqual([]);
		});

		it('writes nothing at sign-in while the copy matches the account', async () => {
			const { card, key, entry } = await turnedOn();
			const before = envelopeOf(entry.locator);
			const em = freshManager();
			const slot = slotIn(em, card.user_hash);
			const patch = vi.spyOn(em, 'patchSlotJson');
			await em.login(card.user_hash);
			await vi.waitFor(() => expect(em.loadSlotJson).toHaveBeenCalled());
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(patch).not.toHaveBeenCalled();
			expect(envelopeOf(entry.locator)).toBe(before);
			expect(slot[key]).toEqual(entry);
		});

		it('does not fail the sign-in or claim a renewal when the envelope cannot be written, and renews at the sign-in after', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const { card, key, entry } = await turnedOn();
			const before = envelopeOf(entry.locator);

			const em = freshManager();
			const slot = slotIn(em, card.user_hash);
			exportingMore(em);
			failEnvelopeWrites = true;
			await em.login(card.user_hash);
			expect(em.isAuth).toBe(true);
			await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not renewed at sign-in'), expect.anything()));
			expect(slot[key]).toEqual(entry);
			expect(envelopeOf(entry.locator)).toBe(before);
			await em.logout();

			failEnvelopeWrites = false;
			const again = freshManager();
			const slotAgain = slotIn(again, card.user_hash);
			exportingMore(again);
			await again.login(card.user_hash);
			await vi.waitFor(() => expect(slotAgain[key].fingerprint).not.toBe(entry.fingerprint));
			expect(envelopeOf(entry.locator)).not.toBe(before);
		});

		it('leaves a setup that was not finished for the person to finish', async () => {
			const { card, key, entry } = await turnedOn();
			const before = envelopeOf(entry.locator);
			const em = freshManager();
			const slot = slotIn(em, card.user_hash);
			slot[key] = { ...entry, state: 'pending' };
			exportingMore(em);
			const patch = vi.spyOn(em, 'patchSlotJson');
			await em.login(card.user_hash);
			await vi.waitFor(() => expect(em.loadSlotJson).toHaveBeenCalled());
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(patch).not.toHaveBeenCalled();
			expect(envelopeOf(entry.locator)).toBe(before);
		});

		it('signs in as before with an authenticator that ignores the second input, and renews nothing', async () => {
			auth = prfAuthenticator('at-create', { second: false });
			const { card, key, entry } = await turnedOn();
			const em = freshManager();
			const slot = slotIn(em, card.user_hash);
			exportingMore(em);
			const patch = vi.spyOn(em, 'patchSlotJson');
			const promptsBefore = auth.calls.length;
			await em.login(card.user_hash);
			expect(em.isAuth).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(auth.calls.length).toBe(promptsBefore + 1);
			expect(em.loadSlotJson).not.toHaveBeenCalled();
			expect(patch).not.toHaveBeenCalled();
			expect(slot[key]).toEqual(entry);
		});

		it('stops before its writes when another account is opened during the renewal', async () => {
			const { card: alice, key, entry } = await turnedOn();
			const { card: bob } = await newAccount('Bob');
			const before = envelopeOf(entry.locator);
			const em = freshManager();
			const slot = slotIn(em, alice.user_hash);
			exportingMore(em);
			const realLoad = em.loadSlotJson;
			em.loadSlotJson = async (...args) => {
				const read = await realLoad(...args);
				await em.logout();
				return read;
			};
			await em.login(alice.user_hash);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(envelopeOf(entry.locator)).toBe(before);
			expect(slot[key]).toEqual(entry);
			expect(bob.user_hash).not.toBe(alice.user_hash);
		});

		it('knows whether the passkey can be backed up from the sign-in, and forgets it at sign-out', async () => {
			const { card } = await newAccount();
			const em = freshManager();
			expect(em.passkeyFlags()).toBeNull();
			await em.login(card.user_hash);
			expect(em.passkeyFlags()).toEqual({ backupEligible: true, backupState: true });
			await em.logout();
			expect(em.passkeyFlags()).toBeNull();
		});
	});

	it('on → site data cleared → restored with the same passkey → ordinary sign-in', async () => {
		const { recoverWithPasskey, retirePasskeyRecovery, PasskeyRecoveryError } = await import('@/lib/recovery/passkeyRecovery');
		const { fetchVault } = await import('@/lib/recovery/vault');

		const { card: before } = await newAccount();
		const em = freshManager();
		await em.login(before.user_hash);
		const { key, entry } = await enableIn(em, before);
		const slot = slots[before.user_hash];
		expect(Object.values(slot)).toEqual([expect.objectContaining({ state: 'active' })]);
		const metaSeed = await em.guardianMetaSeed();
		await em.logout();

		await clearSiteData();
		expect(await freshManager().getLocalUserCards()).toEqual([]);

		const creates = auth.calls.filter((c) => c === 'create').length;
		const { backup, prepared } = await recoverWithPasskey({ credentials: navigator.credentials, rpId: 'localhost', fetchVault });
		const restoring = freshManager();
		const result = await restoring.importVaultKeys(backup.keys, { ...backup.identity }, { lock: prepared });
		expect(result).toEqual({ status: 'active', userHash: before.user_hash });
		await restoring.logout();

		const after = freshManager();
		await after.login(before.user_hash);
		expect(after.isAuth).toBe(true);
		expect(await after.guardianMetaSeed()).toBe(metaSeed);
		const card = (await after.getLocalUserCards())[0];
		expect(card.vaultId).not.toBe(before.vaultId);
		expect((await after.currentVaultLock()).credentialId).toBe(auth.credentialIds()[0]);
		expect(auth.calls.filter((c) => c === 'create')).toHaveLength(creates);
		expect(lofiCalls).toEqual([]);

		const scope = after.passkeyRecoveryScope();
		await retirePasskeyRecovery({ key, locator: entry.locator }, {
			tombstone: scope.tombstone,
			recordEntry: (k) => scope.pinned(async () => { delete slot[k]; }),
			assertCurrent: scope.assertCurrent,
		});
		expect(serverRows.find((r) => r.uuid === entry.locator)).toMatchObject({ deleted_flag: true, value_b64: 'AA==' });
		expect(slot).toEqual({});
		const gone = await recoverWithPasskey({ credentials: navigator.credentials, rpId: 'localhost', fetchVault }).catch((e) => e);
		expect(gone).toBeInstanceOf(PasskeyRecoveryError);
		expect(gone.reason).toBe('absent');
	});
});

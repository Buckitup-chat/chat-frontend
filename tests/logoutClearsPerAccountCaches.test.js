import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _resetTouchedForTests, markTouched, isTouched } from '@/lib/data/readCache';
import { _setDialogCacheStoreForTests, readDialogRows } from '@/lib/data/dialogCache';
import { memoryDialogCacheStore } from './helpers/mainDialogCache';
import { _setAcceptedSnapshotStorageForTests, recordAccepted, getAccepted } from '@/lib/data/acceptedSnapshot';
import { _setIntentStorageForTests } from '@/lib/data/intents';

let vaults;
let rawStore;
let dialogCache;

const makeVault = (id) => {
	const data = new Map();
	return { id, async set(k, v) { data.set(k, v); }, async get(k) { return data.get(k); } };
};

const makeStorage = () => {
	const map = new Map();
	return {
		async get(k) { return map.get(k) ?? null; },
		async set(k, v) { map.set(k, v); },
		async delete(k) { map.delete(k); },
		async keys() { return [...map.keys()]; },
		async clear() { map.clear(); },
	};
};

vi.mock('@lo-fi/local-vault', () => ({
	connect: async ({ vaultID, addNewVault }) => {
		if (addNewVault) {
			const id = `vault-${vaults.size + 1}`;
			vaults.set(id, makeVault(id));
			return vaults.get(id);
		}
		return vaults.get(vaultID);
	},
	rawStorage: () => rawStore,
}));
vi.mock('@lo-fi/local-vault/adapter/idb', () => ({}));
vi.mock('@lo-fi/local-data-lock', () => ({ removeLocalAccount: async () => {} }));
vi.mock('@/lib/data/collections', () => ({
	resetUserStorageCollection: () => {},
	getUserCardsCollection: () => ({ async preload() {}, get: () => undefined, get toArray() { return []; } }),
}));
vi.mock('@/lib/data/ingest', () => ({
	sendMutationsAndAwaitShape: async () => ({ txids: [] }),
	drainPendingWrites: () => {},
	stopDrainLoop: () => {},
}));
vi.mock('@/lib/data/userStorage', () => ({
	getStorageRow: async () => null,
	putStorageRow: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
	putStorageJsonPatch: async () => ({ sync: Promise.resolve({ status: 'synced' }) }),
}));

const { EncryptionManagerPQ } = await import('@/libs/EncryptionManagerPQ');

const freshManager = () => {
	EncryptionManagerPQ.instance = null;
	return EncryptionManagerPQ.getInstance();
};

const ACCOUNT = 'u_' + 'a'.repeat(128);
const DIALOG = 'di_' + '1'.repeat(128);
const signedInManager = async () => {
	const vault = makeVault('vault-a');
	await vault.set('sign_skey', new Uint8Array(32).fill(1));
	await vault.set('crypt_skey', new Uint8Array(32).fill(2));
	vaults.set('vault-a', vault);
	await rawStore.set('pq-vaults-registry', [{ user_hash: ACCOUNT, vaultId: 'vault-a', name: 'A' }]);
	await recordAccepted('user_cards', ACCOUNT, {
		user_hash: ACCOUNT, sign_pkey: 'c2lnbg==', contact_pkey: 'Y29udGFjdA==', contact_cert: 'Y2VydA==',
		crypt_pkey: 'Y3J5cHQ=', crypt_cert: 'Y2VydA==', name: 'A', deleted_flag: false, owner_timestamp: 1, sign_b64: 'c2ln',
	}, ACCOUNT);
	const em = freshManager();
	await em.login(ACCOUNT);
	return em;
};

beforeEach(() => {
	vaults = new Map();
	const store = new Map();
	rawStore = {
		async get(k) { return store.get(k); },
		async set(k, v) { store.set(k, v); },
		async remove(k) { store.delete(k); },
	};
	dialogCache = memoryDialogCacheStore();
	_setDialogCacheStoreForTests(dialogCache);
	_resetTouchedForTests();
	_setAcceptedSnapshotStorageForTests(makeStorage());
	_setIntentStorageForTests(makeStorage());
});

describe('EncryptionManagerPQ.logout(): per-account disk caches (§8.4)', () => {
	it('logging out the active account wipes its account-scoped read-cache but leaves the durable accepted-snapshot base intact', async () => {
		await recordAccepted('dialog_messages', 'dmsg_1', { message_id: 'dmsg_1', owner_timestamp: 1 });

		const em = await signedInManager();
		await dialogCache.seed('dialog_messages', { message_id: 'dmsg_1', dialog_hash: DIALOG });
		await em.logout();

		expect(await getAccepted('dialog_messages', 'dmsg_1')).not.toBeNull();
		expect(await readDialogRows('dialog_messages', DIALOG)).toEqual([]);
	});

	it('keeps the public user_cards directory: same rows for every account, and the offline users list after a reload', async () => {
		markTouched('user_cards', 'u_' + '2'.repeat(128));
		markTouched('dialog_messages', 'dmsg_2');

		const em = await signedInManager();
		await em.logout();

		expect(isTouched('user_cards', 'u_' + '2'.repeat(128))).toBe(true);
		expect(isTouched('dialog_messages', 'dmsg_2')).toBe(false);
	});

	it('a logout with no active account (cold reload → sign-in) erases nothing', async () => {
		await dialogCache.seed('dialog_messages', { message_id: 'dmsg_1', dialog_hash: DIALOG });

		const em = freshManager();
		expect(em.isAuth).toBeFalsy();
		await em.logout();

		expect(await readDialogRows('dialog_messages', DIALOG)).toHaveLength(1);
	});
});

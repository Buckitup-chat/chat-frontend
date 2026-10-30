import { connect, rawStorage } from '@lo-fi/local-vault';
import '@lo-fi/local-vault/adapter/idb';
import { removeLocalAccount, deriveLockKey } from '@lo-fi/local-data-lock';
import { createPrfPasskey, readLockSeed } from '@buckitup/pq-client/vaultLock';
import { VaultLockedError } from '@/lib/data/keyCustody';

const VAULT_KEY_OPTIONS = {}

if (typeof navigator !== 'undefined' && navigator.credentials?.create) {
  const nativeCreate = navigator.credentials.create.bind(navigator.credentials);
  navigator.credentials.create = (options) => {
    if (options?.publicKey && !options.publicKey.authenticatorSelection) {
      options = {
        ...options,
        publicKey: {
          ...options.publicKey,
          authenticatorSelection: {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'preferred',
          },
        },
      };
    }
    return nativeCreate(options);
  };
}

export const vaultStorage = () => rawStorage('idb');

const lockKeyOf = (vaultId) => `pq-vault-lock-${vaultId}`;

export const prfLockOf = async (vaultId) => (vaultId ? (await vaultStorage().get(lockKeyOf(vaultId))) ?? null : null);

export const createLegacyVault = ({ name }) => connect({
  storageType: 'idb',
  addNewVault: true,
  keyOptions: { ...VAULT_KEY_OPTIONS, username: name, displayName: name },
});

export const openLegacyVault = (vaultId) => connect({ vaultID: vaultId, storageType: 'idb', keyOptions: VAULT_KEY_OPTIONS });

export const discoverLegacyVault = () => connect({ storageType: 'idb', discoverVault: true, keyOptions: VAULT_KEY_OPTIONS });

export const forgetLegacyLock = (accountID) => removeLocalAccount(accountID);

const newVaultId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]+/g, '');
};

const wipeLockKey = (key) => {
  key.iv.fill(0);
  key.privateKey.fill(0);
  key.encSK.fill(0);
};

const prfHandle = (vault, lockKey) => {
  let key = lockKey;
  const withKey = () => {
    if (!key) throw new VaultLockedError('the vault is locked; its passkey has to open it again');
    return { useLockKey: key };
  };
  return Object.freeze({
    id: vault.id,
    lockMode: 'prf',
    get: async (name) => vault.get(name, withKey()),
    set: async (name, value) => vault.set(name, value, withKey()),
    clear: async () => vault.clear(withKey()),
    lock: () => {
      if (key) {
        wipeLockKey(key);
        key = null;
      }
      try { vault.lock(); } catch {}
      return true;
    },
  });
};

export const isPrfVault = (vault) => vault?.lockMode === 'prf';

const openWithSeed = async (vaultId, lock, seed) => {
  const lockKey = { ...deriveLockKey(seed), localIdentity: vaultId };
  try {
    const vault = await connect({
      storageType: 'idb',
      vaultID: vaultId,
      keyOptions: { useLockKey: lockKey, cacheManualLockKey: false, relyingPartyID: lock.rpId },
    });
    return prfHandle(vault, lockKey);
  } catch (e) {
    wipeLockKey(lockKey);
    throw e;
  }
};

const createWithSeed = async (vaultId, lock, seed) => {
  const vault = await openWithSeed(vaultId, lock, seed);
  try {
    await vaultStorage().set(lockKeyOf(vaultId), lock);
  } catch (e) {
    vault.lock();
    throw e;
  }
  return { vault, lock };
};

export const createPrfVault = async ({ name, credentials = navigator.credentials, rpId = location.hostname }) => {
  const vaultId = newVaultId();
  const { record, seed } = await createPrfPasskey(credentials, { rpId, vaultId, name });
  return createWithSeed(vaultId, record, seed);
};

export const createPrfVaultWithSeed = ({ lock, seed }) => createWithSeed(newVaultId(), lock, seed);

export const openPrfVault = async (vaultId, lock, { credentials = navigator.credentials } = {}) => {
  if (!(await vaultStorage().get(`local-vault-${vaultId}`))?.data) throw new Error(`No vault ${vaultId} on this device`);
  return openWithSeed(vaultId, lock, await readLockSeed(credentials, lock));
};

export const dropPrfVault = async (vaultId, handle = null) => {
  if (handle) {
    await handle.clear().catch(() => {});
    handle.lock();
  }
  await vaultStorage().remove(`local-vault-${vaultId}`);
  await vaultStorage().remove(lockKeyOf(vaultId));
};

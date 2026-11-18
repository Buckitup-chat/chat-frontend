import { connect, rawStorage } from '@lo-fi/local-vault';
import '@lo-fi/local-vault/adapter/idb';
import { removeLocalAccount } from '@lo-fi/local-data-lock';
import * as prfVaults from '@buckitup/pq-client/vault';

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

export const createLegacyVault = ({ name }) => connect({
  storageType: 'idb',
  addNewVault: true,
  keyOptions: { ...VAULT_KEY_OPTIONS, username: name, displayName: name },
});

export const openLegacyVault = (vaultId) => connect({ vaultID: vaultId, storageType: 'idb', keyOptions: VAULT_KEY_OPTIONS });

export const discoverLegacyVault = () => connect({ storageType: 'idb', discoverVault: true, keyOptions: VAULT_KEY_OPTIONS });

export const forgetLegacyLock = (accountID) => removeLocalAccount(accountID);

export { prfLockOf, newPrfVaultId, isPrfVault, createPrfVaultWithSeed, dropPrfVault } from '@buckitup/pq-client/vault';

export const createPrfVault = ({ name, vaultId, credentials = navigator.credentials, rpId = location.hostname }) =>
  prfVaults.createPrfVault({ name, vaultId, credentials, rpId });

export const openPrfVault = (vaultId, lock, { credentials = navigator.credentials, recovery = null } = {}) =>
  prfVaults.openPrfVault(vaultId, lock, { credentials, recovery });

import { connect, rawStorage } from '@lo-fi/local-vault';
import '@lo-fi/local-vault/adapter/idb';
import { removeLocalAccount } from '@lo-fi/local-data-lock';
import * as secp from '@noble/secp256k1';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { randomBytes } from '@noble/post-quantum/utils.js';
import { arrayToBase64, decodeHexOrBase64 } from './enigma';
import { api } from '@/api/client';
import { sendMutationsWithRetry } from '@/lib/data/ingest';
import { getStorageRow, upsertStorageRow, STORAGE_SLOTS } from '@/lib/data/userStorage';

const VAULT_KEY_OPTIONS = {
  authenticatorSelection: {
    authenticatorAttachment: "cross-platform",
    userVerification: "preferred",
    residentKey: "preferred",
    requireResidentKey: false
  },

  timeout: 60000,
}

/**
 * Class for managing encryption and data storage.
 * Implements the Singleton pattern to ensure a single instance.
 * Added support for events via EventTarget.
 * Supports two separate vaults: one for PQ signing keys and one for chat data.
 */
export class EncryptionManagerPQ extends EventTarget {
  static instance = null;

  #rawStore = rawStorage('idb');
  #currentVault = null;

  #localUserCards = []
  #currentUserHash = null;
  #signSkey = null;
  #cryptSkey = null;
  #cryptPubKey = null;
  #contactSkey = null;
  #evmSkey = null;

  constructor() {
    super();

    console.log('Encryption manager created')

    if (EncryptionManagerPQ.instance) {
      return EncryptionManagerPQ.instance;
    }

    EncryptionManagerPQ.instance = this;

    this.#loadLocalUserCards()
  }

  // Push own user card to the server as a signed mutation.
  // Fire-and-forget with retry: card data also lives in the local vault
  // registry, so a failed push costs nothing locally.
  #pushOwnCard(card, { isUpdate = false, signSkey = null } = {}) {
    const key = signSkey || this.#signSkey;
    if (!key) return;
    try {
      const { mutation } = api.createUserCard(card.name || 'User', {
        user_hash: card.user_hash,
        sign_pkey: decodeHexOrBase64(card.sign_pkey),
        contact_pkey: decodeHexOrBase64(card.contact_pkey),
        contact_cert: decodeHexOrBase64(card.contact_cert),
        crypt_pkey: decodeHexOrBase64(card.crypt_pkey),
        crypt_cert: decodeHexOrBase64(card.crypt_cert),
        sign_skey: key,
      }, isUpdate ? 'update' : 'insert');
      sendMutationsWithRetry([mutation], key).catch((e) => {
        console.warn('[EncryptionManagerPQ] card push failed:', e?.message || e);
      });
    } catch (e) {
      console.warn('[EncryptionManagerPQ] card push build failed:', e);
    }
  }

  static getInstance() {
    if (!EncryptionManagerPQ.instance) {
      EncryptionManagerPQ.instance = new EncryptionManagerPQ();
    }

    return EncryptionManagerPQ.instance;
  }

  get isAuth() {
    return !!this.#currentUserHash && !!this.#signSkey;
  }

  get currentUserHash() {
    return this.#currentUserHash;
  }

  async initialize() {
    try {
      const vaultID = await this.#rawStore.get('main-vault-id');

      if (vaultID) await this.#connectToUserVault(vaultID);

      this.#loadLocalUserCards()
    } catch (error) {
      await this.handleError(error, 'Error during storage initialization');
    }
  }

  // Vaults Management

  async createUserVault({ name, notes, avatar, avatarDataUrl }) {
    const userVault = await connect({
      storageType: 'idb',
      addNewVault: true,
      keyOptions: { ...VAULT_KEY_OPTIONS, username: name, displayName: name }
    });

    const seed = randomBytes(32);

    const { publicKey: signPubKey, secretKey: signSkey } = ml_dsa87.keygen(seed);

    const { publicKey: cryptPubKey, secretKey: cryptSkey } = ml_kem1024.keygen();

    const contactPrivKey = secp.utils.randomPrivateKey();
    const contactPubKey = secp.getPublicKey(contactPrivKey, true);

    const evmPrivKey = secp.utils.randomPrivateKey();

    const userHash = 'u_' + bytesToHex(sha3_512(signPubKey));

    const cryptPubKeyB64 = arrayToBase64(cryptPubKey);
    const cryptCert = arrayToBase64(ml_dsa87.sign(cryptPubKey, signSkey));

    const contactPubKeyB64 = arrayToBase64(new Uint8Array(contactPubKey));
    const contactCert = arrayToBase64(ml_dsa87.sign(contactPubKey, signSkey));

    await userVault.set(`sign_skey`, signSkey);
    await userVault.set(`crypt_skey`, cryptSkey);
    await userVault.set(`evm_skey`, bytesToHex(evmPrivKey));
    await userVault.set(`contact_skey`, bytesToHex(contactPrivKey));

    const identity = {
      user_hash: userHash,
      vaultId: userVault.id,
      name,
      sign_pkey: arrayToBase64(signPubKey),
      crypt_pkey: cryptPubKeyB64,
      crypt_cert: cryptCert,
      contact_pkey: contactPubKeyB64,
      contact_cert: contactCert,

      userStorage: {}
    };

    this.#localUserCards.push(identity);

    await this.#saveLocalUserCards();

    this.#pushOwnCard({ ...identity, name }, { signSkey });

    await this.login(userHash);

    let avatarUuid = null;
    if (avatar instanceof Blob || avatar instanceof File) {
      avatarUuid = await this.encryptAndStoreAvatar(avatar);
    } else if (typeof avatar === 'string') {
      avatarUuid = avatar;
    }

    await this.updateUserStorage({ name, notes, avatarUuid, avatarDataUrl });

    return this.#localUserCards.find(i => i.user_hash === userHash);
  }

  async #connectToUserVault(vaultId) {
    if (this.#currentVault && this.#currentVault.id === vaultId) {
      return this.#currentVault;
    }

    this.#currentVault = await connect({
      vaultID: vaultId,
      storageType: 'idb',
      keyOptions: VAULT_KEY_OPTIONS
    });

    return this.#currentVault;
  }

  // Authentification

  async login(userHash) {
    await this.#loadLocalUserCards();

    const identity = this.#localUserCards.find(i => i.user_hash === userHash);

    if (!identity) throw new Error(`User ${userHash} not found in local identities`);

    this.#currentVault = await connect({
      vaultID: identity.vaultId,
      storageType: 'idb',
      keyOptions: VAULT_KEY_OPTIONS
    });

    this.#signSkey = await this.#currentVault.get('sign_skey');
    this.#cryptSkey = await this.#currentVault.get('crypt_skey');
    this.#evmSkey = await this.#currentVault.get('evm_skey');
    this.#contactSkey = await this.#currentVault.get('contact_skey');

    this.#signSkey = this.#normalizeKey(this.#signSkey);
    this.#cryptSkey = this.#normalizeKey(this.#cryptSkey);

    if (!(this.#signSkey instanceof Uint8Array)) {
      this.#signSkey = null;
      throw new Error('Failed to load secret key from vault');
    }

    if (this.#cryptSkey instanceof Uint8Array) {
      this.#cryptPubKey = identity.crypt_pkey;
    } else {
      console.warn('Crypt key not found in vault, avatar encryption will not work');
    }

    this.#currentUserHash = userHash;

    console.log(`Logged in: ${identity.name} (${userHash})`);

    this.#dispatchAuthChange();

    return identity;
  }

  async logout() {
    if (this.#signSkey) {
      this.#signSkey.fill(0);
      this.#signSkey = null;
    }
    if (this.#cryptSkey) {
      this.#cryptSkey.fill(0);
      this.#cryptSkey = null;
    }
    this.#evmSkey = null;
    this.#cryptPubKey = null;
    this.#currentUserHash = null;
    this.#currentVault = null;

    console.log('Logged out — secret key wiped');
    this.#dispatchAuthChange();
  }

  async deleteUserVault(userHash) {
    await this.#loadLocalUserCards();
    const identityIndex = this.#localUserCards.findIndex(i => i.user_hash === userHash);
    if (identityIndex === -1) {
      throw new Error(`User ${userHash} not found in local cards`);
    }
    const identity = this.#localUserCards[identityIndex];

    if (this.#currentUserHash === userHash) {
      await this.logout();
    }

    try {
      const vaultId = identity.vaultId;
      const vaultData = await this.#rawStore.get(`local-vault-${vaultId}`);
      
      const vaultToClear = await this.#connectToUserVault(vaultId);
      await vaultToClear.clear();

      if (vaultData && vaultData.accountID) {
        removeLocalAccount(vaultData.accountID);
      }
      await this.#rawStore.remove(`local-vault-${vaultId}`);
    } catch (e) {
      console.warn('Could not delete from local-vault', e);
    }

    this.#localUserCards.splice(identityIndex, 1);
    await this.#saveLocalUserCards();
    console.log(`Deleted user vault: ${userHash}`);
  }

  #normalizeKey(key) {
    if (!key) return null;
    if (key instanceof Uint8Array) return key;
    if (typeof key === 'object' && !ArrayBuffer.isView(key)) {
      return new Uint8Array(Object.values(key).map(v => Number(v)));
    }
    return null;
  }

  #dispatchAuthChange() {
    this.dispatchEvent(new CustomEvent('authChange', {
      detail: {
        isAuthenticated: this.isAuthenticated,
        userHash: this.#currentUserHash
      }
    }));
  }

  // Local Cards Methods

  async #loadLocalUserCards() {
    try {
      const data = await this.#rawStore.get('pq-vaults-registry');

      this.#localUserCards = Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('Failed to load local user cards:', err);

      this.#localUserCards = [];
    }
  }

  async #saveLocalUserCards() {
    try {
      await this.#rawStore.set('pq-vaults-registry', this.#localUserCards);
    } catch (err) {
      console.error('Failed to save local user cards:', err);
    }
  }

  async getLocalUserCards() {
    await this.#loadLocalUserCards();

    return [...this.#localUserCards];
  }

  // Re-push the current user's card (e.g. after a name change).
  pushCurrentUserCard() {
    const card = this.#localUserCards.find(u => u.user_hash === this.#currentUserHash);
    if (card) this.#pushOwnCard(card, { isUpdate: true });
  }

  // Sign Challenge

  async signChallenge(challenge) {
    if (!this.#signSkey) {
      throw new Error('Not authenticated or secret key not loaded');
    }

    let msg = typeof challenge === 'string'
      ? Uint8Array.from(atob(challenge), c => c.charCodeAt(0))
      : challenge;

    return ml_dsa87.sign(msg, this.#signSkey);
  }

  async signContactChallenge(challenge) {
    if (!this.#contactSkey) {
      throw new Error('Contact private key not loaded');
    }

    let msg = typeof challenge === 'string'
      ? hexToBytes(challenge)
      : challenge;

    const hash = sha256(msg);
    const signature = await secp.signAsync(hash, this.#contactSkey);
    return bytesToHex(signature.toCompactRawBytes());
  }

  async getEvmSkey() {
    return this.#evmSkey;
  }

  async exportVaultKeys() {
    if (!this.#currentVault) throw new Error('Vault not loaded');

    return {
      sign_skey: arrayToBase64(this.#signSkey),
      crypt_skey: arrayToBase64(this.#cryptSkey),
      evm_skey: this.#evmSkey,
      sign_pkey: this.#localUserCards.find(u => u.user_hash === this.#currentUserHash).sign_pkey,
      crypt_pkey: this.#localUserCards.find(u => u.user_hash === this.#currentUserHash).crypt_pkey
    };
  }

  async importVaultKeys(keys, identity) {
    if (!keys.evm_skey) {
      throw new Error('EVM key missing from backup. Cannot safely restore account.');
    }

    const userVault = await connect({
      storageType: 'idb',
      addNewVault: true,
      keyOptions: { ...VAULT_KEY_OPTIONS, username: identity.name, displayName: identity.name }
    });

    const signSkey = new Uint8Array(atob(keys.sign_skey).split('').map(c => c.charCodeAt(0)));
    const cryptSkey = new Uint8Array(atob(keys.crypt_skey).split('').map(c => c.charCodeAt(0)));

    await userVault.set(`sign_skey`, signSkey);
    await userVault.set(`crypt_skey`, cryptSkey);
    await userVault.set(`evm_skey`, keys.evm_skey);

    identity.vaultId = userVault.id;
    this.#localUserCards.push(identity);
    await this.#saveLocalUserCards();

    this.#pushOwnCard(identity, { signSkey });

    await this.login(identity.user_hash);
  }

  // Update User Storage

  async updateUserStorage({ name, notes, avatarUuid, avatarDataUrl }) {
    if (!this.#currentUserHash) {
      throw new Error('No user is currently logged in');
    }
    if (!this.#cryptSkey) {
      throw new Error('Crypt key not loaded');
    }

    // 1. Encrypt profile and save to DB
    const profileJson = JSON.stringify({ name, notes, avatarUuid });
    const profileData = new TextEncoder().encode(profileJson);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedData = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await this.#deriveKeyFromCryptSkey(),
      profileData
    );

    const ivData = new Uint8Array([...iv, ...new Uint8Array(encryptedData)]);
    const combined = arrayToBase64(ivData);

    // Profile is a user-visible "saved" action: wait for the server verdict
    // instead of reporting success while the write silently stays local-only.
    const profileWrite = await upsertStorageRow({
      userHash: this.#currentUserHash,
      uuid: STORAGE_SLOTS.profile,
      valueB64: combined,
      hashB64: bytesToHex(sha256(new Uint8Array(encryptedData))),
      signSkey: this.#signSkey,
    });
    const profileSync = await profileWrite.sync;
    if (profileSync.status === 'failed') {
      throw new Error('Profile saved locally but failed to sync to the server');
    }

    // 2. Update local cards
    const idx = this.#localUserCards.findIndex(u => u.user_hash === this.#currentUserHash);
    if (idx === -1) {
      throw new Error('User not found in local cards');
    }

    const current = this.#localUserCards[idx];

    this.#localUserCards[idx] = {
      ...current,
      name: name !== undefined ? name : current.name,
      avatar: avatarDataUrl !== undefined ? avatarDataUrl : current.avatar,
      userStorage: {
        ...current.userStorage,
        notes: notes !== undefined ? notes : current.userStorage?.notes,
        avatarUuid: avatarUuid !== undefined ? avatarUuid : current.userStorage?.avatarUuid
      }
    };

    await this.#saveLocalUserCards();

    const updated = this.#localUserCards[idx];
    const cardChanged = (
      (name !== undefined && name !== current.name) ||
      current.sign_pkey !== updated.sign_pkey ||
      current.crypt_pkey !== updated.crypt_pkey ||
      current.crypt_cert !== updated.crypt_cert ||
      current.contact_pkey !== updated.contact_pkey ||
      current.contact_cert !== updated.contact_cert
    );

    if (cardChanged) {
      this.#pushOwnCard(updated, { isUpdate: true });
    }

    return updated;
  }

  async loadUserProfile() {
    if (!this.#currentUserHash) throw new Error('No user is currently logged in');
    if (!this.#cryptSkey) return null;

    const storage = await getStorageRow(this.#currentUserHash, STORAGE_SLOTS.profile);
    if (!storage || !storage.value_b64) return null;

    const combined = decodeHexOrBase64(storage.value_b64);

    const iv = combined.slice(0, 12);
    const encryptedData = combined.slice(12);

    try {
      const decryptedData = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        await this.#deriveKeyFromCryptSkey(),
        encryptedData
      );
      return JSON.parse(new TextDecoder().decode(decryptedData));
    } catch (e) {
      console.error('Failed to decrypt profile:', e);
      return null;
    }
  }

  // Contacts Encryption

  async updateContacts(contactsArray) {
    if (!this.#currentUserHash) throw new Error('No user is currently logged in');
    if (!this.#cryptSkey) throw new Error('Crypt key not loaded');

    const contactsJson = JSON.stringify(contactsArray);
    const contactsData = new TextEncoder().encode(contactsJson);

    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encryptedData = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await this.#deriveKeyFromCryptSkey(),
      contactsData
    );

    const ivData = new Uint8Array([...iv, ...new Uint8Array(encryptedData)]);
    const combined = arrayToBase64(ivData);

    const contactsWrite = await upsertStorageRow({
      userHash: this.#currentUserHash,
      uuid: STORAGE_SLOTS.contacts,
      valueB64: combined,
      hashB64: bytesToHex(sha256(new Uint8Array(encryptedData))),
      signSkey: this.#signSkey,
    });
    const contactsSync = await contactsWrite.sync;
    if (contactsSync.status === 'failed') {
      throw new Error('Contacts saved locally but failed to sync to the server');
    }

    return true;
  }

  async loadContacts() {
    if (!this.#currentUserHash) throw new Error('No user is currently logged in');
    if (!this.#cryptSkey) return [];

    const storage = await getStorageRow(this.#currentUserHash, STORAGE_SLOTS.contacts);
    if (!storage || !storage.value_b64) return [];

    const combined = decodeHexOrBase64(storage.value_b64);

    const iv = combined.slice(0, 12);
    const encryptedData = combined.slice(12);

    try {
      const decryptedData = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        await this.#deriveKeyFromCryptSkey(),
        encryptedData
      );
      return JSON.parse(new TextDecoder().decode(decryptedData));
    } catch (e) {
      console.error('Failed to decrypt contacts:', e);
      return [];
    }
  }

  // Avatar Encryption

  async encryptAndStoreAvatar(imageBlob) {
    console.log('encryptAndStoreAvatar:', { userHash: this.#currentUserHash, hasCryptSkey: !!this.#cryptSkey });

    if (!this.#currentUserHash) {
      throw new Error('No user is currently logged in');
    }

    if (!this.#cryptSkey) {
      console.error('Crypt key not loaded!');
      throw new Error('Crypt key not loaded');
    }

    const uuid = crypto.randomUUID();
    const arrayBuffer = await imageBlob.arrayBuffer();
    const imageData = new Uint8Array(arrayBuffer);

    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encryptedData = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await this.#deriveKeyFromCryptSkey(),
      imageData
    );

    const ivData = new Uint8Array([...iv, ...new Uint8Array(encryptedData)]);
    const combined = arrayToBase64(ivData);

    await upsertStorageRow({
      userHash: this.#currentUserHash,
      uuid,
      valueB64: combined,
      hashB64: bytesToHex(sha256(new Uint8Array(encryptedData))),
      signSkey: this.#signSkey,
    });

    return uuid;
  }

  async loadAvatar(uuid) {
    if (!this.#currentUserHash) {
      throw new Error('No user is currently logged in');
    }

    if (!this.#cryptSkey) {
      throw new Error('Crypt key not loaded');
    }

    const storage = await getStorageRow(this.#currentUserHash, uuid);
    if (!storage || !storage.value_b64) {
      return null;
    }

    const combined = decodeHexOrBase64(storage.value_b64);

    const iv = combined.slice(0, 12);
    const encryptedData = combined.slice(12);

    const decryptedData = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      await this.#deriveKeyFromCryptSkey(),
      encryptedData
    );

    return new Blob([decryptedData], { type: 'image/webp' });
  }

  async #deriveKeyFromCryptSkey() {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      this.#cryptSkey,
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new TextEncoder().encode('avatar-encryption'),
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
}
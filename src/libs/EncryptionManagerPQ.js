import { connect, rawStorage } from '@lo-fi/local-vault';
import '@lo-fi/local-vault/adapter/idb';
import { removeLocalAccount } from '@lo-fi/local-data-lock';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { randomBytes } from '@noble/post-quantum/utils.js';

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

  constructor() {
    super();

    console.log('Encryption manager created')

    if (EncryptionManagerPQ.instance) {
      return EncryptionManagerPQ.instance;
    }

    EncryptionManagerPQ.instance = this;

    this.#loadLocalUserCards()
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

  async createUserVault({ name, notes, avatar }) {
    const userVault = await connect({
      storageType: 'idb',
      addNewVault: true,
      keyOptions: VAULT_KEY_OPTIONS
    });

    const seed = randomBytes(32);

    const { publicKey, secretKey } = ml_dsa87.keygen(seed);

    const prefixed = new Uint8Array([1, ...publicKey]);

    const userHash = bytesToHex(sha3_512(prefixed));

    await userVault.set(`sign_skey`, secretKey);

    const identity = {
      user_hash: userHash,
      vaultId: userVault.id,
      name,
      sign_pkey: bytesToHex(publicKey),

      userStorage: {
        avatar,
        notes
      }
    };

    this.#localUserCards.push(identity);

    await this.#saveLocalUserCards();

    await this.login(userHash);

    return identity;
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

    if (this.#signSkey && typeof this.#signSkey === 'object' && !ArrayBuffer.isView(this.#signSkey)) {
      const values = Object.values(this.#signSkey).map(v => Number(v));
      this.#signSkey = new Uint8Array(values);
    }

    if (!(this.#signSkey instanceof Uint8Array)) {
      this.#signSkey = null;
      throw new Error('Failed to load secret key from vault');
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
    this.#currentUserHash = null;
    this.#currentVault = null;

    console.log('Logged out — secret key wiped');
    this.#dispatchAuthChange();
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
}
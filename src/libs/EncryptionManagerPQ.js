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
import { sendMutationsAndAwaitShape, drainPendingWrites, stopDrainLoop } from '@/lib/data/ingest';
import { startLeaderElection, stopLeaderElection, onOutboxWake } from '@/lib/data/outbox';
import { recoverIntents } from '@/lib/data/intentRecovery';
import { nextOwnerTimestamp } from '@/lib/data/time';
import { freshestOf, getAccepted, recordAccepted } from '@/lib/data/acceptedSnapshot';
import { getUserCardsCollection } from '@/lib/data/collections';
import { readShapeOnce } from '@/lib/data/shapeRead';
import { getStorageRow, putStorageRow, putStorageJsonPatch } from '@/lib/data/userStorage';
import { setStorageJsonCodec } from '@/lib/data/storageIntent';
import { kvGet, kvSet, kvDelete } from '@/lib/data/localStore';
import { publishVault } from '@/lib/recovery/vault';
import { resetUserStorageCollection } from '@/lib/data/collections';
import { clearReadCache } from '@/lib/data/readCache';
import { clearDialogCache } from '@/lib/data/dialogCache';
import { deriveRootSlotUuid, randomSlotUuid } from '@/lib/pq/slotId';
import { createSlotResolver } from '@/lib/data/slots';

const VAULT_KEY_OPTIONS = {
  // Only the fields local-data-lock's getLockKey() actually reads survive the
  // trip (relyingParty*, username/displayName, addNewPasskey, …). WebAuthn
  // registration options like authenticatorSelection are silently dropped by
  // the library — they are enforced by the credentials.create wrapper below.
}

// The vault's lock-key seed lives inside the passkey's userHandle, and only a
// discoverable (resident) credential returns the userHandle on auth. A
// server-side credential logs in once — registration still has the seed in
// memory — and then locks the account out forever with "did not provide a
// valid encryption/decryption key". Platform authenticators make passkeys
// discoverable voluntarily, which masks this; security keys and strict
// implementations do not. local-data-lock gives no way to pass
// authenticatorSelection through, so it is enforced here: a passkey that
// cannot hold the seed must fail at registration, not at the next login.
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

/**
 * Class for managing encryption and data storage.
 * Implements the Singleton pattern to ensure a single instance.
 * Added support for events via EventTarget.
 * Supports two separate vaults: one for PQ signing keys and one for chat data.
 */
export class EncryptionManagerPQ extends EventTarget {
  static instance = null;
  static #cardQueues = new Map();
  static #acceptedCardCache = new Map();

  #rawStore = rawStorage('idb');
  #currentVault = null;

  #localUserCards = []
  #currentUserHash = null;
  #signSkey = null;
  #cryptSkey = null;
  #slotResolver = null;
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

  // Publishing the public user card. Awaited, not fire-and-forget: the
  // backend refuses a user_storage write until the card exists, so
  // registration would race its own profile save. Serialized per user_hash
  // and monotonic, because the server rejects a card update whose timestamp
  // is not strictly newer than the stored one — user_cards carries no
  //
  // Insert vs update is decided by asking the server, not by the caller or
  // local state: the server can forget a card (a wipe, a restore, a fresh
  // Pi) while local caches still hold it, and an update of a missing row is
  // rejected. `isUpdate` is only the fallback when that read fails.
  // `onlyIfMissing` makes it a no-op when the server already has the card.
  async #pushOwnCard(card, { isUpdate = false, signSkey = null, onlyIfMissing = false } = {}) {
    const key = signSkey || this.#signSkey;
    if (!key) throw new Error('No signing key for user card');

    const userHash = card.user_hash;
    const previous = EncryptionManagerPQ.#cardQueues.get(userHash) ?? Promise.resolve();
    const run = async () => {
      const onServer = await readShapeOnce('user_cards', `user_hash='${userHash}'`)
        .then((rows) => rows.length > 0)
        .catch(() => null);
      if (onlyIfMissing && onServer !== false) return null;
      const asUpdate = onServer ?? isUpdate;

      const sessionCard = EncryptionManagerPQ.#acceptedCardCache.get(userHash) ?? null;
      if (sessionCard) {
        try {
          await recordAccepted('user_cards', userHash, sessionCard, userHash);
        } catch {
        }
      }

      const serverCard = getUserCardsCollection().get(userHash);
      const acceptedCard = await getAccepted('user_cards', userHash, userHash);
      const baseCard = freshestOf(freshestOf(serverCard, acceptedCard), sessionCard);
      const ownerTimestamp = nextOwnerTimestamp(baseCard?.owner_timestamp);

      const { mutation } = api.createUserCard(card.name || 'User', {
        user_hash: userHash,
        sign_pkey: decodeHexOrBase64(card.sign_pkey),
        contact_pkey: decodeHexOrBase64(card.contact_pkey),
        contact_cert: decodeHexOrBase64(card.contact_cert),
        crypt_pkey: decodeHexOrBase64(card.crypt_pkey),
        crypt_cert: decodeHexOrBase64(card.crypt_cert),
        sign_skey: key,
      }, asUpdate ? 'update' : 'insert', ownerTimestamp);
      const signedRow = mutation.modified ?? mutation.changes;

      // Best-effort durability: card publication runs while the vault may
      // still be locked (no key to encrypt the outbox with), and a lost card
      // write is recoverable — the identity republishes on the next login.
      const unlocked = this.#currentUserHash === userHash;
      const handle = await sendMutationsAndAwaitShape([mutation], key, {
        durability: 'best-effort',
        recordAcceptedSnapshot: unlocked,
      });
      const outcome = handle.phase === 'accepted' ? { kind: 'accepted' } : await handle.acceptance;
      if (outcome.kind !== 'accepted') {
        const reason = outcome.kind === 'rejected' ? outcome.error : 'discarded before delivery';
        throw new Error(`User card ${asUpdate ? 'update' : 'creation'} was not accepted: ${reason}`);
      }
      EncryptionManagerPQ.#acceptedCardCache.set(userHash, signedRow);
      if (unlocked) await this.#recordSessionCard(userHash);
      return handle;
    };

    const next = previous.then(run, run);
    const settled = next.then(() => undefined, () => undefined);
    EncryptionManagerPQ.#cardQueues.set(userHash, settled);
    settled.then(() => {
      if (EncryptionManagerPQ.#cardQueues.get(userHash) === settled) {
        EncryptionManagerPQ.#cardQueues.delete(userHash);
      }
    });
    return next;
  }

  /** @returns {EncryptionManagerPQ} always lazily initialized, never null. */
  static getInstance() {
    if (!EncryptionManagerPQ.instance) {
      EncryptionManagerPQ.instance = new EncryptionManagerPQ();
    }

    return EncryptionManagerPQ.instance;
  }

  static _clearAcceptedCardCacheForTests() {
    EncryptionManagerPQ.#acceptedCardCache.clear();
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

    startLeaderElection(userHash, () => drainPendingWrites(userHash, signSkey));

    // The backend refuses a user_storage write until this card exists, so
    // the profile save below must not start before it is accepted.
    await this.#pushOwnCard({ ...identity, name }, { signSkey });

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
    // This class is a singleton, so the resolver cache and the storage
    // collection outlive any one session. Signing in without a logout first —
    // an account switch — would otherwise resolve this account's slot names
    // against the previous account's addresses.
    this.#slotResolver = null;
    resetUserStorageCollection();
    if (this.#currentUserHash !== null && this.#currentUserHash !== userHash) {
      await this.#clearAccountReadCache();
    }

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
      // isAuth is currentUserHash && signSkey: leaving the hash set with the
      // key gone would strand the app half-logged-in — and this is the one
      // state change in the file listeners would otherwise never hear about.
      this.#signSkey = null;
      this.#currentUserHash = null;
      this.#dispatchAuthChange();
      throw new Error('Failed to load secret key from vault');
    }

    if (this.#cryptSkey instanceof Uint8Array) {
      this.#cryptPubKey = identity.crypt_pkey;
    } else {
      console.warn('Crypt key not found in vault, avatar encryption will not work');
    }

    this.#currentUserHash = userHash;

    setStorageJsonCodec({
      decrypt: (valueB64) => this.#decryptJson(valueB64),
      encrypt: (value) => this.#encryptJson(value),
    });

    console.log(`Logged in: ${identity.name} (${userHash})`);

    await this.#recordSessionCard(userHash);

    this.#dispatchAuthChange();

    // Writes queued before a reload/crash can replay now that the signing key
    // is available again. Background: a slow drain must not delay login.
    this.#startOutboxDrain();

    // Background, like the drain: a card the server lost is republished here.
    this.#pushOwnCard(identity, { signSkey: this.#signSkey, onlyIfMissing: true })
      .catch((e) => console.warn('[EncryptionManagerPQ] card republication failed:', e?.message ?? e));

    return identity;
  }

  // Replays the durable outbox for the logged-in account: once right away,
  // and again whenever connectivity returns. The listener is bound to the
  // account and dropped on logout — entries signed by another user must not
  // be replayed with this session's auth.
  #outboxOnlineListener = null;
  #outboxWakeUnsubscribe = null;

  #recoverIntents(userHash, signSkey) {
    Promise.all([
      import('@/lib/data/messageIntent'),
      import('@/lib/data/storageIntent'),
    ]).then(([{ materializeMessageIntent }, { materializeStorageIntent }]) =>
      recoverIntents(userHash, signSkey, {
        materializeMessage: materializeMessageIntent,
        materializeStorage: materializeStorageIntent,
      })
    ).catch((e) =>
      console.warn('[EncryptionManagerPQ] intent recovery failed:', e)
    );
  }

  #startOutboxDrain() {
    const userHash = this.#currentUserHash;
    const signSkey = this.#signSkey;
    if (!userHash || !signSkey) return;

    this.#stopOutboxDrain();
    startLeaderElection(userHash, () => drainPendingWrites(userHash, signSkey));

    this.#recoverIntents(userHash, signSkey);
    drainPendingWrites(userHash, signSkey);

    this.#outboxOnlineListener = () => {
      drainPendingWrites(userHash, signSkey);
      this.#recoverIntents(userHash, signSkey);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.#outboxOnlineListener);
    }
    this.#outboxWakeUnsubscribe = onOutboxWake((wokenUserHash) => {
      if (wokenUserHash === userHash) {
        drainPendingWrites(userHash, signSkey);
        this.#recoverIntents(userHash, signSkey);
      }
    });
  }

  #stopOutboxDrain() {
    stopDrainLoop();
    stopLeaderElection();
    if (this.#outboxOnlineListener && typeof window !== 'undefined') {
      window.removeEventListener('online', this.#outboxOnlineListener);
    }
    this.#outboxOnlineListener = null;
    this.#outboxWakeUnsubscribe?.();
    this.#outboxWakeUnsubscribe = null;
  }

  async #clearAccountReadCache() {
    await clearReadCache({ keep: ['user_cards'] }).catch((e) => console.warn('[EncryptionManagerPQ] read-cache clear failed:', e));
    await clearDialogCache();
  }

  async #recordSessionCard(userHash) {
    const card = EncryptionManagerPQ.#acceptedCardCache.get(userHash);
    if (!card || this.#currentUserHash !== userHash) return;
    try {
      await recordAccepted('user_cards', userHash, card, userHash);
    } catch (e) {
      console.warn('[EncryptionManagerPQ] could not record accepted card snapshot locally (session-local continuation still covers this account):', e);
    }
  }

  async logout() {
    const hadActiveAccount = this.#currentUserHash !== null;
    this.#stopOutboxDrain();
    setStorageJsonCodec(null);
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
    // Slot addresses and the storage shape belong to the account that just
    // left; carrying either into the next login would point at its rows.
    this.#slotResolver = null;
    resetUserStorageCollection();

    if (hadActiveAccount) await this.#clearAccountReadCache();

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
        isAuthenticated: this.isAuth,
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
  async pushCurrentUserCard() {
    const card = this.#localUserCards.find(u => u.user_hash === this.#currentUserHash);
    if (!card) return;
    return this.#pushOwnCard(card, { isUpdate: true });
  }

  /**
   * Rename: local vault registry and the public card are one logical
   * operation. Doing only half of it let the persisted registry keep the old
   * name and silently revert it on the next login.
   */
  async updateOwnUserCardName(newName) {
    const idx = this.#localUserCards.findIndex(u => u.user_hash === this.#currentUserHash);
    if (idx === -1) throw new Error('User not found in local identities');

    this.#localUserCards[idx] = { ...this.#localUserCards[idx], name: newName };
    await this.#saveLocalUserCards();
    await this.#pushOwnCard(this.#localUserCards[idx], { isUpdate: true });
    return this.#localUserCards[idx];
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

    // contact_skey is the secp256k1 key behind signContactChallenge — the
    // optical handshake. Without it an imported account cannot add a contact
    // in person, so a backup is refused without it, on both sides.
    return {
      sign_skey: arrayToBase64(this.#signSkey),
      crypt_skey: arrayToBase64(this.#cryptSkey),
      evm_skey: this.#evmSkey,
      contact_skey: this.#contactSkey,
      sign_pkey: this.#localUserCards.find(u => u.user_hash === this.#currentUserHash).sign_pkey,
      crypt_pkey: this.#localUserCards.find(u => u.user_hash === this.#currentUserHash).crypt_pkey
    };
  }

  async importVaultKeys(keys, identity) {
    if (!keys.evm_skey) {
      throw new Error('EVM key missing from backup. Cannot safely restore account.');
    }
    // Minting a replacement would re-certify the card with a key no other
    // device of this account holds, and break every handshake those devices
    // start. No backward compatibility is owed (CLAUDE.md): a backup written
    // before the key was exported is test data.
    if (!keys.contact_skey) {
      throw new Error('Contact key missing from backup. Cannot safely restore account.');
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
    await userVault.set(`contact_skey`, keys.contact_skey);

    identity.vaultId = userVault.id;
    this.#localUserCards.push(identity);
    await this.#saveLocalUserCards();

    // Same dependency as registration: the card may not exist on this Pi yet.
    // Not fatal: the vault and the local card are complete, and a card write
    // lost here is republished on the next login. Failing the import instead
    // would leave an account that is here but cannot be imported again.
    try {
      await this.#pushOwnCard(identity, { signSkey });
    } catch (e) {
      console.warn('[EncryptionManagerPQ] card publication deferred to next login:', e?.message ?? e);
    }

    await this.login(identity.user_hash);
  }


  // ---------- user_storage slots ----------
  //
  // The root record sits at an address derived from crypt_skey and holds the
  // profile plus the map of every other slot (lib/pq/slotId). Only this one
  // address is derivable; the rest are random and found through the map.

  #rootSlotUuid() {
    return deriveRootSlotUuid(this.#cryptSkey);
  }

  async #encryptJson(value) {
    const data = new TextEncoder().encode(JSON.stringify(value));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await this.#deriveKeyFromCryptSkey(),
      data
    );
    return {
      valueB64: arrayToBase64(new Uint8Array([...iv, ...new Uint8Array(encrypted)])),
      hashB64: bytesToHex(sha256(new Uint8Array(encrypted))),
    };
  }

  async #decryptJson(valueB64) {
    const combined = decodeHexOrBase64(valueB64);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: combined.slice(0, 12) },
      await this.#deriveKeyFromCryptSkey(),
      combined.slice(12)
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
  }

  /**
   * Decrypted root record, or null when this account has none yet. A row that
   * is there but does not decrypt is null for a reader and an error for a
   * writer: a patch built on that null would sign a root with no slot map.
   */
  async #readRoot({ strict = false } = {}) {
    const row = await getStorageRow(this.#currentUserHash, this.#rootSlotUuid());
    if (!row || !row.value_b64) return null;
    try {
      return await this.#decryptJson(row.value_b64);
    } catch (e) {
      if (strict) throw new Error('The account record on the server cannot be read; nothing was written', { cause: e });
      console.error('Failed to decrypt the user_storage root record:', e);
      return null;
    }
  }

  // Root writes are JSON-patch intents (storageIntent.ts): the patch is merged
  // onto the base the signer actually uses, so a field another device wrote
  // in between survives without a read-modify-write here. Resolves only once
  // the server has the revision; a locally kept intent is not a save.
  async #writeRootPatch(patch) {
    await putStorageJsonPatch({
      userHash: this.#currentUserHash,
      uuid: this.#rootSlotUuid(),
      jsonPatch: patch,
      signSkey: this.#signSkey,
    });
  }

  async #writeSlotRow(uuid, valueB64, hashB64) {
    await putStorageRow({
      userHash: this.#currentUserHash,
      uuid,
      valueB64,
      hashB64,
      signSkey: this.#signSkey,
    });
  }

  /** Signed tombstone; deletion is a revision like any other and fails like one. */
  async #tombstoneRow(uuid) {
    await putStorageRow({
      userHash: this.#currentUserHash,
      uuid,
      valueB64: '',
      hashB64: null,
      signSkey: this.#signSkey,
      deletedFlag: true,
    });
  }

  /** Tombstone for a slot row another client's map won over. */
  async #tombstoneSlotRow(uuid) {
    try {
      await this.#tombstoneRow(uuid);
    } catch (e) {
      // The row is already unreferenced; failing to mark it is not worth
      // failing the user's save over.
      console.warn(`Could not tombstone orphaned slot row ${uuid}:`, e);
    }
  }

  #slots() {
    if (!this.#slotResolver) {
      this.#slotResolver = createSlotResolver({
        read: () => this.#readRoot(),
        write: (patch) => this.#writeRootPatch(patch),
      });
    }
    return this.#slotResolver;
  }

  /** Address of a named slot, or null when it has never been created. */
  async #slotUuid(name) {
    return this.#slots().getSlotUuid(name);
  }

  #pendingSlotMintKey(name) {
    return `pending-slot-mint|${this.#currentUserHash}|${name}`;
  }

  /**
   * Writes a named slot, creating it on first use. The slot row lands before
   * the map entry that names it, so a failure between the two leaves an
   * unreferenced row rather than a map pointing at nothing.
   */
  async #writeSlot(name, valueB64, hashB64) {
    const { uuid, orphaned } = await this.#slots().ensureSlotUuid(name, {
      mint: randomSlotUuid,
      writeRow: (uuid) => this.#writeSlotRow(uuid, valueB64, hashB64),
      recallPendingMint: () => kvGet(this.#pendingSlotMintKey(name)),
      rememberPendingMint: (uuid) => kvSet(this.#pendingSlotMintKey(name), uuid),
      forgetPendingMint: () => kvDelete(this.#pendingSlotMintKey(name)),
    });
    if (orphaned) {
      await this.#tombstoneSlotRow(orphaned);
      await this.#writeSlotRow(uuid, valueB64, hashB64);
    }
  }

  /**
   * Seals the account under a wrap key and publishes it where only that key
   * can find it (lib/recovery/vault). The root record names the current vault
   * and every earlier one not yet retired: the keys inside never change, so a
   * vault left live would keep an old set of shares able to open the account,
   * and a tombstone that fails is kept on the list for the next attempt
   * rather than forgotten.
   *
   * Vault first, root second, tombstones last. A crash before the root write
   * leaves the new vault live and unreferenced, which is safe only because
   * its key is never shown before this returns (userPQ.store
   * createRecoveryBackup); a failure after the root write leaves the previous
   * backup usable, since nothing is retired until the new one is on record.
   */
  async publishRecoveryVault(wrapKey, json) {
    const userHash = this.#currentUserHash;
    if (!userHash || !this.#signSkey || !this.#cryptSkey) {
      throw new Error('No user is currently logged in');
    }
    // Each root patch is signed with whatever account is current when it is
    // written; one switched in between would get this account's vault list.
    const sameAccount = () => {
      if (this.#currentUserHash !== userHash) throw new Error('The account changed while the backup was being written');
    };
    // A root that is there but does not decrypt would fail the patch only
    // after the vault is already live; refuse before publishing anything.
    await this.#readRoot({ strict: true });
    const uuid = await publishVault({ userHash, signSkey: this.#signSkey, wrapKey, json });
    sameAccount();
    // Only the address: mergeJsonPatch moves the vault it replaces onto
    // staleVaults against the base the patch actually lands on.
    await this.#writeRootPatch({ vaultUuid: uuid });
    await this.#retireStaleVaults(sameAccount);
  }

  /** Tombstones every vault the root lists as retired-pending; the ones that
   * fail stay listed for the next attempt, and the failure is reported. */
  async #retireStaleVaults(check) {
    check();
    const root = (await this.#readRoot({ strict: true })) || {};
    const retired = [];
    let failure = null;
    for (const uuid of root.staleVaults ?? []) {
      try {
        await this.#tombstoneRow(uuid);
        retired.push(uuid);
      } catch (e) {
        failure = e;
      }
    }
    if (retired.length) {
      check();
      await this.#writeRootPatch({ retiredVaults: retired });
    }
    if (failure) throw new Error('An earlier backup could not be retired; create the backup again to retry.', { cause: failure });
  }

  // Update User Storage

  async updateUserStorage({ name, notes, avatarUuid, avatarDataUrl }) {
    if (!this.#currentUserHash) {
      throw new Error('No user is currently logged in');
    }
    if (!this.#cryptSkey) {
      throw new Error('Crypt key not loaded');
    }

    // 1. Encrypt profile and save to DB.
    // A field left undefined here (e.g. avatarUuid on a plain name/notes
    // save) must be omitted from the patch, not written as undefined — a
    // full-record spread would have serialized it away and silently erased
    // the existing value. Merging (storageIntent.ts's mergeJsonPatch) also
    // means the slot map, the vault's address and any other field written by
    // another device concurrently is preserved rather than needing a fresh
    // read here.
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (notes !== undefined) patch.notes = notes;
    if (avatarUuid !== undefined) patch.avatarUuid = avatarUuid;
    // Profile is a user-visible "saved" action: #writeRootPatch waits for the
    // server verdict instead of reporting success while the write stays local.
    await this.#writeRootPatch(patch);

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
      await this.#pushOwnCard(updated, { isUpdate: true });
    }

    return updated;
  }

  async loadUserProfile() {
    if (!this.#currentUserHash) throw new Error('No user is currently logged in');
    if (!this.#cryptSkey) return null;

    // Read only. Materializing an empty root record here would be a write on
    // the read path, and on a second device a losing one: before the shape
    // delivers the existing row, getServerState honestly reports "absent", so
    // the empty record would go out with a fresh owner_timestamp and beat the
    // real profile under last-write-wins. The root record is created by the
    // write paths instead.
    const root = await this.#readRoot();
    if (!root) return null;
    // A root record holding only the slot map is not a profile: the account
    // created a slot before ever saving one.
    if (root.name === undefined && root.notes === undefined && root.avatarUuid === undefined) {
      return null;
    }
    return root;
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

    await this.#writeSlot('contacts', combined, bytesToHex(sha256(new Uint8Array(encryptedData))));

    return true;
  }

  async loadContacts() {
    if (!this.#currentUserHash) throw new Error('No user is currently logged in');
    if (!this.#cryptSkey) return [];

    // No slot yet means this account has never saved contacts. Reading must
    // not create one: doing so on a transient failure to load the map would
    // start a second, empty contacts row alongside the real one.
    const contactsUuid = await this.#slotUuid('contacts');
    if (!contactsUuid) return [];

    const storage = await getStorageRow(this.#currentUserHash, contactsUuid);
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

    // The caller publishes this uuid inside the profile revision, so the
    // avatar must be accepted by the server FIRST — otherwise a profile can
    // sync successfully while pointing at an avatar row that never landed,
    // and another device renders a broken reference.
    await this.#writeSlotRow(uuid, combined, bytesToHex(sha256(new Uint8Array(encryptedData))));

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
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
import { drainPendingWrites, resumePendingWrites, stopDrainLoop, deliverStoredWrite, IngestError, DurabilityError } from '@/lib/data/ingest';
import {
  storeUserCardIntentUnderLock, storeCardIntentUnderLock, withCardLock, decideCardConstruction, acceptedCardTimestamp,
  BootstrapCardRejectedError, CardAuthoringBlockedError,
} from '@/lib/data/userCardIntent';
import { VaultLockedError } from '@/lib/data/keyCustody';
import {
  startLeaderElection, stopLeaderElection, currentSessionUserHash, onOutboxWake, onOutboxChange, awaitServerAccepted, awaitDeliveryVerdict,
  currentSessionToken, sameSessionToken,
} from '@/lib/data/outbox';
import { recoverIntents, signAndDispatchIntent } from '@/lib/data/intentRecovery';
import { requestContactAccess, applyContactAccessIntent } from '@/lib/data/contactVouches';
import { getStorageRow, putStorageRow, putStorageJsonPatch, saveStorageJsonPatch } from '@/lib/data/userStorage';
import { setStorageJsonCodec } from '@/lib/data/storageIntent';
import { kvGet, kvSet, kvDelete } from '@/lib/data/localStore';
import { publishVault } from '@/lib/recovery/vault';
import { newMetaSeed } from '@/lib/recovery/guardianInvite';
import { resetUserStorageCollection } from '@/lib/data/collections';
import { clearReadCache } from '@/lib/data/readCache';
import { clearDialogCache } from '@/lib/data/dialogCache';
import { forgetAccountAvatars } from '@/lib/avatars/localStore';
import { clearSessions } from '@/lib/data/readSession';
import { resetGate } from '@/lib/data/accessGate';
import { deriveRootSlotUuid, randomSlotUuid } from '@/lib/pq/slotId';
import { createSlotResolver } from '@/lib/data/slots';

const CONTACT_ACCESS_RETRY_MS = 5_000;
const CONTACT_ACCESS_RETRY_MAX_MS = 60_000;
const CONTACT_ACCESS_HURRY_MS = 500;

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

class VaultKeyError extends Error {}

/** What an account's vault holds that must be gone once it is destroyed (destroyUserVault). */
export class LocalVaultMissingError extends VaultKeyError {
  constructor() {
    super('This account is listed on this device, but its encrypted keys are missing. Restore it from a backup or another device.');
    this.name = 'LocalVaultMissingError';
  }
}

export class AccountPasskeyMismatchError extends VaultKeyError {
  constructor() {
    super('The selected passkey belongs to a different account. Choose the passkey for this account.');
    this.name = 'AccountPasskeyMismatchError';
  }
}

class CardNotDurableError extends Error {
  constructor(cause) {
    super(cause?.message ?? String(cause));
    this.name = 'CardNotDurableError';
    this.cause = cause;
  }
}

export class LoginDeferredError extends Error {
  constructor(userHash, cause) {
    super('Your profile card could not be published yet, so this account cannot be opened right now. Try signing in again when you are online.');
    this.name = 'LoginDeferredError';
    this.userHash = userHash;
    this.cause = cause;
  }
}

export class AccountImportIncompleteError extends Error {
  constructor(userHash, cause) {
    super('The account was restored on this device, but its profile card could not be saved for publishing — nothing was sent. Import it again to finish.');
    this.name = 'AccountImportIncompleteError';
    this.userHash = userHash;
    this.cause = cause;
  }
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
  #bootstrapUserHash = null;
  #sessionEnded = null;
  #signSkey = null;
  #cryptSkey = null;
  #slotResolver = null;
  #contactSkey = null;
  #evmSkey = null;
  // The guardian meta seed (pq_recovery_shares § Inviting, The keys), hex,
  // once read or made: guardianMetaSeed.
  #metaSeed = null;

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
  // registration would race its own profile save. Each call is one durable
  // card intent, signed once and stored before any request (userCardIntent):
  // a reload replays that exact snapshot, and the next change is a new intent
  // with a strictly newer owner_timestamp. Needs the account's keys open
  // locally — the intent and outbox stores are sealed with its key.
  //
  // Resolves 'accepted' once the server accepted the card. With
  // `deferDelivery`, resolves 'deferred' instead when the write is stored but
  // could not be delivered now (the outbox sends that same write later).
  // Throws on a rejection, and when the write could not be made durable —
  // with nothing stored, or with the signed snapshot kept out of the outbox.
  // Never reports either as deferred.
  //
  // `bootstrap` is 'register' or 'import': the account's first card, one
  // operation reused by every retry. Without it, an ordinary update.
  async #pushOwnCard(card, { deferDelivery = false, bootstrap = null } = {}) {
    const userHash = card.user_hash;
    if (this.localStorageOwnerHash !== userHash || !this.#signSkey) {
      throw new Error('User card publication needs the account\'s keys open on this device');
    }
    if (bootstrap) return this.#passBootstrapCard(userHash, { mode: bootstrap, card, deferDelivery });
    const signSkey = this.#signSkey;

    let stored = false;
    let outcome;
    try {
      // Under the account's card lock (this tab and every other) until the
      // signed snapshot is in the outbox, as for the bootstrap card: a later
      // card write — newer timestamp — can never be queued ahead of this one
      // and get it refused as not newer.
      const handle = await withCardLock(userHash, async () => {
        const { intentId, readyRow } = await storeUserCardIntentUnderLock(card);
        // The durable milestone: from here an unsigned or signed intent, or an
        // outbox entry, exists that recovery finishes.
        stored = true;
        return signAndDispatchIntent(intentId, readyRow, signSkey);
      });
      if (handle.phase === 'accepted') outcome = { kind: 'accepted' };
      else if (!handle.outboxId) outcome = await handle.acceptance;
      else outcome = deferDelivery
        ? await awaitDeliveryVerdict(handle.outboxId, userHash)
        : await awaitServerAccepted(handle.outboxId, userHash);
    } catch (e) {
      if (!stored) throw e;
      if (!deferDelivery || e instanceof DurabilityError || (e instanceof IngestError && e.permanent)) throw e;
      console.warn('[EncryptionManagerPQ] card write is stored; its delivery is deferred to the outbox:', e?.message ?? e);
      return 'deferred';
    }
    if (outcome.kind === 'retrying') return 'deferred';
    if (outcome.kind !== 'accepted') {
      const reason = outcome.kind === 'rejected' ? outcome.error : 'discarded before delivery';
      throw new Error(`User card update was not accepted: ${reason}`);
    }
    return 'accepted';
  }

  /** @returns {EncryptionManagerPQ} always lazily initialized, never null. */
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

  get localStorageOwnerHash() {
    return this.#bootstrapUserHash ?? this.#currentUserHash;
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

  async createUserVault({ name, notes }) {
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
    // The guardian meta seed is an account key like the others: made here, it
    // reaches every device the way they do (pq_recovery_shares § Inviting).
    await userVault.set(`meta_seed`, bytesToHex(newMetaSeed()));

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
    await this.#rawStore.set(`pq-vault-owner-${userVault.id}`, userHash);

    // Bootstrap: the keys open locally (the card intent and snapshot are
    // sealed with them), the card is published and accepted, and only then is
    // the session activated — the UI never sees an account whose prerequisite
    // card the server does not have yet.
    await this.#openForBootstrap(userHash);
    try {
      await this.#pushOwnCard({ ...identity, name }, { bootstrap: 'register' });
    } catch (e) {
      await this.#abortBootstrap();
      throw e;
    }
    this.#activateSession(userHash, identity);

    await this.updateUserStorage({ name, notes });

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
      await this.logout();
    }

    let identity;
    try {
      identity = await this.#openAccountLocally(userHash);
    } catch (e) {
      if (e instanceof VaultKeyError) {
        // isAuth is currentUserHash && signSkey: leaving the hash set with the
        // key gone would strand the app half-logged-in — and this is the one
        // state change in the file listeners would otherwise never hear about.
        this.#signSkey = null;
        this.#currentUserHash = null;
        this.#bootstrapUserHash = null;
        this.#sessionEnded?.abort();
        this.#sessionEnded = null;
        this.#dispatchAuthChange();
      }
      throw e;
    }
    try {
      startLeaderElection(userHash, () => {});
      const card = await this.#passBootstrapCard(userHash, { mode: 'sign-in', card: identity, deferDelivery: true });
      if (card === 'deferred') throw new LoginDeferredError(userHash);
    } catch (e) {
      await this.#abortBootstrap();
      throw e;
    }
    this.#activateSession(userHash, identity);
    return identity;
  }

  async recoverOwnCard(userHash) {
    const session = currentSessionToken();
    const sessionEnded = this.#sessionEnded?.signal;
    const current = () => this.#currentUserHash === userHash && sameSessionToken(session, currentSessionToken());
    if (!current() || !this.#signSkey || !sessionEnded) return 'stale';
    const card = this.#localUserCards.find(u => u.user_hash === userHash);
    if (!card) throw new Error(`User ${userHash} not found in local identities`);
    try {
      const acceptedAfter = await acceptedCardTimestamp(userHash);
      if (!current()) return 'stale';
      let storedId = null;
      const outcome = await this.#passBootstrapCard(userHash, {
        mode: 'recover', card, deferDelivery: true, acceptedAfter, session, onStored: (id) => { storedId = id; },
      });
      if (!current()) return 'stale';
      if (outcome === 'accepted') return 'accepted';
      if (!storedId) throw new Error('Your profile card could not be stored for delivery');
      drainPendingWrites(userHash, this.#signingKeyOf(userHash));
      const verdict = await awaitServerAccepted(storedId, userHash, { signal: sessionEnded });
      if (!current()) return 'stale';
      if (verdict.kind === 'accepted') return 'accepted';
      throw new BootstrapCardRejectedError(verdict.kind === 'rejected' ? verdict.error : 'discarded');
    } catch (e) {
      if (!current()) return 'stale';
      throw e;
    }
  }

  async #passBootstrapCard(userHash, { mode, card = null, deferDelivery = false, acceptedAfter = null, session = null, onStored = null }) {
    const signSkey = this.#signSkey;
    let locked = false;
    try {
      return await this.#passBootstrapCardLocked(userHash, signSkey, {
        mode, card, deferDelivery, acceptedAfter, session, onStored, onLocked: () => { locked = true; },
      });
    } catch (e) {
      if (!locked && mode === 'import') throw new CardNotDurableError(e);
      throw e;
    }
  }

  async #passBootstrapCardLocked(userHash, signSkey, { mode, card, deferDelivery, acceptedAfter, session, onStored, onLocked }) {
    return withCardLock(userHash, async () => {
      onLocked();
      let target;
      try {
        const decision = await decideCardConstruction(userHash, mode, { acceptedAfter });
        switch (decision.kind) {
          case 'proven': return 'accepted';
          case 'rejected': throw new BootstrapCardRejectedError(decision.reason);
          case 'blocked': throw new CardAuthoringBlockedError(decision.reason);
          case 'reuse-bootstrap': target = decision.operation; break;
          case 'author-bootstrap': {
            const { intentId, readyRow } = await storeCardIntentUnderLock(card, decision);
            target = { kind: 'intent', intentId, intent: readyRow };
            break;
          }
          default: throw new Error(`a bootstrap card cannot be decided as ${decision.kind}`);
        }
      } catch (e) {
        if (mode === 'import' && !(e instanceof BootstrapCardRejectedError)) throw new CardNotDurableError(e);
        throw e;
      }
      return this.#deliverBootstrapCard(userHash, target, signSkey, { deferDelivery, session, onStored });
    });
  }

  async #deliverBootstrapCard(userHash, target, signSkey, { deferDelivery, session = null, onStored = null }) {
    let outboxId = target.kind === 'stored' ? target.outboxId : null;
    if (outboxId) onStored?.(outboxId);
    try {
      if (target.kind === 'intent') {
        const handle = await signAndDispatchIntent(target.intentId, target.intent, signSkey, {
          bootstrap: true,
          ...(session ? { token: session } : {}),
          ...(onStored ? { onDurable: (id) => onStored(id) } : {}),
        });
        if (handle.phase === 'accepted') return 'accepted';
        outboxId = handle.outboxId;
        onStored?.(outboxId);
      }
      const verdict = deferDelivery
        ? await deliverStoredWrite(outboxId, userHash, signSkey)
        : await awaitServerAccepted(outboxId, userHash);
      if (verdict.kind === 'accepted') return 'accepted';
      if (verdict.kind === 'retrying') return 'deferred';
      throw new BootstrapCardRejectedError(verdict.kind === 'rejected' ? verdict.error : 'discarded');
    } catch (e) {
      if (e instanceof BootstrapCardRejectedError) throw e;
      if (e instanceof IngestError && e.permanent) throw new BootstrapCardRejectedError(e.message);
      if (!deferDelivery) throw e;
      console.warn('[EncryptionManagerPQ] bootstrap card is stored; its delivery is deferred to the next sign-in:', e?.message ?? e);
      return 'deferred';
    }
  }

  async #openAccountLocally(userHash) {
    await this.#loadLocalUserCards();

    const identity = this.#localUserCards.find(i => i.user_hash === userHash);

    if (!identity) throw new Error(`User ${userHash} not found in local identities`);

    // A card may retain an old vault ID while its passkey still opens a vault
    // on this device. Check before connecting: the adapter creates an empty
    // row for an unknown ID, which would hide the surviving vault.
    const vaultEntry = identity.vaultId
      ? await this.#rawStore.get(`local-vault-${identity.vaultId}`)
      : null;
    const discoverVault = !vaultEntry?.accountID || !vaultEntry?.data;
    let vault;
    if (discoverVault) {
      const vaultKeys = await this.#rawStore.keys();
      const [legacyCards, legacyCurrentVaultId] = await Promise.all([
        this.#rawStore.get('vaults-registry'),
        this.#rawStore.get('vault-id'),
      ]);
      const legacyVaultIds = new Set(Array.isArray(legacyCards)
        ? legacyCards.map(card => card.vaultId)
        : []);
      if (legacyCurrentVaultId) legacyVaultIds.add(legacyCurrentVaultId);
      const otherCardVaultIds = new Set(this.#localUserCards
        .filter(card => card.user_hash !== userHash)
        .map(card => card.vaultId));
      const candidateKeys = vaultKeys
        .filter(key => key.startsWith('local-vault-') &&
          key !== `local-vault-${identity.vaultId}` &&
          !otherCardVaultIds.has(key.slice('local-vault-'.length)) &&
          !legacyVaultIds.has(key.slice('local-vault-'.length)));
      const candidates = (await Promise.all(candidateKeys.map(async key => ({
        key,
        entry: await this.#rawStore.get(key),
        owner: await this.#rawStore.get(`pq-vault-owner-${key.slice('local-vault-'.length)}`),
      })))).filter(({ entry, owner }) => entry?.accountID && entry?.data && (owner === userHash || owner == null));
      if (!candidates.length) throw new LocalVaultMissingError();
      try {
        vault = candidates.length === 1
          ? await connect({ vaultID: candidates[0].key.slice('local-vault-'.length), storageType: 'idb', keyOptions: VAULT_KEY_OPTIONS })
          : await connect({ storageType: 'idb', discoverVault: true, keyOptions: VAULT_KEY_OPTIONS });
      } catch (e) {
        if (e?.message?.startsWith('No matching vault found in storage')) throw new LocalVaultMissingError();
        throw e;
      }
    } else {
      vault = await connect({ vaultID: identity.vaultId, storageType: 'idb', keyOptions: VAULT_KEY_OPTIONS });
    }

    const signSkey = this.#normalizeKey(await vault.get('sign_skey'));
    const cryptSkey = this.#normalizeKey(await vault.get('crypt_skey'));
    const evmSkey = await vault.get('evm_skey');
    const contactSkey = await vault.get('contact_skey');

    if (discoverVault) {
      const discoveredEntry = await this.#rawStore.get(`local-vault-${vault.id}`);
      if (!discoveredEntry?.accountID || !discoveredEntry?.data) throw new LocalVaultMissingError();
    }
    if (!(signSkey instanceof Uint8Array)) {
      if (discoverVault) throw new LocalVaultMissingError();
      throw new VaultKeyError('Failed to load secret key from vault');
    }

    if (discoverVault) {
      const matches = this.#signKeyMatchesIdentity(signSkey, identity);
      if (!matches) {
        try { await vault.lock?.(); } catch { /* The account binding still fails. */ }
        throw new AccountPasskeyMismatchError();
      }
      identity.vaultId = vault.id;
      await this.#saveLocalUserCards();
      await this.#rawStore.set(`pq-vault-owner-${vault.id}`, userHash);
    } else if (!(await this.#rawStore.get(`pq-vault-owner-${vault.id}`)) && this.#signKeyMatchesIdentity(signSkey, identity)) {
      await this.#rawStore.set(`pq-vault-owner-${vault.id}`, userHash);
    }

    this.#currentVault = vault;
    this.#signSkey = signSkey;
    this.#cryptSkey = cryptSkey;
    this.#evmSkey = evmSkey;
    this.#contactSkey = contactSkey;
    if (!(this.#cryptSkey instanceof Uint8Array)) {
      console.warn('Crypt key not found in vault, storage slots will not open');
    }
    this.#bootstrapUserHash = userHash;
    return identity;
  }

  #activateSession(userHash, identity) {
    this.#bootstrapUserHash = null;
    this.#currentUserHash = userHash;
    this.#sessionEnded?.abort();
    this.#sessionEnded = new AbortController();

    setStorageJsonCodec({
      decrypt: (valueB64) => this.#decryptJson(valueB64),
      encrypt: (value) => this.#encryptJson(value),
    });

    console.log(`Logged in: ${identity.name} (${userHash})`);

    this.#dispatchAuthChange();

    // Writes queued before a reload/crash can replay now that the signing key
    // is available again. Background: a slow drain must not delay login.
    this.#startOutboxDrain();
  }

  // Registration and import: open the account locally without activating it.
  // An active session of another account ends first — the stores can be
  // sealed for one account at a time. The outbox session is started for the
  // account (its card goes out through the outbox) without the general drain
  // or intent recovery, which wait for #activateSession.
  async #openForBootstrap(userHash) {
    if (this.#currentUserHash !== null) await this.logout();
    this.#slotResolver = null;
    resetUserStorageCollection();
    const identity = await this.#openAccountLocally(userHash);
    startLeaderElection(userHash, () => {});
    return identity;
  }

  async #abortBootstrap() {
    if (!this.#bootstrapUserHash || currentSessionUserHash() === this.#bootstrapUserHash) {
      stopDrainLoop();
      stopLeaderElection();
    }
    this.#signSkey?.fill?.(0);
    this.#cryptSkey?.fill?.(0);
    this.#signSkey = null;
    this.#cryptSkey = null;
    this.#evmSkey = null;
    this.#contactSkey = null;
    this.#metaSeed = null;
    this.#currentVault = null;
    this.#bootstrapUserHash = null;
  }

  // Replays the durable outbox for the logged-in account: once right away,
  // again whenever connectivity returns, and whenever the page comes back
  // into view — a backgrounded tab or installed app has its timers frozen,
  // so a retry scheduled while it was hidden may not have run (a server's
  // 5xx backoff stands then; only connection backoffs end). The listeners
  // are bound to the account and dropped on logout — entries signed by
  // another user must not be replayed with this session's auth.
  #outboxOnlineListener = null;
  #outboxVisibleListener = null;
  #outboxWakeUnsubscribe = null;
  #outboxChangeUnsubscribe = null;

  #signingKeyOf(userHash) {
    return async () => {
      if (this.#currentUserHash !== userHash || !(this.#signSkey instanceof Uint8Array)) {
        throw new VaultLockedError('the account\'s signing key is not open on this device');
      }
      return this.#signSkey;
    };
  }

  #recoverIntents(userHash) {
    const signingKey = this.#signingKeyOf(userHash);
    Promise.all([
      import('@/lib/data/messageIntent'),
      import('@/lib/data/storageIntent'),
    ]).then(([{ materializeMessageIntent }, { materializeStorageIntent }]) =>
      recoverIntents(userHash, signingKey, {
        materializeMessage: materializeMessageIntent,
        materializeStorage: materializeStorageIntent,
        applyContactAccess: async (entry) => this.#afterContactAccess(userHash, await applyContactAccessIntent(entry, this.#contactAccessSession(userHash))),
      })
    ).catch((e) =>
      console.warn('[EncryptionManagerPQ] intent recovery failed:', e)
    );
  }

  #startOutboxDrain() {
    const userHash = this.#currentUserHash;
    if (!userHash || !this.#signSkey) return;
    const signSkey = this.#signingKeyOf(userHash);

    this.#stopOutboxDrain();
    startLeaderElection(userHash, () => drainPendingWrites(userHash, signSkey));

    this.#recoverIntents(userHash);
    drainPendingWrites(userHash, signSkey);

    this.#outboxOnlineListener = () => {
      resumePendingWrites(userHash, signSkey);
      this.#recoverIntents(userHash);
    };
    this.#outboxVisibleListener = () => {
      if (document.visibilityState !== 'visible') return;
      resumePendingWrites(userHash, signSkey);
      this.#recoverIntents(userHash);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.#outboxOnlineListener);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#outboxVisibleListener);
    }
    this.#outboxChangeUnsubscribe = onOutboxChange((changedUserHash) => {
      if (changedUserHash === userHash && this.#contactAccessRetry) this.#hurryContactAccessRetry(userHash);
    });
    this.#outboxWakeUnsubscribe = onOutboxWake((wokenUserHash) => {
      if (wokenUserHash === userHash) {
        drainPendingWrites(userHash, signSkey);
        this.#recoverIntents(userHash);
      }
    });
  }

  #stopOutboxDrain() {
    stopDrainLoop();
    stopLeaderElection();
    if (this.#outboxOnlineListener && typeof window !== 'undefined') {
      window.removeEventListener('online', this.#outboxOnlineListener);
    }
    if (this.#outboxVisibleListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#outboxVisibleListener);
    }
    this.#outboxOnlineListener = null;
    this.#outboxVisibleListener = null;
    this.#outboxWakeUnsubscribe?.();
    this.#outboxWakeUnsubscribe = null;
    this.#outboxChangeUnsubscribe?.();
    this.#outboxChangeUnsubscribe = null;
    clearTimeout(this.#contactAccessRetry);
    this.#contactAccessRetry = null;
  }

  async #clearAccountReadCache() {
    await clearReadCache({ keep: ['user_cards'] }).catch((e) => console.warn('[EncryptionManagerPQ] read-cache clear failed:', e));
    await clearDialogCache();
  }

  async logout() {
    const hadActiveAccount = this.#currentUserHash !== null;
    this.#sessionEnded?.abort();
    this.#sessionEnded = null;
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
    this.#metaSeed = null;
    this.#currentUserHash = null;
    this.#bootstrapUserHash = null;
    this.#currentVault = null;
    // Slot addresses and the storage shape belong to the account that just
    // left; carrying either into the next login would point at its rows.
    this.#slotResolver = null;
    resetUserStorageCollection();
    clearSessions();
    resetGate();

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
      await this.#rawStore.remove(`pq-vault-owner-${vaultId}`);
    } catch (e) {
      console.warn('Could not delete from local-vault', e);
    }
    // Contacts' thumbnails and the dialogs owed a photo leave with the account.
    await forgetAccountAvatars(userHash).catch((e) => console.warn('Could not delete the account\'s photo records', e));

    this.#localUserCards.splice(identityIndex, 1);
    await this.#saveLocalUserCards();
    console.log(`Deleted user vault: ${userHash}`);
  }

  /**
   * Destroys an account on this device for good, or throws: its vault — the
   * keys, crypt_skey among them, and anything else kept beside them, such as a
   * recovery's candidate key — is cleared, and its row checked to be gone,
   * before the account's card goes. A vault that does not clear
   * leaves both in place, so the caller can try again; with `vaultId` it is
   * found even once the card is gone. The account signed in now, if another,
   * keeps its own vault open.
   */
  async destroyUserVault({ userHash, vaultId = null }) {
    await this.#loadLocalUserCards();
    const card = this.#localUserCards.find((i) => i.user_hash === userHash);
    const id = vaultId ?? card?.vaultId ?? null;
    if (this.#currentUserHash === userHash) await this.logout();
    if (id) {
      const stored = await this.#rawStore.get(`local-vault-${id}`);
      if (stored) {
        const vault = this.#currentVault?.id === id
          ? this.#currentVault
          : await connect({ vaultID: id, storageType: 'idb', keyOptions: VAULT_KEY_OPTIONS });
        await vault.clear();
        // A cleared vault has no row left; reading one would write an empty row
        // back and ask for a passkey, so the row is what is checked.
        if ((await this.#rawStore.get(`local-vault-${id}`)) != null) {
          throw new Error('The account\'s vault on this device did not clear.');
        }
        if (stored.accountID) removeLocalAccount(stored.accountID);
        if (this.#currentVault?.id === id) this.#currentVault = null;
      }
      await this.#rawStore.remove(`pq-vault-owner-${id}`);
    }
    if (card) {
      this.#localUserCards = this.#localUserCards.filter((i) => i.user_hash !== userHash);
      await this.#saveLocalUserCards();
    }
  }

  #normalizeKey(key) {
    if (!key) return null;
    // A copy: logout zeroes the session's key, never the vault's cached one.
    if (key instanceof Uint8Array) return new Uint8Array(key);
    if (typeof key === 'object' && !ArrayBuffer.isView(key)) {
      return new Uint8Array(Object.values(key).map(v => Number(v)));
    }
    return null;
  }

  #signKeyMatchesIdentity(signSkey, identity) {
    try {
      const challenge = new TextEncoder().encode('buckitup/local-vault/account-binding/v1');
      return ml_dsa87.verify(ml_dsa87.sign(challenge, signSkey), challenge, decodeHexOrBase64(identity.sign_pkey));
    } catch { return false; }
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

  /**
   * Re-push the current user's card (e.g. after a name change). Resolves
   * 'synced' once the server has it, 'queued' when it waits in the outbox for
   * the connection; throws when it can never get there.
   */
  async pushCurrentUserCard() {
    const card = this.#localUserCards.find(u => u.user_hash === this.#currentUserHash);
    if (!card) return 'synced';
    return this.#publishCardOrQueue(card);
  }

  async #publishCardOrQueue(card) {
    const outcome = await this.#pushOwnCard(card, { deferDelivery: true });
    return outcome === 'accepted' ? 'synced' : 'queued';
  }

  /**
   * Rename: local vault registry and the public card are one logical
   * operation. Doing only half of it let the persisted registry keep the old
   * name and silently revert it on the next login. With no connection the
   * card waits in the outbox, like any other profile edit.
   */
  async updateOwnUserCardName(newName) {
    const idx = this.#localUserCards.findIndex(u => u.user_hash === this.#currentUserHash);
    if (idx === -1) throw new Error('User not found in local identities');

    this.#localUserCards[idx] = { ...this.#localUserCards[idx], name: newName };
    await this.#saveLocalUserCards();
    await this.#publishCardOrQueue(this.#localUserCards[idx]);
    return this.#localUserCards[idx];
  }

  // Sign Challenge

  async signChallenge(challenge) {
    if (!this.#signSkey) {
      throw new Error('Not authenticated or secret key not loaded');
    }

    let msg = typeof challenge === 'string'
      ? new TextEncoder().encode(challenge)
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

  /**
   * The guardian meta seed, hex, read from the vault. Made with the account
   * (createUserVault), so every device of it holds the same one; with
   * `create`, an account made before the seed existed makes it here, at its
   * first acceptance.
   */
  async guardianMetaSeed({ create = false } = {}) {
    if (!this.#currentVault) throw new Error('Vault not loaded');
    if (this.#metaSeed) return this.#metaSeed;
    const vault = this.#currentVault;
    // One seed per account, ever: a second one would answer some owners with
    // keys the first never derives. Another tab shares the vault, so the
    // check is made again, under a lock, against the vault itself.
    const make = async () => {
      let seed = (await vault.get('meta_seed')) ?? null;
      if (!seed && create) {
        seed = bytesToHex(newMetaSeed());
        await vault.set('meta_seed', seed);
      }
      return seed;
    };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    const seed = await (create && locks ? locks.request(`meta_seed:${vault.id}`, make) : make());
    // A logout or switch while this ran leaves the seed in its own vault and
    // nothing in this session.
    if (this.#currentVault !== vault) throw new Error('The account changed while the guardian keys were being read');
    this.#metaSeed = seed;
    return seed;
  }

  /**
   * The community-backup recovery this account runs as its temporary account
   * (plan § 7.5), or null. It lives in the account's vault beside its keys, so
   * the candidate key in it never leaves the device and goes when the
   * temporary account is destroyed, keys and vault together. Not exported:
   * exportVaultKeys names what a backup carries.
   */
  async loadRecoveryProgress() {
    if (!this.#currentVault) throw new Error('Vault not loaded');
    const text = await this.#currentVault.get('recovery_progress');
    return typeof text === 'string' ? JSON.parse(text) : null;
  }

  async saveRecoveryProgress(progress) {
    if (!this.#currentVault) throw new Error('Vault not loaded');
    await this.#currentVault.set('recovery_progress', JSON.stringify(progress));
  }

  /** The shared secret of an ML-KEM-1024 ciphertext made for this account's crypt_pkey: a share returned by hand. */
  kemDecapsulate(cipherText) {
    if (!this.#cryptSkey) throw new Error('Not authenticated or secret key not loaded');
    return ml_kem1024.decapsulate(cipherText, this.#cryptSkey);
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
      sign_pkey: this.#localUserCards.find(u => u.user_hash === this.localStorageOwnerHash).sign_pkey,
      crypt_pkey: this.#localUserCards.find(u => u.user_hash === this.localStorageOwnerHash).crypt_pkey
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

    const signSkey = new Uint8Array(atob(keys.sign_skey).split('').map(c => c.charCodeAt(0)));
    const cryptSkey = new Uint8Array(atob(keys.crypt_skey).split('').map(c => c.charCodeAt(0)));

    await this.#loadLocalUserCards();
    const existing = this.#localUserCards.find(i => i.user_hash === identity.user_hash);
    // A registry card can outlive its encrypted vault (for example after an
    // older client cleared all local-vault entries). A backup supplies the
    // missing private keys, so create a fresh passkey-protected vault instead
    // of trying to connect to the empty row that local-vault auto-created.
    const existingVault = existing?.vaultId
      ? await this.#rawStore.get(`local-vault-${existing.vaultId}`)
      : null;
    const reuseExistingVault = !!existingVault?.accountID && !!existingVault?.data;
    const userVault = reuseExistingVault
      ? await connect({ vaultID: existing.vaultId, storageType: 'idb', keyOptions: VAULT_KEY_OPTIONS })
      : await connect({
        storageType: 'idb',
        addNewVault: true,
        keyOptions: { ...VAULT_KEY_OPTIONS, username: identity.name, displayName: identity.name }
      });

    await userVault.set(`sign_skey`, signSkey);
    await userVault.set(`crypt_skey`, cryptSkey);
    await userVault.set(`evm_skey`, keys.evm_skey);
    await userVault.set(`contact_skey`, keys.contact_skey);
    if (keys.meta_seed) {
      // Owners may hold meta-addresses from the seed already here: replacing
      // it would leave this device unable to approve for them.
      const present = reuseExistingVault ? await userVault.get(`meta_seed`) : null;
      if (!present) await userVault.set(`meta_seed`, keys.meta_seed);
      else if (present !== keys.meta_seed) console.warn('[vault] the imported guardian seed differs from this device\'s; this device keeps its own');
    }

    identity.vaultId = userVault.id;
    if (existing) {
      Object.assign(existing, identity);
    } else {
      this.#localUserCards.push(identity);
    }
    await this.#saveLocalUserCards();
    await this.#rawStore.set(`pq-vault-owner-${userVault.id}`, identity.user_hash);

    // Same card boundary as registration: the card may not exist on this Pi
    // yet, and the session activates only once it is accepted.
    await this.#openForBootstrap(identity.user_hash);
    let card;
    try {
      card = await this.#pushOwnCard(identity, { deferDelivery: true, bootstrap: 'import' });
    } catch (e) {
      await this.#abortBootstrap();
      if (e instanceof CardNotDurableError) throw new AccountImportIncompleteError(identity.user_hash, e.cause);
      throw e;
    }
    if (card === 'deferred') {
      await this.#abortBootstrap();
      return { status: 'card-deferred', userHash: identity.user_hash };
    }
    this.#activateSession(identity.user_hash, identity);
    return { status: 'active', userHash: identity.user_hash };
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
   * The decrypted JSON at `uuid`, or null when there is none. A row that is
   * there but does not decrypt is null for a reader and an error for a
   * writer: a write built on that null would replace what it could not read —
   * a root with no slot map, a list with nothing in it.
   */
  async #readJsonAt(uuid, label, { strict = false } = {}) {
    const row = await getStorageRow(this.#currentUserHash, uuid);
    if (!row || !row.value_b64) return null;
    try {
      return await this.#decryptJson(row.value_b64);
    } catch (e) {
      if (strict) throw new Error(`${label} on the server cannot be read; nothing was written`, { cause: e });
      console.error(`Failed to decrypt ${label}:`, e);
      return null;
    }
  }

  /** Decrypted root record, or null when this account has none yet. */
  #readRoot(opts) {
    return this.#readJsonAt(this.#rootSlotUuid(), 'The account record', opts);
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
      // Bound to the account it resolves for: a slot creation still running
      // after an account switch must not read or patch the next account's root.
      const owner = this.#currentUserHash;
      const sameAccount = () => {
        if (owner !== null && this.#currentUserHash !== owner) throw new Error('The account changed before this write ran; nothing was written');
      };
      this.#slotResolver = createSlotResolver({
        read: () => { sameAccount(); return this.#readRoot(); },
        write: (patch) => { sameAccount(); return this.#writeRootPatch(patch); },
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
   * Runs `writeRow` against the named slot's row, creating the slot on first
   * use. The slot row lands before the map entry that names it, so a failure
   * between the two leaves an unreferenced row rather than a map pointing at
   * nothing.
   */
  async #ensureSlot(name, writeRow, { writeMap } = {}) {
    const { uuid, orphaned } = await this.#slots().ensureSlotUuid(name, {
      mint: randomSlotUuid,
      writeRow,
      writeMap,
      recallPendingMint: () => kvGet(this.#pendingSlotMintKey(name)),
      rememberPendingMint: (uuid) => kvSet(this.#pendingSlotMintKey(name), uuid),
      forgetPendingMint: () => kvDelete(this.#pendingSlotMintKey(name)),
    });
    if (orphaned) {
      await this.#tombstoneSlotRow(orphaned);
      await writeRow(uuid);
    }
  }

  /**
   * Seals the account under a wrap key, publishes it where only that key can
   * find it (lib/recovery/vault), and records it in the root as the current
   * vault; the one it replaces joins the root's stale list. Nothing is
   * retired here: until the backup the new vault belongs to is on chain and
   * its shares are out, the previous one is still the owner's way back
   * (retireRecoveryVaults).
   *
   * Vault first, root second. A crash before the root write leaves the new
   * vault live and unreferenced, which is safe only because the caller hands
   * its key to nobody before this returns. Resolves to the vault's uuid.
   */
  async publishRecoveryVault(wrapKey, json) {
    const userHash = this.#currentUserHash;
    if (!userHash || !this.#signSkey || !this.#cryptSkey) {
      throw new Error('No user is currently logged in');
    }
    // A root that is there but does not decrypt would fail the patch only
    // after the vault is already live; refuse before publishing anything.
    await this.#readRoot({ strict: true });
    const uuid = await publishVault({ userHash, signSkey: this.#signSkey, wrapKey, json });
    this.#sameAccount(userHash);
    // Only the address: mergeJsonPatch moves the vault it replaces onto
    // staleVaults against the base the patch actually lands on.
    await this.#writeRootPatch({ vaultUuid: uuid });
    return uuid;
  }

  #sameAccount(userHash) {
    // Each root patch is signed with whatever account is current when it is
    // written; one switched in between would get this account's vault list.
    if (this.#currentUserHash !== userHash) throw new Error('The account changed while the backup was being written');
  }

  /**
   * Tombstones every vault the root lists as stale, but `keep`: the keys
   * inside a vault never change, so one left live keeps an old set of shares
   * — and, after a recovery, the pieces returned and the node half released —
   * able to open the account. With `keep` null (a revoked backup) the
   * current vault goes too. A tombstone that fails stays on the list for the
   * next attempt, and the failure is reported.
   */
  async retireRecoveryVaults({ keep = null } = {}) {
    const userHash = this.#currentUserHash;
    if (!userHash || !this.#signSkey || !this.#cryptSkey) {
      throw new Error('No user is currently logged in');
    }
    let root = (await this.#readRoot({ strict: true })) || {};
    if (keep === null && typeof root.vaultUuid === 'string') {
      this.#sameAccount(userHash);
      await this.#writeRootPatch({ vaultUuid: null });
      root = (await this.#readRoot({ strict: true })) || {};
    }
    const retired = [];
    let failure = null;
    for (const uuid of root.staleVaults ?? []) {
      if (uuid === keep) continue;
      this.#sameAccount(userHash);
      try {
        await this.#tombstoneRow(uuid);
        retired.push(uuid);
      } catch (e) {
        failure = e;
      }
    }
    if (retired.length) {
      this.#sameAccount(userHash);
      await this.#writeRootPatch({ retiredVaults: retired });
    }
    if (failure) throw new Error('An earlier backup could not be retired; try again.', { cause: failure });
  }

  // Update User Storage

  /**
   * Save the profile. It is saved once durable on this device — shown from
   * there, across reloads — and the outbox takes it to the server. Resolves
   * `{ card, pending, cardPublished }`: `pending` while the server does not
   * have all of it yet (offline, it waits for the connection);
   * `cardPublished` when the public card went out with it. Throws only when
   * the change can never reach the server.
   */
  async updateUserStorage({ name, notes }) {
    if (!this.#currentUserHash) {
      throw new Error('No user is currently logged in');
    }
    if (!this.#cryptSkey) {
      throw new Error('Crypt key not loaded');
    }

    // 1. Encrypt profile and save to DB.
    // A field left undefined here (e.g. notes on a plain rename) must be
    // omitted from the patch, not written as undefined — a
    // full-record spread would have serialized it away and silently erased
    // the existing value. Merging (storageIntent.ts's mergeJsonPatch) also
    // means the slot map, the vault's address and any other field written by
    // another device concurrently is preserved rather than needing a fresh
    // read here.
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (notes !== undefined) patch.notes = notes;
    const rootStatus = await saveStorageJsonPatch({
      userHash: this.#currentUserHash,
      uuid: this.#rootSlotUuid(),
      jsonPatch: patch,
      signSkey: this.#signSkey,
    });

    // 2. Update local cards
    const idx = this.#localUserCards.findIndex(u => u.user_hash === this.#currentUserHash);
    if (idx === -1) {
      throw new Error('User not found in local cards');
    }

    const current = this.#localUserCards[idx];

    this.#localUserCards[idx] = {
      ...current,
      name: name !== undefined ? name : current.name,
      userStorage: {
        ...current.userStorage,
        notes: notes !== undefined ? notes : current.userStorage?.notes,
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

    const cardStatus = cardChanged ? await this.#publishCardOrQueue(updated) : 'synced';

    return {
      card: updated,
      pending: rootStatus !== 'synced' || cardStatus !== 'synced',
      awaitingApproval: rootStatus === 'awaiting-approval',
      cardPublished: cardChanged,
    };
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
    if (root.name === undefined && root.notes === undefined) {
      return null;
    }
    return root;
  }

  // Contacts: a named JSON slot like any other, { contacts: { [user_hash]:
  // contact } }. An edit is a patch by user_hash (storageIntent
  // mergeJsonPatch): its fields merge into the stored contact, null deletes it.

  async saveContacts(edits) {
    const { value, status } = await this.saveSlotJson('contacts', { contacts: edits });
    return { contacts: Object.values(value?.contacts ?? {}), status };
  }

  /** Applies `edits` to the contacts the server holds; resolves to the accepted list. */
  async patchContacts(edits) {
    const record = await this.patchSlotJson('contacts', { contacts: edits });
    return Object.values(record?.contacts ?? {});
  }

  async loadContacts() {
    return Object.values((await this.loadSlotJson('contacts'))?.contacts ?? {});
  }

  async setContactAccess(issuerHash, subjectHash, granted) {
    if (!issuerHash || this.#currentUserHash !== issuerHash || !this.#signSkey) return 'skipped';
    return this.#afterContactAccess(issuerHash, await requestContactAccess(subjectHash, granted, this.#contactAccessSession(issuerHash)));
  }

  #contactAccessRetry = null;
  #contactAccessRetryDelay = CONTACT_ACCESS_RETRY_MS;

  #contactAccessSession(issuerHash) {
    const session = currentSessionToken();
    return {
      issuerHash,
      signingKey: this.#signingKeyOf(issuerHash),
      stillCurrent: () => this.#currentUserHash === issuerHash && sameSessionToken(session, currentSessionToken()),
    };
  }

  #afterContactAccess(issuerHash, result) {
    if (result !== 'retry') {
      this.#contactAccessRetryDelay = CONTACT_ACCESS_RETRY_MS;
      return result;
    }
    if (this.#contactAccessRetry || this.#currentUserHash !== issuerHash) return result;
    const delay = this.#contactAccessRetryDelay;
    this.#contactAccessRetryDelay = Math.min(delay * 2, CONTACT_ACCESS_RETRY_MAX_MS);
    this.#scheduleContactAccessRetry(issuerHash, delay);
    return result;
  }

  #hurryContactAccessRetry(issuerHash) {
    clearTimeout(this.#contactAccessRetry);
    this.#contactAccessRetryDelay = CONTACT_ACCESS_RETRY_MS;
    this.#scheduleContactAccessRetry(issuerHash, CONTACT_ACCESS_HURRY_MS);
  }

  #scheduleContactAccessRetry(issuerHash, delay) {
    const session = currentSessionToken();
    this.#contactAccessRetry = setTimeout(() => {
      this.#contactAccessRetry = null;
      if (this.#currentUserHash === issuerHash && sameSessionToken(session, currentSessionToken())) this.#recoverIntents(issuerHash);
    }, delay);
  }

  // Named JSON slots

  /**
   * A named slot's JSON value, or null when the slot was never written or
   * does not decrypt — `strict` tells the two apart by throwing for the
   * second. For readers only: a writer goes through patchSlotJson, which
   * refuses rather than build on a value it could not read.
   */
  async loadSlotJson(name, { strict = false } = {}) {
    if (!this.#currentUserHash) throw new Error('No user is currently logged in');
    if (!this.#cryptSkey) {
      if (strict) throw new Error('Crypt key not loaded');
      return null;
    }
    const uuid = await this.#slotUuid(name);
    return uuid ? this.#readJsonAt(uuid, `The ${name} slot`, { strict }) : null;
  }

  /**
   * Merges `patch` into a named slot's JSON value, creating the slot on first
   * use, and resolves to the value the server accepted. Like the root's, the
   * write is a JSON-patch intent (storageIntent.ts): it is merged onto the
   * base the signer uses, under the storage slot lock, so two updates — in
   * this tab, another tab or another device — never drop each other's change
   * without a read-modify-write here. A value that is there and does not
   * decrypt fails the update instead of being overwritten.
   */
  async saveSlotJson(name, patch) {
    const userHash = this.#currentUserHash;
    const signSkey = this.#signSkey;
    if (!userHash || !signSkey || !this.#cryptSkey) throw new Error('No user is currently logged in');
    const sameAccount = () => {
      if (this.#currentUserHash !== userHash) throw new Error('The account changed before this write ran; nothing was written');
    };
    const statuses = [];
    const save = async (uuid, jsonPatch, knownEmpty = false) => {
      sameAccount();
      statuses.push(await saveStorageJsonPatch({ userHash, uuid, jsonPatch, signSkey, knownEmpty }));
    };
    const mapped = await this.#slotUuid(name);
    let slotUuid = null;
    await this.#ensureSlot(name, async (uuid) => {
      sameAccount();
      const base = await this.#readJsonAt(uuid, `The ${name} slot`, { strict: true });
      await save(uuid, patch, !mapped && base === null);
      slotUuid = uuid;
    }, { writeMap: (mapPatch) => save(this.#rootSlotUuid(), mapPatch) });
    if (this.#currentUserHash !== userHash) throw new Error('The account changed while this write was out');
    const value = await this.#readJsonAt(slotUuid, `The ${name} slot`, { strict: true });
    const status = ['awaiting-approval', 'awaiting-recovery', 'queued'].find((s) => statuses.includes(s)) ?? 'synced';
    return { value, status };
  }

  async patchSlotJson(name, patch) {
    const userHash = this.#currentUserHash;
    const signSkey = this.#signSkey;
    if (!userHash || !signSkey || !this.#cryptSkey) throw new Error('No user is currently logged in');
    let accepted = null;
    await this.#ensureSlot(name, async (uuid) => {
      // Slot writes queue behind each other; one that runs after an account
      // switch belongs to nobody here.
      if (this.#currentUserHash !== userHash) throw new Error('The account changed before this write ran; nothing was written');
      await this.#readJsonAt(uuid, `The ${name} slot`, { strict: true });
      accepted = await putStorageJsonPatch({ userHash, uuid, jsonPatch: patch, signSkey });
    });
    // Written for its own account; this session no longer holds that key.
    if (this.#currentUserHash !== userHash) throw new Error('The account changed while this write was out');
    return this.#decryptJson(accepted.value_b64);
  }

  /**
   * The current profile photo as this device shows it in the account list
   * and menu: kept in the local registry next to the card, never published.
   * The photos themselves live in the avatars slot (lib/avatars/gallery).
   */
  async setLocalAvatar({ avatarId, dataUrl }) {
    const idx = this.#localUserCards.findIndex(u => u.user_hash === this.#currentUserHash);
    if (idx === -1) throw new Error('No user is currently logged in');
    this.#localUserCards[idx] = { ...this.#localUserCards[idx], avatar: dataUrl, avatarId };
    await this.#saveLocalUserCards();
    return this.#localUserCards[idx];
  }

  // The key every storage slot's JSON is sealed with. The salt names the
  // first thing it sealed; it stays, or every stored slot stops opening.
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

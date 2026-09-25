import { defineStore } from 'pinia';
import { newWrapKey } from '@/lib/pq/vaultEnvelope';
import { ref, shallowRef, computed, watch, onScopeDispose } from 'vue';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { getUserCardsCollection } from '@/lib/data/collections';
import { preloadWithRetry } from '@/lib/data/attach';

export const userPQStore = defineStore('userPQ', () => {
  const em = ref(null);
  const isInitialized = ref(false);
  // separate from isInitialized: local vault readiness vs network attachment
  const networkAttached = ref(false);
  const localDataReady = ref(false);
  const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { isOnline.value = true; });
    window.addEventListener('offline', () => { isOnline.value = false; });
  }

  const pqUserCards = ref([]);

  const currentUser = ref(null);
  const myLocalUsers = ref([]);
  const allNetworkUsers = shallowRef([]);
  // CollectionSubscription (has .unsubscribe()), not a plain function
  let cardsSub = null;

  const contactsMap = ref({});
  const contacts = computed(() => {
    return Object.values(contactsMap.value).map(contact => {
      const networkUser = allNetworkUsers.value.find(u => u.user_hash === contact.user_hash);
      return {
        ...networkUser,
        ...contact,
        address: contact.user_hash,
        publicKey: contact.user_hash,
      };
    });
  });

  // Plain refs fed by the manager's authChange event — NOT computeds over
  // the instance. EncryptionManagerPQ extends EventTarget (a raw target for
  // Vue's reactivity) and keeps #currentUserHash in a private field, so a
  // computed reading it never invalidates: it would freeze on whatever value
  // the first read saw and every watcher downstream would stay silent
  // across login/logout/account switch.
  const isAuthenticated = ref(false);
  const currentUserHash = ref(null);
  const syncAuthState = () => {
    isAuthenticated.value = em.value?.isAuth ?? false;
    currentUserHash.value = em.value?.currentUserHash ?? null;
  };
  // The manager is a process-wide singleton but this store's closure is
  // per-instance: without teardown every HMR reload of this file leaves an
  // orphaned listener writing into dead refs.
  let boundManager = null;
  const bindAuthListener = (manager) => {
    if (boundManager === manager) return;
    boundManager?.removeEventListener('authChange', syncAuthState);
    boundManager = manager;
    manager?.addEventListener('authChange', syncAuthState);
  };
  onScopeDispose(() => {
    boundManager?.removeEventListener('authChange', syncAuthState);
    boundManager = null;
  });

  const currentUserFull = computed(() => {
    if (!currentUser.value) return null;
    return currentUser.value;
  });

  const initialize = async () => {
    if (isInitialized.value) return;
    reapTestbedKeys();

    // Phase 1: local vault registry (fast, offline)
    em.value = EncryptionManagerPQ.getInstance();
    // Every auth transition dispatches authChange: login, logout,
    // createUserVault (logs in), deleteUserVault (logs out if current).
    bindAuthListener(em.value);
    await em.value.initialize();
    syncAuthState();
    myLocalUsers.value = await em.value.getLocalUserCards();
    localDataReady.value = true;

    // Phase 2: Electric-synced user cards (fire-and-forget)
    initNetworkUsers();
  };

  const readCards = (coll) => coll.toArray
    .filter((r) => !r.deleted_flag)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // Local startup is one-shot; attaching to the network shape is not.
  // `isInitialized` only means "local vault is ready" — it must not gate the
  // network phase, which retries with the same policy every other collection
  // uses (src/lib/data/attach.ts). Previously a single failed preload left
  // the app permanently without user_cards until a reload.
  const initNetworkUsers = async () => {
    isInitialized.value = true;
    console.log(`[userStore] Initialized | Local users: ${myLocalUsers.value.length}`);

    if (networkAttached.value) return;
    const coll = getUserCardsCollection();
    const attached = await preloadWithRetry(coll, () => networkAttached.value, 'user_cards');
    if (!attached) return;

    allNetworkUsers.value = readCards(coll);
    if (!cardsSub) {
      cardsSub = coll.subscribeChanges(() => {
        allNetworkUsers.value = readCards(coll);
      });
    }
    networkAttached.value = true;
  };

  const registerNewUser = async ({ name = "Anonymous", notes, avatar, avatarDataUrl }) => {
    await initialize();

    const newIdentity = await em.value.createUserVault({ name, notes, avatar, avatarDataUrl });

    currentUser.value = newIdentity;

    await refreshAllData();

    // await appInitializer.initializeAfterLogin();

    return newIdentity;
  };

  const login = async (userHash) => {
    await initialize();

    const identity = await em.value.login(userHash);
    afterSignIn(identity);
    return identity;
  };

  // Everything a signed-in session needs beyond the manager's own login:
  // the store's currentUser (which the router guard reads), the profile
  // merge and the contacts map. Shared by login and importBackup, so an
  // imported account is not a second-class session until the next sign-in.
  const afterSignIn = (identity) => {
    currentUser.value = identity;

    // Load profile + contacts in background (PGlite may not be ready yet)
    em.value.loadUserProfile().then(profile => {
      if (profile) {
        currentUser.value = {
          ...currentUser.value,
          name: profile.name || identity.name,
          userStorage: {
            ...identity.userStorage,
            notes: profile.notes,
            avatarUuid: profile.avatarUuid
          }
        };
      }
    }).catch(() => {});

    em.value.loadContacts().then(loadedContacts => {
      const map = {};
      if (Array.isArray(loadedContacts)) {
        loadedContacts.forEach(c => {
          if (c.user_hash) map[c.user_hash] = c;
        });
      }
      contactsMap.value = map;
    }).catch(() => {});

    refreshAllData();
  };

  // Tearing down the session object, which is also the first half of signing
  // in: switching accounts and importing a backup both go through here.
  const logout = async () => {
    if (em.value) {
      await em.value.logout();
    }

    currentUser.value = null;
    // The next account loads its own; until then this one's must not show.
    contactsMap.value = {};

    console.log('[userStore] User logged out');
  };

  // Device-lifetime material is wiped here and never in logout(): logout() is
  // also the first half of signing in, so a wipe there would destroy material
  // the next session still needs. Callers that mean "the session is over" call
  // this instead of remembering what has to go.
  const endSession = async () => {
    await logout();
  };

  /**
   * A one-time reaper, not testbed code. Builds up to this one registered the
   * teststand route unconditionally, so a profile that opened it holds guardian
   * EOA and spending private keys in localStorage as plaintext, alongside a
   * payload carrying the owner key and the master secret. Nothing else in the
   * app clears localStorage.
   *
   * It runs on boot rather than on sign-out because most profiles never sign
   * out — they close the tab — and the keys have to go from those too. Each key
   * is removed on its own: if one throw took the other with it, the half left
   * behind would be the half holding the payload. Drop this once a build
   * containing it has shipped.
   */
  function reapTestbedKeys() {
    for (const key of ['testbed.guardians', 'testbed.backups']) {
      try {
        localStorage.removeItem(key);
      } catch { /* no storage in this environment */ }
    }
  }

  const deleteAccount = async (userHash) => {
    if (em.value) {
      await em.value.deleteUserVault(userHash);
    }
    
    if (currentUser.value && currentUser.value.user_hash === userHash) {
      currentUser.value = null;
    }

    await refreshMyLocalUsers();
    console.log(`[userStore] Account ${userHash} deleted`);
  };

  const refreshAllData = async () => {
    await refreshMyLocalUsers();
  };

  const refreshMyLocalUsers = async () => {
    if (!em.value) return;
    myLocalUsers.value = await em.value.getLocalUserCards();
  };

  const refreshNetworkUsers = async () => {
    allNetworkUsers.value = readCards(getUserCardsCollection());
  };

  // One logical operation: persist the local vault registry AND publish the
  // public card, awaited. The previous version mutated only the in-memory
  // user and fired the push blindly, so refreshMyLocalUsers() reloaded the
  // registry from IndexedDB and reverted the name.
  const updateCurrentUserName = async (newName) => {
    if (!currentUser.value || !currentUserHash.value || !em.value) return false;

    await em.value.updateOwnUserCardName(newName);
    currentUser.value.name = newName;

    await refreshMyLocalUsers();
    return true;
  };

  const updateCurrentUserProfile = async ({ name, notes, avatarUuid, avatarDataUrl }) => {
    if (!em.value || !currentUserHash.value) return false;

    await em.value.updateUserStorage({ name, notes, avatarUuid, avatarDataUrl });

    if (currentUser.value) {
      if (name !== undefined) currentUser.value.name = name;
      if (avatarDataUrl !== undefined) currentUser.value.avatar = avatarDataUrl;
      if (!currentUser.value.userStorage) {
        currentUser.value.userStorage = {};
      }
      if (notes !== undefined) currentUser.value.userStorage.notes = notes;
      if (avatarUuid !== undefined) currentUser.value.userStorage.avatarUuid = avatarUuid;
    }

    // updateUserStorage already republished the card when it changed; this
    // keeps name-only edits in sync and surfaces a failed publication.
    await em.value.pushCurrentUserCard();

    await refreshMyLocalUsers();
    return true;
  };

  // What a contact keeps in the contacts slot. `confirmed` marks a contact
  // whose key was checked in person, through the QR handshake: the only kind a
  // recovery share may be issued to. It is set by confirmContact alone —
  // saveContact is handed whole view objects that mix in network card fields,
  // and keeps whatever the stored contact already says.
  const toStored = (c) => ({
    user_hash: c.user_hash,
    name: c.name,
    notes: c.notes,
    hidden: c.hidden,
    contact_pkey: c.contact_pkey,
    confirmed: !!c.confirmed,
  });

  // Every write edits the list as the server holds it, not this tab's copy:
  // another tab may have confirmed a contact since this one loaded, and a copy
  // that never loaded would write a list of one over everyone else. The edit
  // shows at once, and the server's answer replaces it — unless a later edit
  // has shown since (its own answer will), or the account changed while the
  // write was out, in which case it belongs to nobody here.
  let contactsEdits = 0;
  const writeContacts = async (edit) => {
    const account = currentUserHash.value;
    const generation = ++contactsEdits;
    const local = new Map(Object.entries(contactsMap.value));
    edit(local);
    contactsMap.value = Object.fromEntries(local);
    const next = await em.value.updateSlotJson('contacts', (current) => {
      const byHash = new Map((current ?? []).map((c) => [c.user_hash, c]));
      edit(byHash);
      return [...byHash.values()].map(toStored);
    });
    if (currentUserHash.value === account && generation === contactsEdits) {
      contactsMap.value = Object.fromEntries(next.map((c) => [c.user_hash, c]));
    }
  };

  const saveContact = async (userHash, contactData) => {
    if (!em.value || !currentUserHash.value) return false;
    await writeContacts((byHash) => {
      const prev = byHash.get(userHash);
      byHash.set(userHash, { ...prev, ...contactData, user_hash: userHash, confirmed: !!prev?.confirmed });
    });
    return true;
  };

  /**
   * Marks a contact as met in person, with the key the handshake proved —
   * adding it if it is not a contact yet. The caller has checked that key
   * against the contact's certified card (lib/pq/verifyCard).
   */
  const confirmContact = async (userHash, contactPkey, fields = {}) => {
    if (!em.value || !currentUserHash.value) return false;
    await writeContacts((byHash) => {
      const prev = byHash.get(userHash);
      byHash.set(userHash, { ...prev, ...fields, user_hash: userHash, contact_pkey: contactPkey, confirmed: true });
    });
    return true;
  };

  const deleteContact = async (userHash) => {
    if (!em.value || !currentUserHash.value) return false;
    await writeContacts((byHash) => byHash.delete(userHash));
    return true;
  };

  const getUserByHash = (userHash) => {
    return allNetworkUsers.value.find(u => u.user_hash === userHash) ||
      myLocalUsers.value.find(u => u.user_hash === userHash);
  };

  const getMyUserByHash = (userHash) => {
    return myLocalUsers.value.find(u => u.user_hash === userHash);
  };

  const getEvmPrivateKey = async () => {
    if (!em.value) return null;
    return await em.value.getEvmSkey();
  };

  const getEvmMetaKeys = async () => {
    const skey = await getEvmPrivateKey();
    if (!skey) return null;
    return {
      privateKey: skey
    };
  };

  const exportBackup = async () => {
    if (!em.value) throw new Error('Not signed in.');
    const keys = await em.value.exportVaultKeys();
    if (!keys.contact_skey) {
      // A vault restored before contact_skey was carried has none, and an
      // import refuses a backup without it - so refuse here, before it is
      // sealed, downloaded or sent.
      throw new Error('This account has no contact key in its vault and cannot be backed up or linked.');
    }
    return {
      version: 1,
      identity: currentUser.value,
      keys
    };
  };

  // The account sealed under a fresh wrap key and published where only that
  // key can find it; the key is the one thing a share scheme ever splits
  // (docs/backup-recovery-overview.md §6), and it never leaves this function.
  // Split before publishing, so a parameter the split refuses leaves no vault
  // behind; publish before returning, so nothing is shown until the server has
  // the vault - shares of a key that opens nothing are worse than none.
  const createRecoveryBackup = async ({ total, threshold }) => {
    const backup = await exportBackup();
    // Loaded here and not at the top: Shamir and its Buffer polyfill serve
    // this one dev-gated screen and have no place in the startup bundle.
    const { splitWrapKey } = await import('@/lib/wrapKeyShares');
    const wrapKey = newWrapKey();
    try {
      const shares = splitWrapKey(wrapKey, total, threshold);
      await em.value.publishRecoveryVault(wrapKey, JSON.stringify(backup));
      return shares;
    } finally {
      wrapKey.fill(0);
    }
  };

  const importBackup = async (backupData) => {
    if (isAuthenticated.value) {
      await logout();
    }
    if (!isInitialized.value) {
      await initialize();
    }
    const { identity, keys } = backupData;
    if (!identity?.name) identity.name = 'Imported Account';
    await em.value.importVaultKeys(keys, identity);
    // importVaultKeys signs in at the manager level only; the store's side of
    // a session is the same as after login, or the import lands on the login
    // page with no contacts.
    afterSignIn(identity);
  };

  watch(isAuthenticated, (authenticated) => {
    console.log('is auth', isAuthenticated)

    if (authenticated) {
      refreshAllData();
    } else {
      currentUser.value = null;
    }
  });

  watch(currentUser, (user) => {
    console.log('user', user)
  });

  const signContactChallenge = async (challenge) => {
    if (!em.value) return null;
    return await em.value.signContactChallenge(challenge);
  };

  return {
    isInitialized,
    localDataReady,
    isAuthenticated,
    currentUserHash,
    currentUser: currentUserFull,
    myLocalUsers,
    allNetworkUsers,
    isOnline,

    pqUserCards,

    contacts,
    contactsMap,
    saveContact,
    confirmContact,
    deleteContact,

    initialize,
    registerNewUser,
    login,
    logout,
    endSession,
    deleteAccount,
    updateCurrentUserName,
    updateCurrentUserProfile,
    refreshMyLocalUsers,
    refreshNetworkUsers,
    refreshAllData,

    getUserByHash,
    getMyUserByHash,

    getEvmPrivateKey,
    getEvmMetaKeys,
    exportBackup,
    createRecoveryBackup,
    importBackup,
    signContactChallenge,

    setEncryptionManager: (manager) => {
      em.value = manager;
      // a replacement manager is a new event source — rebind or the refs
      // silently stop tracking auth
      bindAuthListener(manager);
      syncAuthState();
    }
  };
});
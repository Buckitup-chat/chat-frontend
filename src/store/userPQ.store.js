import { defineStore } from 'pinia';
import { newWrapKey } from '@/lib/pq/vaultEnvelope';
import { ref, shallowRef, computed, watch, onScopeDispose } from 'vue';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { getUserCardsCollection } from '@/lib/data/collections';
import { preloadWithRetry } from '@/lib/data/attach';
import { onUserCardsStreamError, whenUserCardsLive, userCardsWithCache } from '@/lib/data/userCardsLink';

export const userPQStore = defineStore('userPQ', () => {
  const em = ref(null);
  const isInitialized = ref(false);
  // separate from isInitialized: local vault readiness vs network attachment
  const networkAttached = ref(false);
  const showingCachedCards = ref(false);
  const userCardsFallback = computed(() => showingCachedCards.value && !networkAttached.value);
  let networkUsersStarted = false;
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

  const readCards = (rows) => rows
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

    if (networkAttached.value || networkUsersStarted) return;
    networkUsersStarted = true;
    const coll = getUserCardsCollection();
    const live = whenUserCardsLive(coll);

    let fallbackShown = false;
    const showCacheFallback = ({ evenIfEmpty }) => {
      if (fallbackShown || networkAttached.value) return;
      void userCardsWithCache(coll.toArray).then((rows) => {
        if (fallbackShown || networkAttached.value) return;
        if (!rows.length && !evenIfEmpty) return;
        fallbackShown = true;
        allNetworkUsers.value = readCards(rows);
        showingCachedCards.value = true;
      });
    };
    const onStreamFailure = () => showCacheFallback({ evenIfEmpty: true });
    const stopErrorWatch = onUserCardsStreamError(onStreamFailure);
    showCacheFallback({ evenIfEmpty: false });

    void preloadWithRetry(coll, () => networkAttached.value, 'user_cards', onStreamFailure);

    await live;
    stopErrorWatch();
    allNetworkUsers.value = readCards(coll.toArray);
    if (!cardsSub) {
      cardsSub = coll.subscribeChanges(() => {
        allNetworkUsers.value = readCards(coll.toArray);
      });
    }
    networkAttached.value = true;
    showingCachedCards.value = false;
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
    if (!networkAttached.value) return;
    allNetworkUsers.value = readCards(getUserCardsCollection().toArray);
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

  const saveContact = async (userHash, contactData) => {
    if (!em.value || !currentUserHash.value) return false;
    
    // Maintain backward compatibility fields if they are missing
    contactsMap.value[userHash] = {
      ...contactsMap.value[userHash],
      ...contactData,
      user_hash: userHash
    };

    const contactsArray = Object.values(contactsMap.value).map(c => ({
      user_hash: c.user_hash,
      name: c.name,
      notes: c.notes,
      hidden: c.hidden,
      contact_pkey: c.contact_pkey
    }));

    await em.value.updateContacts(contactsArray);
    return true;
  };

  const deleteContact = async (userHash) => {
    if (!em.value || !currentUserHash.value) return false;
    
    if (contactsMap.value[userHash]) {
      delete contactsMap.value[userHash];
      
      const contactsArray = Object.values(contactsMap.value).map(c => ({
        user_hash: c.user_hash,
        name: c.name,
        notes: c.notes,
        hidden: c.hidden
      }));
      
      await em.value.updateContacts(contactsArray);
    }
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
    userCardsFallback,
    isOnline,

    pqUserCards,

    contacts,
    contactsMap,
    saveContact,
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
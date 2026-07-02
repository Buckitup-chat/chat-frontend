import { defineStore } from 'pinia';
import { ref, shallowRef, computed, watch } from 'vue';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { localDB } from '@/utils/db/localDBv2';

export const userPQStore = defineStore('userPQ', () => {
  const em = ref(null);
  const isInitialized = ref(false);
  const localDataReady = ref(false);
  const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true);

  const pqUserCards = ref([]);

  const currentUser = ref(null);
  const myLocalUsers = ref([]);
  const allNetworkUsers = shallowRef([]);
  let liveQueryObj = null;
  let liveQueryRows = null;
  let liveQueryRaf = null;

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

  const isAuthenticated = computed(() => em.value?.isAuth ?? false);

  const currentUserHash = computed(() => em.value?.currentUserHash ?? null);

  const currentUserFull = computed(() => {
    if (!currentUser.value) return null;
    return currentUser.value;
  });

  const initialize = async () => {
    if (isInitialized.value) return;

    // Phase 1: IndexedDB (fast, no PGlite)
    em.value = EncryptionManagerPQ.getInstance();
    await em.value.initialize();
    myLocalUsers.value = await em.value.getLocalUserCards();
    localDataReady.value = true;

    // Phase 2: PGlite + live query (slow, fire-and-forget)
    initDbAndLiveQuery();
  };

  const initDbAndLiveQuery = async () => {
    await localDB.init();

    try {
      liveQueryObj = await localDB.db.live.query('SELECT * FROM user_cards WHERE NOT deleted_flag ORDER BY name ASC');
      allNetworkUsers.value = liveQueryObj.initialResults.rows;
      liveQueryObj.subscribe((result) => {
        console.time('liveQuery calback');
        if (allNetworkUsers.value.length === 0 && result.rows.length > 0) {
          console.timeEnd('post-init wait');
        }
        liveQueryRows = result.rows;
        if (!liveQueryRaf) {
          liveQueryRaf = requestAnimationFrame(() => {
            liveQueryRaf = null;
            allNetworkUsers.value = liveQueryRows;
          });
        }
        console.timeEnd('liveQuery calback');
      });
    } catch (e) {
      console.warn('[userStore] Live query failed, falling back to manual refresh:', e);
    }

    isInitialized.value = true;

    setTimeout(() => localDB.triggerSync(), 1000);

    console.log(`[userStore] Initialized | Local users: ${myLocalUsers.value.length}`);
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

    let identity = await em.value.login(userHash);
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

    return identity;
  };

  const logout = async () => {
    if (em.value) {
      await em.value.logout();
    }

    currentUser.value = null;

    console.log('[userStore] User logged out');
  };

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
    if (!liveQueryObj) {
      allNetworkUsers.value = await localDB.getUsers();
    }
  };

  const updateCurrentUserName = async (newName) => {
    if (!currentUser.value || !currentUserHash.value) return false;

    currentUser.value.name = newName;

    await localDB.upsertUserLocal({
      user_hash: currentUserHash.value,
      name: newName
    });

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

    await localDB.upsertUserLocal({
      user_hash: currentUserHash.value,
      name: currentUser.value?.name,
      sign_pkey: currentUser.value?.sign_pkey,
      crypt_pkey: currentUser.value?.crypt_pkey,
      crypt_cert: currentUser.value?.crypt_cert,
      contact_pkey: currentUser.value?.contact_pkey,
      contact_cert: currentUser.value?.contact_cert
    });

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
    if (!em.value) return null;
    const keys = await em.value.exportVaultKeys();
    return {
      version: 1,
      identity: currentUser.value,
      keys
    };
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
    await refreshAllData();
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
    deleteContact,

    initialize,
    registerNewUser,
    login,
    logout,
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
    importBackup,
    signContactChallenge,

    setEncryptionManager: (manager) => {
      em.value = manager;
    }
  };
});
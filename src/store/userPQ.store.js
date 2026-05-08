import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { localDB } from '@/utils/db/localDBv2';

export const userPQStore = defineStore('userPQ', () => {
  const em = ref(null);
  const isInitialized = ref(false);
  const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true);

  const pqUserCards = ref([]);

  const currentUser = ref(null);
  const myLocalUsers = ref([]);
  const allNetworkUsers = ref([]);

  const contactsMap = ref({});
  const contacts = computed(() => {
    return Object.values(contactsMap.value).map(contact => {
      // Merge with network info if available
      const networkUser = allNetworkUsers.value.find(u => u.user_hash === contact.user_hash);
      return {
        ...networkUser,
        ...contact, // Local overrides take precedence (like custom name/notes)
        address: contact.user_hash, // Aliases for backward compatibility in views
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

    await localDB.init();

    em.value = EncryptionManagerPQ.getInstance();
    await em.value.initialize();

    myLocalUsers.value = await em.value.getLocalUserCards();

    isInitialized.value = true;

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
    
    const profile = await em.value.loadUserProfile();
    if (profile) {
      identity = {
        ...identity,
        name: profile.name || identity.name,
        userStorage: {
          ...identity.userStorage,
          notes: profile.notes,
          avatarUuid: profile.avatarUuid
        }
      };
    }

    const loadedContacts = await em.value.loadContacts();
    const map = {};
    if (Array.isArray(loadedContacts)) {
      loadedContacts.forEach(c => {
        if (c.user_hash) map[c.user_hash] = c;
      });
    }
    contactsMap.value = map;

    currentUser.value = identity;

    // await appInitializer.initializeAfterLogin();

    await refreshAllData();

    return identity;
  };

  const logout = async () => {
    if (em.value) {
      await em.value.logout();
    }

    currentUser.value = null;

    console.log('[userStore] User logged out');
  };

  const refreshAllData = async () => {
    await Promise.all([
      refreshMyLocalUsers(),
      refreshNetworkUsers()
    ]);
  };

  const refreshMyLocalUsers = async () => {
    if (!em.value) return;
    myLocalUsers.value = await em.value.getLocalUserCards();
  };

  const refreshNetworkUsers = async () => {
    allNetworkUsers.value = await localDB.getUsers();
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
      hidden: c.hidden
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
    await initialize();
    const { identity, keys } = backupData;
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
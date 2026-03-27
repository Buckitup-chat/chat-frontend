import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { EncryptionManagerPQ } from '@/crypto/EncryptionManagerPQ';
import { localDB } from '@/db/localDB';

export const useUserPQStore = defineStore('user', () => {
  const em = ref(null);
  const isInitialized = ref(false);

  const currentUser = ref(null);
  const myLocalUsers = ref([]);
  const allNetworkUsers = ref([]);

  const isAuthenticated = computed(() => em.value?.isAuth ?? false);
  const currentUserHash = computed(() => em.value?.currentUserHash ?? null);

  const currentUserFull = computed(() => {
    if (!currentUser.value) return null;
    return currentUser.value;
  });

  const initialize = async () => {
    if (isInitialized.value) return;

    em.value = EncryptionManagerPQ.getInstance();
    await em.value.initialize();

    myLocalUsers.value = await em.value.getLocalUserCards();

    isInitialized.value = true;

    console.log(`[userStore] Initialized | Local users: ${myLocalUsers.value.length}`);
  };

  const registerNewUser = async (name = "Anonymous") => {
    await initialize();

    const newIdentity = await em.value.createNewUser(name);

    currentUser.value = newIdentity;
    await refreshAllData();

    await appInitializer.initializeAfterLogin();

    return newIdentity;
  };

  const login = async (userHash) => {
    await initialize();

    const identity = await em.value.login(userHash);

    currentUser.value = identity;

    await appInitializer.initializeAfterLogin();

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

  const getUserByHash = (userHash) => {
    return allNetworkUsers.value.find(u => u.user_hash === userHash) ||
      myLocalUsers.value.find(u => u.user_hash === userHash);
  };

  const getMyUserByHash = (userHash) => {
    return myLocalUsers.value.find(u => u.user_hash === userHash);
  };

  watch(isAuthenticated, (authenticated) => {
    if (authenticated) {
      refreshAllData();
    } else {
      currentUser.value = null;
    }
  });

  return {
    isAuthenticated,
    currentUserHash,
    currentUser: currentUserFull,
    myLocalUsers,
    allNetworkUsers,

    initialize,
    registerNewUser,
    login,
    logout,
    updateCurrentUserName,
    refreshMyLocalUsers,
    refreshNetworkUsers,
    refreshAllData,

    getUserByHash,
    getMyUserByHash,

    setEncryptionManager: (manager) => {
      em.value = manager;
    }
  };
});
import { defineStore } from 'pinia';
import { ref, shallowRef, computed, watch, onScopeDispose } from 'vue';
import { EncryptionManagerPQ } from '@/libs/EncryptionManagerPQ';
import { getUserCardsCollection } from '@/lib/data/collections';
import { preloadWithRetry } from '@/lib/data/attach';
import { onUserCardsStreamError, whenUserCardsLive, userCardsWithCache, verifiedCards } from '@/lib/data/userCardsLink';
import { mergeContactEdit } from '@/lib/data/storageIntent';
import { contactKeyVouch } from '@/lib/pq/verifyCard';
import { forgetPlaintextUploadKeys } from '@/lib/forgetUploadKeys';

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
    forgetPlaintextUploadKeys();

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

  const readCards = (rows) => verifiedCards(rows)
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

  // A photo chosen at creation is the gallery's first (avatars.store
  // addPhoto), added by the caller once the account exists.
  const registerNewUser = async ({ name = "Anonymous", notes }) => {
    await initialize();

    const newIdentity = await em.value.createUserVault({ name, notes });

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
    // The next account loads its own; until then this one's must not show,
    // and no edit still out may put any of it back.
    contactsMap.value = {};
    contactsSession = newContactsSession();

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
   * payload carrying the owner key and the master secret. Plaintext upload
   * keys left by earlier builds go at the same time (forgetPlaintextUploadKeys).
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

  // The strict removal a recovery's temporary account needs (recoveryFinale):
  // throws unless the vault is verifiably cleared, and finds the vault by id
  // once its card is gone.
  const destroyAccount = async ({ userHash, vaultId = null }) => {
    if (!em.value) throw new Error('Not initialized');
    await em.value.destroyUserVault({ userHash, vaultId });
    if (currentUser.value?.user_hash === userHash) currentUser.value = null;
    await refreshMyLocalUsers();
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

  // Resolves `{ pending, awaitingApproval }` once the profile is saved on this
  // device; pending while the server does not have all of it yet (offline,
  // the outbox sends it when the connection is back), awaitingApproval while
  // it waits for the device owner's approval. Throws when it can never get there.
  const updateCurrentUserProfile = async ({ name, notes }) => {
    if (!em.value || !currentUserHash.value) return null;

    const saved = await em.value.updateUserStorage({ name, notes });

    if (currentUser.value) {
      if (name !== undefined) currentUser.value.name = name;
      if (!currentUser.value.userStorage) {
        currentUser.value.userStorage = {};
      }
      if (notes !== undefined) currentUser.value.userStorage.notes = notes;
    }

    // updateUserStorage publishes the card when it changed. A second
    // publication right after it would carry the same timestamp while the
    // first is still queued, and the server refuses it as not newer.
    const card = saved.cardPublished ? null : await em.value.pushCurrentUserCard();

    await refreshMyLocalUsers();
    return { pending: saved.pending || card === 'queued', awaitingApproval: saved.awaitingApproval === true };
  };

  // The current gallery photo as this device draws the account: menu,
  // account list, profile. A data URL kept locally (EncryptionManagerPQ
  // setLocalAvatar); null when the gallery is empty.
  const setOwnAvatarImage = async ({ avatarId, dataUrl }) => {
    if (!em.value || !currentUserHash.value) return;
    const account = currentUserHash.value;
    await em.value.setLocalAvatar({ avatarId, dataUrl });
    if (currentUser.value && currentUserHash.value === account) {
      currentUser.value = { ...currentUser.value, avatar: dataUrl, avatarId };
    }
    await refreshMyLocalUsers();
  };

  /**
   * Caches a contact's current avatar next to the contact (pq_avatars § What
   * a reader keeps): `{ id, photo }` — the photo's id and its wire element,
   * whose ThumbHash the lists blur in at once and whose bytes make the small
   * picture this device keeps (avatars.store contactAvatarSrc) — or null when
   * their gallery is empty. The dialog stays the source of truth; this only
   * spares the contact list from reading every dialog. Someone who is not a
   * contact is not made one by it.
   */
  const cacheContactAvatar = async (userHash, avatar) => {
    if (!em.value || !currentUserHash.value || !contactsMap.value[userHash]) return false;
    await writeContacts({ [userHash]: { user_hash: userHash, avatar } });
    return true;
  };

  // What a contact keeps in the contacts slot, out of whatever the caller
  // holds: saveContact is handed whole view objects that mix in network card
  // fields. `confirmed` (with `confirmedAt`) marks a contact whose key was
  // checked in person, through the QR handshake: the only kind a recovery
  // share may be issued to. It is set by confirmContact alone; a save leaves
  // whatever the stored contact says, unless it changes the contact's key —
  // the confirmation was of the old one (mergeContactEdit) — and a delete
  // takes it back.
  const STORED_FIELDS = ['name', 'notes', 'hidden', 'contact_pkey'];
  const storedFields = (data) =>
    Object.fromEntries(STORED_FIELDS.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));

  // Every write is a patch of the list the server holds, not this tab's copy:
  // it is merged onto the stored list when it is signed, so another tab's
  // confirmation survives, and a tab whose load had not finished cannot write
  // a list of one over every other contact. The edit shows at once, and the
  // server's answer replaces it — unless a later edit has shown since (its
  // own answer will), or the account changed while the write was out, in
  // which case it belongs to nobody here.
  // A write the server does not take is taken back. Each edit still out keeps
  // what the contacts it touches showed before it, and each contact remembers
  // the newest edit of it the server has taken. A failed edit leaves a contact
  // alone when the server has taken a newer edit of it, hands what to go back
  // to on to the next newer edit of it still out, and otherwise restores it.
  // All of this belongs to one session: logout starts a new one, and an edit
  // from an earlier session changes nothing when it settles.
  let contactsEdits = 0;
  const newContactsSession = () => ({ editsOut: [], acceptedOf: {} });
  let contactsSession = newContactsSession();

  const takeBack = (session, failed) => {
    const shown = { ...contactsMap.value };
    for (const [hash, previous] of Object.entries(failed.before)) {
      if ((session.acceptedOf[hash] ?? 0) > failed.generation) continue;
      const newer = session.editsOut.find((e) => e.generation > failed.generation && hash in e.before);
      if (newer) newer.before[hash] = previous;
      else if (previous === undefined) delete shown[hash];
      else shown[hash] = previous;
    }
    contactsMap.value = shown;
  };

  const writeContacts = async (edits, { onDevice = false } = {}) => {
    const account = currentUserHash.value;
    const session = contactsSession;
    const generation = ++contactsEdits;
    const shown = { ...contactsMap.value };
    const edit = { generation, before: {} };
    for (const [hash, change] of Object.entries(edits)) {
      edit.before[hash] = shown[hash];
      if (change === null) delete shown[hash];
      else shown[hash] = mergeContactEdit(shown[hash], change);
    }
    contactsMap.value = shown;
    session.editsOut.push(edit);
    const stillCurrent = () => currentUserHash.value === account && contactsSession === session;
    let next;
    let status = 'synced';
    try {
      if (onDevice) ({ contacts: next, status } = await em.value.saveContacts(edits));
      else next = await em.value.patchContacts(edits);
    } catch (e) {
      session.editsOut.splice(session.editsOut.indexOf(edit), 1);
      if (stillCurrent()) takeBack(session, edit);
      throw e;
    }
    session.editsOut.splice(session.editsOut.indexOf(edit), 1);
    for (const hash of Object.keys(edits)) {
      session.acceptedOf[hash] = Math.max(session.acceptedOf[hash] ?? 0, generation);
    }
    if (stillCurrent() && generation === contactsEdits) {
      contactsMap.value = Object.fromEntries(next.map((c) => [c.user_hash, c]));
    }
    return status;
  };

  const saveContact = async (userHash, contactData) => {
    if (!em.value || !currentUserHash.value) return false;
    const status = await writeContacts({ [userHash]: { ...storedFields(contactData), user_hash: userHash } }, { onDevice: true });
    return { status };
  };

  /**
   * Marks a contact as met in person — adding it if it is not a contact yet —
   * after the optical handshake (docs/task-handshake-pq2.md §6). It trusts no
   * caller, and checks that `card`:
   * - is `userHash`'s card: user_hash is SHA3-512 of its sign_pkey;
   * - is signed by that key, and certifies its contact_pkey with it;
   * - is not a deleted account's;
   * - certifies `contactPkey`, the key the handshake proved in person.
   * Anything else is refused, and nothing is written. The stored key is
   * `contactPkey`; `confirmedAt` is set here.
   *
   * Done once the contact is durable on this device; resolves to
   * `{ status }`, where anything but 'synced' means the server does not have
   * it yet ('awaiting-approval': this account's writes wait for the device
   * owner). The device-access vouch does not wait for that: it is a row of
   * its own, which the device takes whatever it holds of this account's
   * contacts.
   */
  const confirmContact = async (userHash, card, contactPkey, fields = {}) => {
    if (!em.value || !currentUserHash.value) return false;
    const vouch = typeof contactPkey === 'string' ? contactKeyVouch(card, userHash, contactPkey) : { ok: false, why: 'another-key' };
    if (!vouch.ok) {
      throw new Error(vouch.why === 'deleted'
        ? 'This contact cannot be confirmed: their account is deleted'
        : 'This contact cannot be confirmed: their card does not certify the key they showed in person');
    }
    const account = currentUserHash.value;
    const { contact_pkey: _ignored, ...kept } = storedFields(fields);
    const status = await writeContacts({
      [userHash]: {
        ...kept,
        user_hash: userHash,
        contact_pkey: contactPkey,
        confirmed: true,
        confirmedAt: Math.floor(Date.now() / 1000),
      },
    }, { onDevice: true });
    await setDeviceAccess(account, userHash, true);
    return { status };
  };

  const setDeviceAccess = async (account, userHash, granted) => {
    try {
      await em.value.setContactAccess(account, userHash, granted);
    } catch (e) {
      console.warn(`[contacts] device access for a contact was not ${granted ? 'granted' : 'revoked'}:`, e);
    }
  };

  const deleteContact = async (userHash) => {
    if (!em.value || !currentUserHash.value) return false;
    const account = currentUserHash.value;
    const status = await writeContacts({ [userHash]: null }, { onDevice: true });
    await setDeviceAccess(account, userHash, false);
    return { status };
  };

  const getUserByHash = (userHash) => {
    return allNetworkUsers.value.find(u => u.user_hash === userHash) ||
      myLocalUsers.value.find(u => u.user_hash === userHash);
  };

  const getMyUserByHash = (userHash) => {
    return myLocalUsers.value.find(u => u.user_hash === userHash);
  };

  const exportBackup = async () => {
    if (!em.value) throw new Error('Not signed in.');
    const keys = await em.value.exportVaultKeys();
    // The guardian seed travels with the other keys: a restored account or a
    // linked device derives the same guardian keys.
    const metaSeed = await em.value.guardianMetaSeed();
    if (metaSeed) keys.meta_seed = metaSeed;
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

  const importBackup = async (backupData) => {
    if (isAuthenticated.value) {
      await logout();
    }
    if (!isInitialized.value) {
      await initialize();
    }
    const { identity, keys } = backupData;
    if (!identity?.name) identity.name = 'Imported Account';
    const result = await em.value.importVaultKeys(keys, identity);
    // importVaultKeys signs in at the manager level only; the store's side of
    // a session is the same as after login, or the import lands on the login
    // page with no contacts.
    if (result.status === 'active') afterSignIn(identity);
    return result;
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

  // The optical handshake's post-quantum step (docs/task-handshake-pq2.md §5).
  const signHandshakePQ = async (message) => {
    if (!em.value) throw new Error('Not signed in');
    return await em.value.signHandshakePQ(message);
  };

  const signedOwnCard = async () => {
    if (!em.value) return null;
    return await em.value.signedOwnCard();
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
    confirmContact,
    cacheContactAvatar,
    setOwnAvatarImage,
    deleteContact,

    initialize,
    registerNewUser,
    login,
    logout,
    endSession,
    deleteAccount,
    destroyAccount,
    updateCurrentUserName,
    updateCurrentUserProfile,
    refreshMyLocalUsers,
    refreshNetworkUsers,
    refreshAllData,

    getUserByHash,
    getMyUserByHash,

    exportBackup,
    importBackup,
    signContactChallenge,
    signHandshakePQ,
    signedOwnCard,

    setEncryptionManager: (manager) => {
      em.value = manager;
      // a replacement manager is a new event source — rebind or the refs
      // silently stop tracking auth
      bindAuthListener(manager);
      syncAuthState();
    }
  };
});
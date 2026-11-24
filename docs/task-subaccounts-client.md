# Task: subaccounts in the client — personas, adding accounts, switching

**Status:** decisions of 2026-11-24 applied. Open: whether all server
instances sync with each other (affects only accounts from other servers, see
§ Accounts from other servers).
**Sources:** `chat` `main`: `docs/pq/reqs/pq_subaccounts.proposed.md` (this task
is its client side; the decisions below amend it), `pq_notes_to_self.proposed.md`
(derived identities, already in the client).
SDK `@buckitup/pq-client` 1.0.1. **Frontend base:** `chat-frontend` `main` at `b687fa6`.
**Before this task:** notes to self (`docs/task-notes-client.md`), which builds
the derived-identity machinery this task reuses.

## Goal

One sign-in, several identities. The person signs in to their **master**
account with its passkey, as today, and then acts as any of their other
identities without another passkey:
- **personas** created inside the master, derived from its keys;
- **accounts added** from a backup file, from another device or domain by
  device link, or from another account on this device.

## Out of scope

- Venues (origins). Partners run their own instance of the server on their
  domain with their own frontend; this client does not manage venues.
- Talking to several servers from one client (subaccounts phase 3).
- Delegation (phase 4), rooms (`pq_rooms.proposed.md`), the `device_webrtc`
  meeting point.
- Unread counters or incoming messages for identities that are not active:
  like other accounts on the device today, an inactive identity gets nothing
  until the person switches to it.

## Terms

| Term | Meaning |
|---|---|
| **Master** | The account the device's passkey opens. A per-device fact: each device opens one master |
| **Persona** | An identity derived from an account's keys and an index; that account can always derive it again |
| **Keyring** | A slot in an account's User Storage with the full keys of the accounts added to it |
| **The person's set** | The master, its personas, its keyring entries, and recursively the personas and keyrings of every account in it |
| **Activate** | Act as an identity of the set: sign, prove keys, read as it |

## What exists

| Piece | Where |
|---|---|
| One signed-in account per tab; switching accounts is logout and login | `EncryptionManagerPQ.login` / `logout`, `#openAccountLocally`, `#activateSession`; `Account_Selector.vue` |
| Identities derived from the account, a per-signer outbox, the owner gate for derived cards | `src/lib/data/sessionIdentities.ts`, `src/lib/notes/derivedCard.ts`, `ingest.ts` (notes PR #89, follow-ups #130) |
| The payload that moves an account: `{ identity, keys }` | `exportBackup`, `src/lib/backupContents.ts`; file, community shares, device link and passkey copy all use it |
| Moving an account today creates a vault of its own | `importVaultKeys` |
| Device link | `Modal_Link_Device.vue` (shows the code, receives), `Modal_Link_Approve.vue` (reads the code, sends); `useLinkRoom.js` joins `room:<id>` on the build's `API_URL`; the code is `<room>.<fingerprint>` (SDK `deviceLink.ts`) |
| Local stores | L2/L3 encrypted under the active account's `crypt_skey` (`docs/persistence-encryption.md`), so each identity's local data is its own |

## Personas

Derived like the notes identity, from the creating account's keys and an index:

```
IKM  = sign_skey || crypt_skey                    # the creating account's
salt = "buckitup/persona/v1"
info = I2OSP(index, 4) || label                   # label and lengths as for the notes identity:
                                                  # "sign" 32 → ML-DSA-87, "crypt" 64 → ML-KEM-1024,
                                                  # "contact" 48 → secp256k1, "evm" 48 → secp256k1 (both as contact),
                                                  # "meta" 32 → meta_seed
```

- Golden vectors in the SDK, next to the notes derivations.
- The card name is the one the person chooses: contacts see the persona by it.
- The list lives in the creating account's slot `personas`:
  `{ "personas": { "<index>": { "name": "…", "created_at": 0 } } }`, `$keyed`.
- **Creating needs the server:** the next index is the lowest one with neither
  a slot entry nor a card on the server, and the card is published at once,
  through the owner gate derived cards already pass (an identity the account
  creates never becomes the owner of a server without one; the gate keys on
  derived signers today, so the persona's card needs it explicitly).
- **Recovery without the slot:** derive indexes 0, 1, 2… and look their cards
  up; stop after 5 indexes in a row without a card. Names come back from the
  cards. The lookups tell the server the hashes belong together; acceptable,
  like the connection-level link the notes spec accepts.
- A persona cannot be cut off from its account, which can always derive it
  again. Removing it from the list hides it; for an identity that must leave
  the person, use an added account instead.
- No secret key of a persona is stored anywhere.

## Added accounts: the keyring

A named slot `keyring` in the master's User Storage, `$keyed`, one entry per
account:

```json
{ "entries": {
    "<user_hash>": {
      "label": "…",
      "server": "https://…",
      "card": { "...": "the account's public user_cards row" },
      "keys": { "...": "exactly the keys object of exportBackup" },
      "added_at": 0
} } }
```

- **`keys`** is what a backup of the account carries: `sign_skey`,
  `crypt_skey`, `contact_skey`, `evm_skey`, `meta_seed`. With all of them the
  account keeps its guardian role, can manage its own community backup, and
  can be exported again whole. (The chat spec lists four keys; amended.)
- **`server`**: the account's own server. Device link sends it; for a file the
  client asks, defaulting to the app's server.
- Every entry is checked before it is written and when it is read: `user_hash`
  matches `sign_pkey`, the signing key signs for it (`assertBackupConsistent`),
  the KEM key decapsulates a test encapsulation to `crypt_pkey`. A failing
  entry is listed as damaged and never activated.
- Secret keys are read from the slot only to activate the account and wiped
  when it stops being active.
- **Entries are removed only by the person** ("Detach", after offering an
  export). Nothing else removes an entry, switching the master included.

### Adding an account

Three sources, one ending: the `{ identity, keys }` payload passes the entry
checks and becomes an entry. Adding the master, or an account already in the
set, is refused with a message.

1. **Backup file:** the existing restore picker and password.
2. **Device link:** the master's app shows a code ("Add account"); the other
   app — another device, or another domain on this device, where the code is
   copied from one tab and pasted in the other — uses its "Connect a device"
   and sends as today, plus its server. The receiving side writes the keyring
   entry instead of calling `importVaultKeys`.
3. **Another account on this device** (in the account selector): opened with
   its own passkey; its payload goes into the keyring.

The added account keeps its own vault, passkey and backups wherever it has
them; nothing is removed.

### Device link across servers

Both apps meet in a relay room on a server, each on its own build's server.
Apps on two domains with different servers never meet. The code names the
server of the app that shows it: `<room>.<fingerprint>@<origin>` (exact format
in the SDK); the other app joins that server; a code without a server means
the app's own, as today. HTTPS only, localhost excepted. The backend socket
already accepts any origin (`lib/chat_web/endpoint.ex`, `check_origin: false`).
Trust does not change: the server only relays; the fingerprint and the
six-digit comparison prove who is at the other end. Deployments with a
Content-Security-Policy need `connect-src` open for `wss:`.

### Accounts from other servers

The client talks to its build's server only. An account whose `server` is
another one works here once its data reaches this server by server-to-server
sync, which the backend provides. Until then it is listed with its server and
shows what this server has. (Open: whether every instance, partners' included,
syncs with ours.)

## Activating an identity

Activating identity S gives the same app as signing in to S alone, minus the
passkey:

1. Tear down the active context as `logout()` does — session ended, outbox
   drain stopped, notes dropped, storage codec and slot resolver reset, read
   sessions, relay credentials, gate and read cache cleared — **except** that
   the master's vault stays open.
2. Open S with its keys (derived for a persona, from the keyring entry for an
   added account), the way `login()` continues after `#openAccountLocally`:
   leader election for S, the card check of sign-in, `#activateSession(S)`.
3. Back to the master: the same, with the keys read from the open vault.

Rules:
- **Nothing ties S to the master on the server.** While S is active nothing is
  signed or proven by the master. Writes to the master's `personas` and
  `keyring` slots happen only while the master is active.
- **Code that reads the vault or the local account list must read the active
  identity instead:** `exportVaultKeys` (it takes `sign_pkey`/`crypt_pkey`
  from `#localUserCards`), `guardianMetaSeed` (from the vault), `ownerKeyOf`
  (`evm_skey` for community backup), `#signingKeyOf`. Passkey recovery stays
  the master's and is hidden while S is active. A community-backup recovery
  in progress (`loadRecoveryProgress`) belongs to a standalone account only.
- S's notes need no extra code: they derive from the active keys.
- S's pending writes stay in its outbox and drain when S is active again.
- Logout ends everything: the master's vault locks, every key is wiped.
- A reload comes back as the master.

## The person's set

The switcher lists the whole set: the master's personas and keyring, and,
for every account in the keyring, its own personas and keyring, recursively,
each identity once. A device therefore sees everything the person has added
on any device, whichever account it opens as master, and no state has to be
kept in step across devices. Reading another account's slots means reading
its User Storage with its keys (from the keyring), as that account.

## Switching the master

Per device, no coordination with other devices:
1. The new master is an added account of the set. A persona cannot become a
   master for now: it is a derivation of its account and has no backups of
   its own.
2. If the old master is not in the new master's keyring, add it (full keys).
3. Re-lock the device's vault around the new master's keys under the same
   passkey.

Other devices keep their own master. Backups need nothing new: a restore of
any account of the set leads to the whole set through the chain. The passkey
copy on the server still restores the account it was made for, which leads
to the rest. The client may suggest a community backup for the new master,
offering the guardians of the old one; nothing depends on it.

## Backups

- What a backup holds does not change. Any restore of an account brings back
  its User Storage, with its personas list and keyring, and through them the
  set.
- Personas restore even without User Storage (§ Personas, recovery).
- The master's Backup Center says: "N identities come back with this account".

## UI

No design yet; the minimum until there is one:
- the active identity is always visible in the account sidebar;
- the switcher: the set, damaged entries listed but not activatable;
- "New persona" and "Add account" (file, device link, from this device);
- per identity: export (added accounts), detach (added) or hide (persona),
  rename; "Make master on this device" (added accounts).

## PRs

| # | Scope | Depends on |
|---|---|---|
| 1 | SDK: persona derivations with golden vectors; device-link code with a server | — |
| 2 | Activation and back; vault reads through the active identity; minimal switcher | notes task |
| 3 | Personas: slot, create, recovery scan | 1, 2 |
| 4 | Keyring slot, entry checks; add from a file or this device | 2 |
| 5 | Add by device link (receiving into the keyring, `server`) | 1, 4 |
| 6 | The person's set across keyrings; export, detach, Backup Center line | 4 |
| 7 | Switching the master | 6 |

## Acceptance

- [ ] One passkey prompt per session: switching to any identity and back asks for none.
- [ ] Every row and proof made while S is active is signed by S, none by the
      master (fake-server test checks the PoP against each row's author).
- [ ] S's contacts, dialogs, notes and settings are S's own; the master's are
      not visible while S is active, and the reverse.
- [ ] Logout wipes the keys of every identity; a reload returns as the master.
- [ ] A persona's card on a server without an owner waits, as notes cards do.
- [ ] Personas come back after a restore with the `personas` slot removed.
- [ ] An account added from a file, a device link or this device works as it
      did standalone, including its guardian role; its own vault elsewhere
      keeps working.
- [ ] A device link between two apps with different servers transfers an
      account; a code without a server behaves as before.
- [ ] An account added on device 1 appears on device 2 whose master is a
      different account of the set.
- [ ] Switching the master on one device changes nothing on the others;
      restoring the old master from its backup brings back the whole set.

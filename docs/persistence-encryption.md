# Local storage: the layers and their encryption

Hiding metadata on the client is not required (CTO decision, 2026-08-19):
access control for metadata starts at the backend. End-to-end encryption of
content (`content_b64`, `value_b64`) is part of the protocol and holds
regardless of anything below. This document describes which local layers exist,
which of them are encrypted, what that means for the code, and when the browser
may delete them.

---

## What lives where

| Layer | Storage | State | Record key | Value |
|---|---|---|---|---|
| **L3 — outbox** | IndexedDB `buckitup-outbox` | encrypted | opaque sortable id | AES-GCM |
| **L2 — localStore** | IndexedDB `buckitup-local-store` | encrypted | HMAC-derived name | AES-GCM |
| **L1 — collection cache** | OPFS `buckitup-shapes` | on by default | — | plaintext (wa-sqlite) |

L2 and L3 are encrypted through `secureStore` (`src/lib/data/secureStore.ts`):
AES-GCM-256 with a key from PBKDF2 (100k) over the account's `crypt_skey`, salt
`buckitup-local-storage-v1`. That salt is separate from the content-encryption
salt (`avatar-encryption`), so compromising one derived key does not hand over
the other. Every write gets its own random IV: rewriting the same content is
indistinguishable from changing it.

Encrypting L2/L3 is a property of the implementation rather than a requirement:
a new store may write to IndexedDB directly. `secureStore` stays available for
when one account's records must not be readable by another in the same browser.

## What L2/L3 encryption covers

The whole envelope is encrypted: `user_hash`, `dialog_hash`, `message_id`,
timestamps and signatures, not only the payload.

What remains visible through IndexedDB itself:

- the number of records and their approximate size;
- the order in which outbox records appeared — that key sorts by time (and
  carries no identifiers).

## L1 is on by default

`@tanstack/browser-db-sqlite-persistence` writes its OPFS file in plaintext,
which is acceptable. The layer is on (`src/lib/data/persistence.ts`): it buys a
warm start — collections show their rows before the network answers — and a
shape stream resumed from the stored offset instead of fetched whole. Where OPFS
is missing (no secure context, no Worker, an old WebKit, some private windows)
the layer does not open and collections run in memory with a full shape fetch
on start.

It can be turned off to debug a sync problem without the cache in the way:

- at build time — `VITE_SHAPE_PERSISTENCE=0`;
- on a deployed build — `localStorage.buckitup_shape_persistence = '0'`.

## When the browser deletes local data

Everything above lives in the browser's storage for the app's origin, and part
of it exists nowhere else:

| Data | Where | Recoverable from the server |
|---|---|---|
| Secret keys (vault) | IndexedDB `keyval-store` (`@lo-fi/local-vault`) | No: only from a backup |
| Unsent writes, captured actions | IndexedDB `buckitup-outbox`, `buckitup-intents` | No |
| Own text before acceptance, drafts, unaccepted settings | IndexedDB `buckitup-message-projections`, `buckitup-local-store` | No |
| Collection cache | OPFS `buckitup-shapes` | Yes |
| Encrypted file chunks (LRU, 512 MiB budget) | IndexedDB `buckitup-chunks` | Yes, while the file is on the server |
| Card and dialog read caches | IndexedDB `user-synced-cache`, `dialog-synced-cache` | Yes |

A browser deletes an origin's storage without asking:

- **under storage pressure**, while the storage is *best-effort* (the default).
  Chromium evicts whole origins, least recently used first; Firefox and Safari
  do the same within their quotas. *Persistent* storage —
  `navigator.storage.persist()` granted — is exempt;
- **in Safari, after seven days of browser use without a visit** (ITP). An app
  added to the Home Screen counts its own days of use, so time away from it
  does not count against it;
- **when a private window closes**;
- **when the person asks for it**: "clear site data on close", clearing history
  with site data, cleaner apps.

A passkey usually survives all of these, since it syncs through the platform's
password manager. The vault it opens does not.

`persist()` is granted differently per browser: Chromium decides silently (it
grants to an installed, bookmarked or much-used app, or one allowed to send
notifications), Firefox asks the person with a prompt, Safari applies its own
heuristics, and installing to the Home Screen is the reliable path there. The
app calls `persist()` at startup (`src/main.js`) and on each chunk download
(`src/lib/data/chunkCache.ts`).

## The storage status

`src/lib/storageStatus.ts` reads what the browser says about the origin's
storage; `src/composables/useStorageStatus.ts` keeps the answer, read whenever a
screen asks. Reading asks for no permission: it calls `persisted()`,
`estimate()` and `getDirectory()`, and writes and removes one localStorage key.

| Status | Meaning | Detection |
|---|---|---|
| `persistent` | the browser will not clear the data under pressure | `persisted()` is true |
| `best-effort` | the browser may clear it | `persisted()` is false |
| `ephemeral` | a private window: the data goes when it closes | heuristic, below |
| `unknown` | the browser does not say | the Storage API is missing (an insecure context, an old browser) or `persisted()` failed |

A private window cannot be asked about directly, so the check collects signals:
a quota from `estimate()` below 120 MiB, the Origin Private File System
refusing to open (Firefox private windows reject `getDirectory()` with a
SecurityError, Safari's with "unknown transient reason"), and localStorage
refusing a write. Any one of them makes the status `ephemeral`, unless
`persisted()` is true: browsers do not grant persistence to a private window.

The heuristic misses and over-reports in known ways:

- current Chromium incognito windows report a normal-looking quota and open
  OPFS, so they read as `best-effort`;
- a nearly full disk shrinks the quota of a normal window, and a storage error
  unrelated to privacy refuses OPFS or localStorage: both read as `ephemeral`.

The status comes with whether the app runs installed (`display-mode:
standalone`, or `navigator.standalone` on iOS) and the usage and quota from
`estimate()`.

Account → **Storage on this device** (`/account/storage`) shows the status as
one plain line and, under Details, the probe table: `persisted()`, usage and
quota, installed, the private-window signals, whether the account has a
finished community backup, platform and user agent. Its **Request persistence**
button calls `persist()` and shows `persisted()` before and after (Firefox
shows its prompt), and **Copy** puts the table on the clipboard as text, for
results from real devices.

Whether a backup exists is known only for the community backup: a finished,
not revoked run in the account's `recovery_backup` slot, the record Backup
Center shows. A file backup leaves no record — the file is handed to the
browser's download — so the device cannot tell whether one was made.

## A consequence of L2/L3 encryption: data is readable only after login

The key exists while the account is unlocked. Therefore:

- the queue and local `user_storage` revisions are unreadable before login;
- `drainPendingWrites` runs after login (`EncryptionManagerPQ.js`) and on the
  `online` event;
- an unreadable record is **never deleted**: "does not decrypt" usually means
  "belongs to another account", and wiping it would destroy that account's
  unsent writes. Only a record that decrypted but failed to parse is removed.

## Migrating records written before L2/L3 encryption

Both migrations are lazy, one record at a time, with no sweeping pass:

- **outbox** — a record starting with `{` was written in the clear; its owner
  re-reads it and rewrites it encrypted. Records belonging to others stay as
  they are until their owner logs in: there is no key for them, and deleting
  them is not an option.
- **localStore** — a plaintext value sits as an object under the readable name
  `us|<user_hash>|<uuid>`. On the first read it moves to the derived name and
  the readable copy is deleted.

## Manual verification

Covered automatically: `tests/secureStore.test.ts`,
`tests/outboxEncryption.test.ts`, `tests/localStore.test.ts` (25 tests),
including "no readable `user_hash` / `dialog_hash` on disk" and "another
account's record is neither deleted nor served".

With a live account (needs WebAuthn, hence not automated):

1. Log in, send a message, change the profile.
2. DevTools → Application → IndexedDB → `buckitup-outbox` and
   `buckitup-local-store`. Neither names nor values should contain `u_…`,
   `di_…`, `us|`, or `owner_timestamp`.
3. Go offline, send a message → a record appears in `buckitup-outbox`
   (unreadable). Go back online → the record disappears and the message is
   delivered.
4. Reload the tab with a non-empty queue → after login it is delivered exactly
   once, with no duplicates.
5. A second account in the same browser: its login must not wipe the first
   account's queue (`buckitup-outbox` keeps both records).

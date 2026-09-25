# Local storage: the layers and their encryption

**Branch:** `docs/tanstack-migration`

Hiding metadata on the client is not required (CTO decision, 2026-08-19):
access control for metadata starts at the backend. End-to-end encryption of
content (`content_b64`, `value_b64`) is part of the protocol and holds
regardless of anything below. This document describes which local layers exist,
which of them are encrypted, and what that means for the code.

---

## What lives where

| Layer | Storage | State | Record key | Value |
|---|---|---|---|---|
| **L3 — outbox** | IndexedDB `buckitup-outbox` | encrypted | opaque sortable id | AES-GCM |
| **L2 — localStore** | IndexedDB `buckitup-local-store` | encrypted | HMAC-derived name | AES-GCM |
| **L1 — collection cache** | OPFS `buckitup-shapes` | behind a flag | — | plaintext (wa-sqlite) |

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

## L1 is behind a flag

`@tanstack/browser-db-sqlite-persistence` writes its OPFS file in plaintext,
which is acceptable. The layer is off by default
(`src/lib/data/persistence.ts`) pending a separate decision to enable it: that
decision is about performance (a warm start, fetching the delta from a stored
offset) and about OPFS support in the target browsers, not about security.
To enable:

- at build time — `VITE_SHAPE_PERSISTENCE=1`;
- on a deployed build — `localStorage.buckitup_shape_persistence = '1'`.

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

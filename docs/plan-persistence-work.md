# Work plan: persistence, encryption, moving writes onto transactions

**Date:** 2026-08-12
**Branch:** `docs/tanstack-migration`
**Base commit:** `f5386a1` — "shape persistence and durable outbox on the
official TanStack stack" (written by a parallel agent)

---

## 0. What changed since the previous plan

The parallel agent **has already implemented and committed** two of the three
layers:

- **L1 — collection persistence:** `persistence.ts`, wa-sqlite over OPFS, the
  `persisted()` wrapper in `collections.ts`, `initPersistence()` in `App.vue`.
- **L3 — durable outbox:** `outbox.ts` on the primitives of
  `@tanstack/offline-transactions` (`IndexedDBAdapter`, `WebLocksLeader`,
  `BackoffCalculator`), wired into `ingest.ts` (`enqueue`, `drainOutbox`,
  `drainPendingWrites`).

That changes what your decisions mean: they were taken as "what to do", and part
of it is already done. What follows from that is below.

---

## 1. Your decisions and what to do with them

| Decision | Status | Action |
|---|---|---|
| **Defer L1** | ⚠️ conflict: L1 is already written and committed | a choice is needed: revert, hide behind a flag, or revisit the decision (§2) |
| **Local data available after login — fine** | ✅ | folded into the encryption design |
| **Write path → TanStack DB transactions** | ⚠️ the agent took another route and argued for it | see §4 — the argument is strong, I suggest revisiting |

---

## 2. L1: "defer" versus code that already exists

**Why the decision was taken at all:** the official SQLite persistence writes to
disk in plaintext, while your requirement is that everything local be encrypted.
`openBrowserWASQLiteOPFSDatabase` has no key option.

**What actually leaks** (worth repeating, because it sets the price of the
question): message contents do **not** reach the disk in the clear —
`content_b64`, `refs_map_b64`, `type_b64`, `value_b64` are end-to-end encrypted
before they ever enter a collection. What ends up readable is metadata:
`user_hash`, `dialog_hash`, `sender_hash`, `owner_timestamp`, signatures, and
**contact names** (`user_cards.name` — public by protocol and stored in the
clear on the server).

So from the disk one recovers **the social graph, the timings and the names**,
but not the correspondence.

**Three options, one of which has to be chosen:**

| | Option | What we do | Price |
|---|---|---|---|
| **2A** | Hide behind a flag | `initPersistence()` runs only under an explicit flag; off by default | ~20 lines, the code survives, we enable it after encryption |
| **2B** | Revert L1 | revert part of `f5386a1` | finished work is lost; bringing it back later costs more than not deleting it |
| **2C** | Leave it on as an agreed exception | record in the doc that metadata is readable on disk | the requirement is broken knowingly |

**I recommend 2A.** Your "defer" decision is honoured literally (there is no
persistence in production), no work is thrown away, and enabling it is one line
once encryption exists. The revert (2B) is the worst of the three: it destroys
finished code for the same result the flag gives.

---

## 3. The main thing that does not meet the requirement right now

**The outbox writes in plaintext too.** In `outbox.ts`:

```js
let storage = new IndexedDBAdapter(DB_NAME);
```

No encryption anywhere. And what it stores is **whole signed mutations** — so
IndexedDB holds `user_hash`, `dialog_hash`, `message_id`, timestamps and
signatures in the clear. The content (`content_b64`) inside the mutation is
encrypted; the envelope around it is not.

This contradicts the requirement directly and, unlike L1, **has a supported
fix**: `StorageAdapter` is a string interface (`get`/`set`/`delete`/`keys`/
`clear`), and `outbox.ts` already has a test hook for swapping the adapter. The
extension point is ready — an encrypting wrapper goes into it.

**This is the plan's top priority:** the unencrypted outbox appeared only just
now, and the sooner it becomes encrypted the fewer devices accumulate readable
data.

---

## 4. On moving writes onto TanStack DB transactions

You decided to move. The agent took a different route and **argued for it in the
code**:

> The package's full OfflineExecutor is not used: it replays through a static
> collection registry, and dialog collections are created lazily per
> dialog_hash, so the executor could not resolve them after a reload. Our
> mutations don't need a collection to replay anyway — they are self-contained
> signed rows.

I checked, and the argument holds. `OfflineExecutor` takes
`collections: { name: collection }` as a static map at startup. Our dialog
collections are created lazily per `dialog_hash` and evicted by LRU (eight of
them) — after a reload the executor physically cannot resolve the collection for
a dialog that has not been opened yet.

It can be worked around (pre-create the collections of every dialog in the queue
at startup), but the price is rebuilding a settled write path to obtain what
already works: durable storage, a leader tab, backoff — all taken from the same
package, just assembled by hand.

**I suggest revisiting decision №3** and keeping the current hybrid. It uses the
official primitives where they fit and does not drag `OfflineExecutor` into a
place where it does not sit on our lazy collection model.

If you do want the full move, it is a large separate stage, and I would do it
**after** encryption rather than instead of it.

---

## 5. Noticed along the way: a trade-off in the outbox design

The agent stores **signed** mutations. That simplifies everything (a record is
self-contained, survives the loss of a key, replays safely) but has a consequence
worth knowing:

The signature fixes `parent_sign_hash` and `owner_timestamp` **at creation
time**. If a record sat in the queue while the same message was edited from
another device, it arrives stale. The server will not apply it (rightly: a fresh
revision must not be overwritten by an old one), but **the user's edit is lost**,
marked permanent.

The alternative — storing an intent and signing at delivery — is more complex and
needs the key at send time. On a single device the difference is invisible; on
several devices it is not.

**This is a deliberate trade-off, not a bug.** I suggest recording it in the docs
and returning to it if multi-device becomes a priority. It needs no decision now.

---

## 6. Proposed order of work

### Stage 1 — the storage crypto wrapper `secureStore.ts`
AES-GCM over any string storage. The key comes from the vault
(`EncryptionManagerPQ`), a unique nonce per write, namespaced by `user_hash`.

**Why:** a shared foundation for stages 2 and 3, so it is not written twice. The
interface matches `StorageAdapter` from `offline-transactions` so it drops in
without adaptation.

**Tests:** a round trip encrypts and decrypts; another key cannot read it; a
missing key is an explicit error rather than an empty result.

### Stage 2 — encrypting the outbox (priority)
Put the wrapper into `outbox.ts` in place of the bare `IndexedDBAdapter` (the
test hook is already there). Migration: records written before encryption are
read in the clear once and rewritten.

**Why first:** it is the only place writing unencrypted user data right now, and
it is active.

**Dependency:** the queue becomes readable only after login. Check that
`drainPendingWrites` runs after unlock rather than at startup.

### Stage 3 — encrypting `localStore` (L2)
The same move. It also closes a long-standing gap: `user_hash`, timestamps and
signatures sit there in the clear today (only `value_b64` is encrypted).

**Why:** the gap is mine, it came from an oversight, and the requirement closes
it.

### Stage 4 — a flag for L1
`initPersistence()` behind an explicit flag, off by default; the doc says why.

**Why:** it executes your "defer" decision without destroying the code.

### Stage 5 — tests and a live check
- a write while the node is unreachable → the queue → delivery after recovery;
- reloading a tab with a non-empty queue → delivery after login, no duplicates;
- a permanent rejection → dependent records are skipped, independent ones are
  delivered;
- a DevTools check that IndexedDB holds no readable `user_hash` / `dialog_hash`.

**Why:** the DevTools item is the only way to demonstrate the requirement is met
rather than to believe it.

### Stage 6 (separate) — encrypting L1
A custom VFS over wa-sqlite (`vfsName` is a documented extension point). Large
and crypto-critical; start it after stages 1–5 are closed and stable.

---

## 7. What is needed from you before starting

1. **Confirm 2A** (a flag instead of a revert) — or choose 2B/2C.
2. **Confirm revisiting decision №3** — we keep the hybrid outbox and do not
   adopt the full `OfflineExecutor`. Or you insist, and then it is a separate
   stage after encryption.
3. Note §5 (the signed-mutation trade-off) — it needs no decision, but it is
   better known than not.

Once answered, I start with stage 1.

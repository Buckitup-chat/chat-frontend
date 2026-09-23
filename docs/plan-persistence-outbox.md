# Plan: persisting local state and the outbox

**Date:** 2026-08-12
**Branch:** `docs/tanstack-migration`
**Status:** a plan; part of the work is already running in parallel (see §2)

---

## 1. Decisions taken

Recorded during the discussion so they are not reopened:

| Question | Decision |
|---|---|
| Lifetime of an unsent write | **unlimited** |
| A permanently rejected record in the queue | **keep going, skipping the records that depend on the rejected one** |
| Data in local storage | **everything is encrypted; every exception is argued and agreed** |
| `localStore` (IndexedDB KV) | **encrypt wholesale**, metadata included |

---

## 2. What is already in flight (another agent)

Collection persistence on the official stack has appeared in the working tree:
`@tanstack/browser-db-sqlite-persistence` (wa-sqlite over OPFS) +
`src/lib/data/persistence.ts` + the `persisted()` wrapper in `collections.ts`.
`@journeyapps/wa-sqlite` and `@tanstack/offline-transactions` are installed as
well. In `vite.config.js` both sqlite packages are excluded from pre-bundling
(otherwise the OPFS worker breaks). `initPersistence()` is called in `App.vue`
before the first collection.

This plan accounts for that work rather than duplicating it: §5 (layer L1)
describes what **has to be added** to it for the encryption requirement, and
§6–7 cover what has not been started (the outbox and KV encryption).

---

## 3. Three layers, not one

"Persistence" splits into three independent stores with different costs of
failure. Confusing them is the mistake to avoid.

| | Layer | Holds | Cost of losing it | Status |
|---|---|---|---|---|
| **L1** | SQLite/OPFS — the collection cache | rows of `user_cards`, `user_storage`, `dialog_*` + the shape cursor | startup speed, reading without a node | in flight |
| **L2** | IndexedDB KV (`localStore.ts`) | local `user_storage` revisions | profile and contact edits | not started |
| **L3** | Outbox | unsent outgoing mutations | **user data is lost silently** | not started |

**L3 is the only layer where data is lost.** L1 is about speed, L2 about local
resilience of settings. That sets the priority if a choice has to be made.

---

## 4. The key constraint: a signature is bound to server state

It shapes the queue, so here it is briefly.

Mutations are signed with ML-DSA against a **known base**: `parent_sign_hash` is
the `sign_hash` of the current revision on the server, and `owner_timestamp`
strictly increases. We decided (finding 1 of the second review) not to sign
against an unknown base. That gives two classes of operation:

- **Class 1, self-contained** — a new message: the client generates
  `message_id`, `parent_sign_hash = null`. It can be signed immediately.
- **Class 2, base-dependent** — editing a message, a reaction, `user_storage`, a
  card rename. Only the **intent** can be stored; signing happens at delivery,
  when the base is known.

`@tanstack/offline-transactions` is built for exactly this: what is persisted is
the **name** of a registered function (`mutationFnName`), not a ready HTTP
payload. At delivery our function is called, and reading the base, choosing
insert or update, and signing all happen inside it. So class 2 is supported
natively, without workarounds.

**Consequence for UX:** signing needs the key from the vault, and the vault is
locked until WebAuthn. So the queue flushes **after login**, not on page load.

---

## 5. The encryption requirement, layer by layer

Here is the plan's main difficulty, and it differs across the three layers.

### L3 (outbox) — solved natively ✅

`StorageAdapter` in `offline-transactions` is a string interface:

```ts
interface StorageAdapter {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  delete / keys / clear
}
```

The library serialises a transaction to a string itself. We supply an adapter
that encrypts on `set` and decrypts on `get` (AES-GCM with the vault key). The
requirement is met through a documented extension point. Record keys are opaque
transaction ids and reveal nothing about the contents.

### L2 (`localStore`) — solved by ourselves ✅

The code is ours, so the values simply get the same encryption. It also closes
an existing gap: **today it holds in the clear** `user_hash`, `owner_timestamp`,
`sign_hash`, `sign_b64`, `parent_sign_hash` (only `value_b64` is encrypted).
That is a deviation from the requirement nobody agreed to — it came from an
oversight.

### L1 (SQLite/OPFS) — **there is no native way** ⚠️

`openBrowserWASQLiteOPFSDatabase` accepts only `databaseName` and `vfsName`.
There is no key option; the words `encrypt` and `cipher` do not appear in the
package at all. So **the official collection persistence writes to disk in
plaintext**.

What exactly ends up readable:

- **Contents are already encrypted** end-to-end: `content_b64`,
  `refs_map_b64`, `type_b64`, `value_b64`. Message text never reaches the disk
  in the clear.
- **Metadata is in the clear:** `user_hash`, `dialog_hash`, `sender_hash`,
  `peer_hash`, `reactor_hash`, `message_id`, `owner_timestamp`, `deleted_flag`,
  signatures and hashes, and **`user_cards.name` — the display names**.

So what sits on disk in the clear is **the social graph, the timings, the volume
of correspondence and the contact names**. For a privacy product that is exactly
the part which usually matters: the content is protected, "who talked to whom
and when" is not.

An important qualification: the same metadata is in the clear on the server too —
otherwise Electric could not filter shapes by `dialog_hash`. But the threat model
differs: the server is the user's own Raspberry Pi, while the device with the
browser may be shared, lost, or seized.

**Options for L1** (a decision is needed):

| | Option | Price | Meets the requirement |
|---|---|---|---|
| **A** | Our own encrypting VFS over wa-sqlite (`vfsName` is a documented hook) | high: our own crypto code at the page level, to be tested and maintained | fully |
| **B** | Build SQLCipher for WASM instead of wa-sqlite | very high: the adapter is hard-wired to wa-sqlite, a fork is needed | fully |
| **C** | Persist only non-sensitive collections (not dialogs) | the main benefit is lost — a warm start of the correspondence | partially |
| **D** | Defer L1 until the encryption decision; do L2+L3 now | none — L1 simply stays off | the requirement is not broken, because the layer is absent |
| **E** | Turn it on with an explicit argument plus measures (wipe on logout, off on shared devices) | none | **a deviation, needs your agreement** |

**My recommendation is D, then A.** The reasoning: L3 (the outbox) is where user
data is actually lost, and it encrypts natively. L1 buys speed rather than
safety, and it is the only one that conflicts with the requirement. It is
sensible not to block the outbox on L1, and not to accept deviation E in haste.

**One clarification that removes the objection to encrypting L1:** it may seem
that encryption defeats the warm start, since the key is available only after
login. It does not — the user has to pass WebAuthn before seeing anything at
all. The warm start stays warm; it is simply measured from the unlock rather
than from the page load.

---

## 6. How the queue works (L3)

### What is persisted

```
transaction {
  id                opaque uuid (the key name in storage)
  mutationFnName    the name of our delivery function
  mutations         collection rows (contents already E2E-encrypted)
  attempts, createdAt, ...
}
```
The library serialises all of it to a string → our adapter encrypts it whole.

### Order and dependencies

FIFO out of the box. On top of it, the agreed rule: **on a permanent rejection we
continue, skipping the records that depend on the rejected one.** Dependency is
simple to determine:

- an edit depends on the message itself (`message_id`);
- a reaction or receipt depends on the message (`message_id`);
- the next `user_storage` revision depends on the previous one (same slot);
- messages are independent of each other.

Implementation: when a record moves to `failed_permanent`, mark every later
record with the same subject (message_id / slot) — they would be rejected anyway,
since their base will never appear.

### Multiple tabs

A leader tab and BroadcastChannel come out of the box (`WebLocksLeader` /
`BroadcastChannelLeader`). Non-leaders work online-only. This is consistent with
`BrowserCollectionCoordinator`, already used in L1.

### The cost of adopting it

One item is substantial: the write path currently **bypasses** the TanStack DB
mutation mechanism — we assemble a signed mutation ourselves and send it
directly (`sendMutationsAndAwaitShape`), which `barrier.ts` states outright. To
use `offline-transactions`, writes have to move to
`collection.insert()/update()` inside a transaction with our `mutationFn`.

That rebuilds a path settled by two rounds of review, so the regression risk is
real. Stage 3 below is therefore split into "one operation first, verify, then
the rest".

---

## 7. Stages

### Stage 1 — the storage crypto wrapper
`src/lib/data/secureStore.ts`: AES-GCM over any string storage, the key from the
vault (`EncryptionManagerPQ`), namespaced by `user_hash`. A separate salt and
nonce per write.

**Tests:** the encrypt-decrypt round trip; another key cannot read it; a missing
key produces a clear error rather than a silent empty result.

### Stage 2 — encrypting `localStore` (L2)
Run the existing KV through the stage 1 wrapper. Migration: read the old
plaintext records once and rewrite them encrypted.

**Consequence for UX:** `user_storage` becomes readable only after login — check
that nothing reads it earlier.

### Stage 3 — the outbox (L3), in steps
1. Start `startOfflineExecutor` with our encrypting adapter **after login**.
2. Move **only sending a new message** to transactions (class 1 — the simplest
   and the most valuable), then verify live with two accounts.
3. Then edits, reactions and receipts (class 2 — materialising the intent inside
   `mutationFn`).
4. Then `user_storage` and the card rename.

**Tests at every step:** a write while the node is unreachable lands in the
queue; after recovery it is delivered exactly once; a permanent rejection skips
dependent records without blocking independent ones.

### Stage 4 — queue UI
An honest status for an unsent message (not "delivered"), an "N unsent" counter,
a reason on `failed_permanent`. Reuse the `reaction-error` pattern from the
second review's fixes.

### Stage 5 — the L1 decision
Per §5: either the encrypting VFS (A), or an agreed deviation (E), or L1 stays
off (D). Until it is decided, keep it out of the production build.

---

## 8. What is needed from you

1. **The L1 decision** (the table in §5). It is the only real blocker: work on it
   is already under way, and without a decision it is unclear whether to take it
   to production or keep it behind a flag.
2. Confirm that "after login" is an acceptable moment for access to any local
   data (a consequence of encrypting all three layers).
3. Agree to the risk in stage 3: rebuilding the write path for the sake of the
   official outbox. The alternative is our own outbox over our KV (~200–300
   lines, no rebuild of the write path, but multi-tab and FIFO are ours to
   write).

# Comparing the TanStack DB migration branches

Two branches solve the same task — moving off PGlite onto Electric shapes +
TanStack DB — with different architectures. This document sets the decisions side
by side, with the merits and drawbacks of each, for a joint discussion before the
target architecture is chosen.

Compared: **`docs/tanstack-migration`** (integration branch —
`tanstack-migration`) and **`feat/user-domain-tanstack-db-migration`**. The state
is taken at commits `309731b` and `018515e` respectively; the numbers and
observations apply to those commits.

---

## 1. Migration coverage

**`docs/tanstack-migration`** — the whole migration: all seven tables (cards,
storage, dialog keys, messages, versions, reactions, receipts), PGlite and its
schemas removed, with collection persistence, a durable outbox and multi-tab
support added.

**`feat/user-domain-…`** — a vertical slice: the user domain (`user_cards` +
`user_storage`). Dialogs run on PGlite; the two engines coexist.

| | Merits | Drawbacks |
|---|---|---|
| `docs/…` | The target state is reached; the PGlite class of problems is closed; cross-cutting properties (outbox, tabs) are exercised across the whole system | A large body of change in one set — harder to review and to roll back |
| `feat/…` | A smaller blast radius per step; the domain can be brought to quality in isolation | The hardest part (append-only dialogs, versions, refs) is still ahead; the two-engine period costs double to maintain |

## 2. The write path

Both branches work without a network: a write lands in a persistent on-disk queue
first and is sent afterwards, so losing the network does not lose it. What differs
is how the queue works and what the calling code sees.

**`docs/…`**: one logical write = one signed mutation. It goes into the durable
outbox (IndexedDB) **before** the first send attempt, then to `/ingest_each`
through `sendMutationsAndAwaitShape`. With no network the attempt fails and the
record stays in the queue; draining on login and on the `online` event replays it
in insertion order. The replay is literal: a mutation carries its own ML-DSA
signature over the row's contents and does not go stale — a live key is needed
only to sign the request's own auth challenge, which is why draining requires an
unlocked account. Errors are classified by the transport (transient / permanent)
and returned to the caller. Covered by `tests/offlineWrite.test.ts`.

**`feat/…`**: a write goes into a persistent queue (`userQueue.ts`) with the
statuses `pending → awaiting_remote → deleted / quarantined`; a scheduler with
debounce and backoff does the sending and skips a cycle when
`navigator.onLine === false`. Repeated edits of one key coalesce into a single
entry (a merge patch).

| | Merits | Drawbacks |
|---|---|---|
| `docs/…` | Simple flow control: the caller gets the result of that particular write; order follows the calls; one queue serves all seven tables | The "what to do on failure" logic is spread across call sites; a call without a network returns an error even though the write will arrive later — in the UI that reads as a rejection |
| `feat/…` | Every write goes through one pipeline; coalescing saves traffic during a run of edits; sending does not start when the browser knows there is no network | Coalescing means last-write-wins semantics, right for a card but not for append-only messages; the caller does not get the result of a specific write; the queue covers only the user domain |

## 3. Delivery confirmation

**`docs/…`**: the server returns a `txid`, and `awaitTxId(txid)` is an exact "the
row reached the collection". A uniqueness conflict is resolved by comparing
signatures: either "our row is already on the server" (success) or an explicit
permanent error.

**`feat/…`**: a snapshot is recorded after sending; confirmation is a match
between the snapshot's fields and the row arriving from the shape (with
bytea/base64 canonicalisation). The `awaiting_remote` state lives in IndexedDB and
survives a reload.

| | Merits | Drawbacks |
|---|---|---|
| `docs/…` | Confirmation is exact and independent of field formats; a conflict always ends in a definite outcome | The barrier lives in memory: after a reload, confirmation is re-derived by replaying the outbox rather than from stored state |
| `feat/…` | The wait for confirmation is durable — it survives a reload without a replay | Field-by-field comparison is sensitive to serialisation drift (a new column, bigint vs number, padding); a mismatch has no outcome — the entry stays in `awaiting_remote` with no error and no timeout, and the overlay keeps hiding the server row |

## 4. Optimistic state

**`docs/…`**: an in-memory layer (`optimisticItems`, `pendingEdits`,
`reactionIntents`) with per-item status (`sending / synced / error`, plus a marker
for a rejected edit). It lives in the tab's memory.

**`feat/…`**: an overlay — TanStack collections projected from the persistent
queue, restored after a reload (`ensureRehydrated`). Reads go through a facade
with the priority `pending > electric > preview > cache`.

| | Merits | Drawbacks |
|---|---|---|
| `docs/…` | The UI reads Electric collections directly; the status of every item is visible to the user | Optimistic state is lost on reload: an unsent message will arrive (the outbox), but it is invisible until confirmed — the user may send it again |
| `feat/…` | The value survives a reload and stays visible — exactly the expected UX for a profile | Every consumer has to go through a merge facade over four collections; there is no per-item status, so unsent is indistinguishable from saved; the "eternal pending" of §3 hides the server with no indication |

## 5. What happens to a rejected write

**`docs/…`**: transient — it stays in the outbox for replay; permanent — the
record is removed from the queue and an error is shown in the UI (if the tab is
still alive).

**`feat/…`**: permanent → `quarantined` with `lastError`; the entry is kept, and
the next edit of the same key returns it to `pending`; the counters
(`queueStatus`) are reactive and available to the UI.

| | Merits | Drawbacks |
|---|---|---|
| `docs/…` | The outcome is always definite; the user sees the error at the moment of rejection | If the rejection happened during a replay after a reload, the content is deleted with no trace for the user |
| `feat/…` | Content is not lost; reactivation is natural; observability comes for free | The quarantine is silent: without UI over the counters the user never learns about the rejection, and the quarantined value keeps being displayed as data |

## 6. Read endpoints

**`docs/…`**: all shapes through `/electric/v1/shapes` — the endpoint sanctioned
by the backend team (2026-07-31). **`feat/…`**: shapes through `/user_card` and
`/user_storage` — proxy endpoints with their own offset logic, declared
deprecated.

The difference here is not in the quality of the decision but in alignment with
the backend's plans: code on deprecated endpoints will have to be moved when they
are removed. The move is mechanical (URL plus parameters).

## 7. The wire format

**`docs/…`**: the field set of a mutation is checked against the Ecto schemas
(`chat/lib/chat/data/schemas/*.ex`); `hash_b64` is not sent, and `sign_hash` goes
only to tables where the column exists. **`feat/…`**: sends `hash_b64` in
`user_storage` (the server ignores extra fields on cast, so no harm — but the
field is dead); the signature composition is correct in both branches.

## 8. `owner_timestamp` monotonicity

**`docs/…`**: `nextOwnerTimestamp = max(now, prev + 1)` plus serialisation of
writes to one entity; covered by tests for two edits within one second.
**`feat/…`**: `Math.floor(Date.now() / 1000)` — two card edits in one second
produce the same timestamp, the server rejects the second ("not newer") and it
lands in quarantine. The fix is local (the same formula plus the queue).

## 9. Read persistence (a cache between sessions)

**`docs/…`**: the official packages (`@tanstack/db-sqlite-persistence-core` plus
the browser adapter, wa-sqlite over OPFS); Electric keeps the shape cursor in
metadata and fetches the **delta** after a reload. The price: ~1 MB of wasm, an
OPFS requirement, and exclusions in `optimizeDeps`.

**`feat/…`**: a hand-written cache (`userCache.ts`) — rows are duplicated into
IndexedDB and loaded at startup. There is no cursor: the shape is re-fetched in
full on every load, and the cache only covers "show something before the network
answers". The price: zero dependencies, works anywhere IndexedDB exists.

| | Merits | Drawbacks |
|---|---|---|
| `docs/…` | Delta fetching — traffic and startup time do not grow with history; upstream support | A heavy dependency; OPFS has to exist in the target browsers (the WebView on a Pi — to be checked) |
| `feat/…` | Simple, portable, no wasm | A full re-fetch of every shape on every start; double storage (cache plus collection) maintained by hand |

## 10. `user_storage` slots

**`docs/…`**: fixed slot UUIDs (`STORAGE_SLOTS.profile/contacts`) plus reading
legacy names. **`feat/…`**: `deriveStorageUuid` — a deterministic UUIDv8 from the
logical name (sha256): a more general solution, where any future slot gets an
identifier without a registry.

A drawback shared by both: the identifier is the same for every account and
predictable, while reading `user_storage` is public ("any user can read any
storage", `docs/pq/reqs/pq_user_storage.md` §2.2) — so with someone's `user_hash`
one can learn that the user has a profile and when they last edited it. The value
is encrypted; the purpose of the record and its history are not. Deriving from
the name additionally binds the `parent_sign_hash` chain to a string that can be
renamed.

The spec assumes something else: the uuid is generated randomly by the client and
the "slot → uuid" mapping is kept locally (§8.2). On a new device the registry is
rebuilt from the data itself — the shape returns every row of one's own
`user_hash`, the decryption key is there, and the record's type sits inside the
value. The solution is shared by both branches (backlog §5).

## 11. Tests

**`docs/…`**: 114/114 green; the key regression tests were checked for
discriminating power (they fail when the fix is reverted); the fake transport
honours the barrier's contract. Three rounds of external review passed.

**`feat/…`**: 172 tests, high density (~1800 lines of tests over ~1300 lines of
code), meaningful scenarios (correlating results by index, hydration races,
ownership). At commit `018515e` 17 are red — concentrated in ingest result
correlation and the cleanup of legacy records, i.e. the tests describe behaviour
the code has not finished yet.

## 12. Functional differences (facts, without judgement)

Present in `docs/tanstack-migration`, absent in `feat/…`: explicit read receipts,
multiple tabs (the gate is lifted), a durable outbox for all tables, encryption of
the local queue (isolating accounts within one browser profile).

Present in `feat/…`, absent in `docs/…`: pending state visible after a reload,
quarantine with reactivation, reactive queue counters, a preview layer for cards
from QR scans.

---

## Candidates to carry between the branches

Ideas from `feat/…` that fit `docs/…` locally: rehydratable visible pending (the
outbox already stores everything needed), quarantine instead of deletion on
permanent, a reactive queue counter, the preview layer, and a short circuit on
`navigator.onLine` before sending — today a call without a network runs the full
retry cycle and returns an error even though the record is already queued and will
arrive later.

Ideas from `docs/…` applicable in `feat/…` without changing its architecture:
`nextOwnerTimestamp`, moving to `/shapes`, confirmation by `txid` instead of field
comparison, and an outcome for an `awaiting_remote` that never completes.

There is nothing to carry over for `user_storage` slot addressing: the backend's
remark applies to both branches. Fixed UUIDs (`docs/…`) and derivation from the
slot name (`feat/…`) both produce identifiers identical across accounts, while
reading `user_storage` is public — so the purpose of a record and the history of
its edits are open on the server. The shared solution is a random uuid per account
with a local registry (see backlog §5).

## Questions for joint discussion

1. Queue semantics for dialogs: how does the `feat/…` model (a map by key) extend
   to append-only messages with versions — or do dialogs take the direct write
   path?
2. Confirmation: `txid` as the common mechanism? That removes both the
   field-comparison drift and the "eternal `awaiting_remote`".
3. Is per-item sync status needed in the UI of the user domain
   (profile/contacts), or are aggregate counters enough?
4. OPFS/wasm on the target devices (the WebView on a Pi, Safari): if support is
   confirmed, delta fetching is a strong argument; if not, a `feat/…`-style cache
   stays as the fallback.
5. The fate of the legacy endpoints: the backend's removal timeline sets how
   urgent it is to move `feat/…` onto `/shapes`.

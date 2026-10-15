# Project invariants

Rules that hold for any code in this repository, whatever the branch and whoever
the author. Each came from a real stumble — lost time, a bug, or a divergence
from the backend — so each carries a date and a reason.

This is neither an architecture description nor a task list. It answers one
question: *what must not be broken, however tempting*. If a rule looks
unnecessary, read the "why" first and argue afterwards.

The order runs from what breaks user data to what breaks the process.

---

## User data

### 1. Local storage is not required to hide metadata

**Lifted:** 2026-08-19, CTO decision (introduced 2026-08-12) ·
**Detail:** [persistence-encryption.md](persistence-encryption.md)

Access control over metadata — who talks to whom, when, how often — starts at
the backend, not at the frontend: while the envelope is open on the server,
encrypting it in a browser profile closes no threat. So local stores (IndexedDB,
OPFS, localStorage) may keep the envelope — `user_hash`, `dialog_hash`,
`sender_hash`, `owner_timestamp`, signatures, names — in the clear.

End-to-end encryption of **content** (`content_b64`, `value_b64`) is untouched by
this: it belongs to the protocol, not to local storage.

**Consequences.**
- A new local store need not go through `secureStore`; the layer exists and
  serves the outbox and localStore, and using it for new data is a convenience,
  not a requirement.
- A library that writes plaintext to disk (wa-sqlite, IndexedDB adapters) needs
  no encrypting wrapper to be acceptable.
- Shape persistence (L1) is behind a flag; enabling it is a decision about
  performance and OPFS support, not about security.

### 1a. Backward compatibility of data is not required yet

**Since:** 2026-08-26 (owner's decision)

The project is in active development with no user base. When a format changes —
a schema, a content envelope, identifiers, local storage — it changes outright:
no migration is written for existing records, no legacy read path is supported,
no version compatibility is built in. Data already published by test accounts is
not treated as something to protect.

**Why.** Every existing account is a test account. Migration code and
compatibility layers are pure cost here: they are written, tested and soon
deleted, and along the way they hide the real format from the reader.

**Consequence.** The rule is revoked by an explicit owner's decision — from that
moment the format is a contract and backward compatibility returns to the scope
of any task that touches data.

### 2. Writes are never lost silently

**Since:** 2026-08-11 (reviews 2–3)

Any mutation the user initiated (a message, an edit, a reaction, a profile
change) either reaches the server or the user sees that it did not. There is no
third state where something "went nowhere".

**Why.** The first reviews found several places where a server rejection was
swallowed by `.catch(() => {})` or reached only `console.warn`. A rejected edit
looked accepted; an unsent card did not prevent saving a profile that referenced
it.

**Consequences.**
- The transport distinguishes transient (network, 5xx — retry) from permanent
  (422, a business rule — retrying is pointless). Permanent surfaces in the UI.
- Optimistic state is rolled back or marked as failed; it does not hang around
  pretending everything is fine.
- Mutations waiting for the network live in a durable outbox and survive a
  reload.
- A write waiting in the outbox is reported as what it is — saved on this
  device, waiting for the network — not as failed and not as done. The device
  shows it from there, across reloads.

### 2a. The app runs inside its service worker's scope

**Since:** 2026-09-29 (staging, offline use)

The service worker and the installed app are scoped to the build base
(`vite.config.js` `base`: `/app/` where the chat server hosts the build). Every
route of the app lives under it, and an entry through another path moves
inside before the router starts (`src/lib/appBase.ts`).

**Why.** The router used root-level paths (`/chat/…`) while the worker
controlled `/app/`. A reload with no connection anywhere in the app was a
browser error page, and pages were never controlled by the worker at all —
the offline shell and the encrypted-video streamer existed only on paper.

**Consequences.**
- The router is created with `import.meta.env.BASE_URL`; links go through the
  router, not through hand-built paths.
- A deployment that moves the build changes `base`, and with it the scope,
  the manifest's `start_url` and every route together.

---

## The contract with the backend

### 3. `/shapes` is the only read endpoint

**Since:** 2026-07-31 (confirmed by the backend team)

Tables are read through `/electric/v1/shapes?table=…&where=…`. The proxy
endpoints `/user_card`, `/user_storage` and their kin are deprecated: they have
their own offset logic and the backend is retiring them.

**Why.** Code on a deprecated endpoint gets rewritten when it is removed, and
until then it behaves unlike the other shapes (a different resume, different
headers).

### 4. `owner_timestamp` is strictly monotonic on the client

**Since:** 2026-08-11 (review 3, finding 6)

The server rejects an update whose `owner_timestamp` is not strictly greater
than the stored one. `Math.floor(Date.now() / 1000)` gives the **same** value to
two edits within one second — the second is silently rejected as "not newer".

**Consequence.** A new timestamp is `max(now, previous + 1)`
(`src/lib/data/time.ts::nextOwnerTimestamp`), and writes to one entity are
serialised so that `previous` is read after the previous write's barrier.

### 5. The HTTP → shape barrier before a dependent write

**Since:** 2026-08-11 (review 3, finding 1)

HTTP 200 from `/ingest_each` proves a commit in Postgres — **not** the row's
delivery through Electric into a collection. A write whose successor reads the
shape as its base (the next edit takes `parent_sign_hash`, a second message
waits for the key row, the card is needed for `user_storage`) must await
`awaitTxId` on the returned `txid`.

**Why.** Without the barrier every one of those scenarios signed a mutation
against a stale base and was rejected — sometimes reproducibly, sometimes once
in ten runs, which is worse.

**Consequence.** The entry point for such writes is
`sendMutationsAndAwaitShape`, not bare `sendMutations`. The barrier times out
(10 s) and logs, but does not fail the write: the server has already accepted it.

### 5a. Base64: the signature carries padding, the shape does not

**Since:** 2026-08-26

The same bytes arrive in two different encodings, and you can only confuse them
once per debugging session — the signature simply does not verify, with no hint
as to why.

| Where | Encoding | Source |
|---|---|---|
| signature payload | **with** padding (`=`) | `chat/lib/chat/data/integrity.ex:89,93` — `Base.encode64/1`, which is `padding: true` in Elixir |
| binary columns from `/shapes` | **without** padding | `chat/lib/chat_web/plugs/hex_to_base64_adapter.ex:122,157` — `Base.encode64(bin, padding: false)` |

**Consequence.** A value taken from a shape cannot go into a signature payload
as-is — it has to be padded with `=` to a multiple of four. This applies to
producing a signature and to checking one: when verifying a received row the
payload is assembled from the padded form, or not a single row will verify.

`encodeField` in `src/lib/pq/signature.ts` pads `_cert`, `_pkey` and `_b64`
values and each element of a binary array (`files.chunk_sign_hashes`), so the
payload is the same whether a row is being signed or verified.

### 6. The server schema is the source of truth for the wire format

**Since:** 2026-08-12

A mutation's fields come from the Ecto schema of the table in question
(`chat/lib/chat/data/schemas/*.ex`), not from a neighbouring table by analogy.
For example: `sign_hash` exists only on `dialog_messages` and
`dialog_messages_versions`; sending it in `dialog_keys`, reactions or receipts is
a field the schema cannot cast.

**Consequence.** Before adding a field to a mutation, grep the schema. Before
accepting a review's claim about the backend, open the backend source.

### 6a. A row that fails its signature is refused, visibly

**Since:** 2026-10-09

A replicated row comes from a server or a peer the client does not trust, and
its check against the author's signature has two ways of not passing. They are
handled differently, and every reader of a verified relation handles them the
same way:

- **`unavailable`** — what the check needs has not arrived (the author's card,
  a file chunk's row) or the vault is locked. The row is not used yet; a later
  read checks it again.
- **`invalid`** — the row contradicts its author's signature. It is refused:
  never used as data, never cached, and never retried as if the network had
  failed — another attempt gets the same bytes and the same answer. Where the
  user expects the thing (a message, a file) it is shown as "could not be
  verified". A row with no place of its own in the UI (a reaction, a receipt)
  is dropped.

**Why.** A refused row that vanishes looks like data that never came, and one
retried as a network error spins on a verdict that cannot change.

**Consequence.** `verifyReplicatedRow` returns the two outcomes apart; a caller
maps them as above. Files: `FileVerificationError` with kind `invalid` is "This
file could not be verified" (`src/lib/data/fileIntegrity.ts`); messages: the
dialog gate keeps the reason (`getInvalidReason`).

---

## Domain rules

### 7. Messages are versioned, reactions are not

**Since:** 2026-08-11 (product decision)

`message_id` is a message's logical identity, `sign_hash` a revision's identity.
Old revisions live in `dialog_messages_versions` and must be reachable in the UI.
A reaction binds to a **revision** (`message_sign_hash`); when a message is
edited, a reaction on the old revision is not shown, and a new reaction "moves"
to the new revision (one row under a deterministic `reaction_hash`, which
contains no revision — only `message_id`, `reactor_hash` and the type).


---

## Process

### 9. Work happens in separate branches; `main` is not touched without the owner

**Lifted:** 2026-09-29, `main` became the only integration branch and the source
of the staging deployment (introduced 2026-08-06) · **Replaced by:** rule 9a

Two developers work on the migration in parallel in different branches, and the
results are compared when both are ready. Until then nothing from the migration
branches is merged into `main`, and one branch's decisions are not imposed on the
other.

**In practice.** A working branch → the integration branch
(`tanstack-migration`) for testing → comparison → the owner's decision. "Done"
means "pushed and visible to the reviewer", not "sitting locally".

### 9a. Every change reaches `main` through a PR from a branch off `origin/main`

**Since:** 2026-09-29 (owner's decision)

`main` is the only integration branch, and staging deploys from it. A feature or
fix branch starts from the current `origin/main` and returns to `main` through a
PR, after review and with CI green. Only the repository owner pushes or merges
into `main` directly.

**Why.** What staging runs is what gets tested, so work integrates where it
ships. Recovery shares and contact slots were written on `tanstack-migration`
against a storage layer `main` had already replaced, and reaching `main` meant
porting them by hand onto its JSON-patch intents.

**In practice.**
- `git fetch origin` before starting work and before opening a PR, then bring
  the branch up to date with `origin/main` (merge it, or rebase unpushed work
  onto it).
- `tanstack-migration` is not a base for new work, and new changes are not
  ported back into it.
- "Done" means "pushed and visible to the reviewer", not "sitting locally".

### 10. A test must fail without the fix

**Since:** 2026-08-12

A test that passes with the bug and without it is not a test, it is a line in a
report. Every regression test is checked for discriminating power: restore the
old behaviour temporarily → the test goes red → restore the fix → green.

**Why.** This is how two tests that "checked" the reaction queue were caught —
they passed trivially because clicks coalesced — along with one where `toContain`
with an asymmetric matcher always passed.

### 11. Claims about the backend are verified against its source

**Since:** 2026-08-06

Three external reviews contained claims about backend behaviour. All of them
were checked against the backend's code and tests before anything was fixed;
some held, some needed rewording. Not one was taken on faith — and none of our
own claims should be either.

---

## How to extend this

A rule lands here when it has been stumbled over **twice**, or once expensively.
The format: an imperative heading, a date, a "why" with the concrete case, and
the consequences for the code. An obsolete rule is not deleted but marked
"lifted: date, reason" — the history of revocations is no less useful than the
history of introductions.

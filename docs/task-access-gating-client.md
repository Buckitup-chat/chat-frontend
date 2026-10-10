# Task: access gating and vouch tokens (client side)

**Sources:** `chat` `main` at `ce00e687` (2026-10-03):
`docs/pq/reqs/pq_access_gating.done.md` (§ Client Behaviour is the
contract for this task) and `docs/pq/reqs/pq_vouch_tokens.in_progress.md`.
**Frontend base:** `chat-frontend` `main` at `caa3a4b`.

## Where things stand

**Backend (done):**
- Owner bootstrap: the first ingested `user_card` becomes the device owner.
- Gate mode in AdminDB: `open` / `guarded` / `trust`.
- Write gate per shape (`Chat.Pq.WriteGate`).
- Read sessions:
  - `GET /electric/v1/challenge` → `POST /electric/v1/read_session`;
  - 5-minute token per shape;
  - `ElectricReadGate` on `/shapes`, `/file_chunk/…` and `/file_chunk_status`.
- Server cards (`GET /electric/v1/server_card`, name `SyncBot_<device_id>`).
- `vouch_tokens` (an Electric shape): schema, validation, chain distance by
  recursive CTE.
- An admin sandbox for switching modes and issuing vouches by hand.

**Backend (pending):**
- the `ElectricAccessGate` plug;
- the `max_depth` setting (reads use the fixed default of 7);
- the resolved chain cache.

None of these block the client work below.

**Frontend, reads: in progress on branch `gated-reads`** (four commits on
`8e877de`, 2026-10-05, not merged):
- `src/lib/data/readSession.ts`: lazy open on `401`, one open per shape,
  renewal 60 s before expiry, tokens in memory;
- `src/lib/data/accessGate.ts` and `AccessGateBanner.vue`: blocked shapes,
  probing from 15 s up to 5 minutes;
- the wiring: Electric collections, `readShapeOnce`, chunk fetches, the
  service worker's token, and the barrier skipping blocked shapes;
- `EncryptionManagerPQ.signChallenge` signs the challenge's UTF-8 bytes, as
  the server checks.

Parts 3 and 4 below are the contract to review that branch against.

**Frontend, the rest: not started.**
- `src/lib/data/ingest.ts` treats any `422` as permanent and everything else,
  `403` included, as transient. The spec forbids both for a blocked row.
- *Awaiting approval* knows only blocked reads; blocked writes do not enter it.
- No `vouch_tokens` in `src/lib/pq/schema.generated.ts`, and no client issues
  or revokes a vouch.

In `open` mode, the default, none of the gate responses occur, so the app works
today. As soon as an owner switches a device to `guarded`, writes retry forever
or get dropped.

## Scope

The client never needs to know the mode; it reacts to responses. The same code
runs in all three modes.

### 1. Identity first (§ Identity first)

- Ingest the own `user_card` alone, in its own request, before any other
  write. `/ingest` is one transaction, so a card batched with a gated row rolls
  back with it.
- `401 unknown_user` from `/read_session`: ingest the card, then open the
  session again, once.

### 2. Writes (§ Writes)

Decide per row, by the `error` string: a `422` can mix blocked rows with real
validation failures.

- **A blocked row (`not_in_trust_chain`) is neither permanent nor transient.**
  - Do not drop it, quarantine it or roll back its optimistic state.
  - Do not put it on the backoff schedule.
  - Keep it pending in the outbox, pause draining for this identity, and enter
    *awaiting approval*.
- **Partial batches:** in an `/ingest_each` batch, committed rows stay
  committed; only the blocked rows stay pending.
- **Never blocked:**
  - `user_card` and `vouch_token`;
  - `review_post_right(_candidate)` and `review_revoke_right(_candidate)`;
  - anything the owner writes.
- **Files:** the spec asks for chunks after the `file` row, but the backend
  accepts a `file` manifest only once every chunk is stored
  (`File.Validation.verify_file_chunks`, `:incomplete_chunks`), so today's
  order — chunks, then the manifest — stays. A blocked manifest stays pending
  like any blocked row; its chunks wait on the device until approval. This
  contradiction goes to the backend with the open questions below.

### 3. Reads (§ Reads)

- **Tables are not shapes.** A request names a table (`?table=user_cards`);
  the gate names a shape (`user_card`). Versions tables map to their owning
  shape (`dialog_messages_versions` → `dialog_messages`), and `files` maps to
  `file`. Key tokens and blocked state by the shape: from the `401` body, and
  for a request about to be sent, from a table→shape map mirroring
  `Chat.Data.Shapes`. Keyed by table, `bearerFor('user_cards')` finds no token
  for `user_card`, and every long-poll pays a challenge and a signature until
  Electric gives up. `gated-reads` keys by table today — the first thing to
  check there.
- **A session manager**, held in memory only, per identity: `shape →
  {token, expires_at}`.
  - Sessions open lazily, on the first `401 {"error":"read_session_required",
    "shape": S}`.
  - At most one open in flight per shape; concurrent `401`s await the same
    promise. One open dialog has 5 collections over 4 shapes.
  - Renew when less than 60 s remain, and on any `401
    read_session_required`, even if the local token looks valid: a server
    restart drops all sessions.
  - Signing reuses the ingest PoP signer (ML-DSA-87 over the challenge).
- **Electric streams** (the TanStack Electric collections, `shapeOptions`):
  - `headers: { Authorization: () => bearerFor(shape) }` — a function, so
    every long-poll picks up a renewed token;
  - in `onError`, a `401 read_session_required` opens or renews the session
    and returns `{}`;
  - if opening returns `403`, enter *awaiting approval* and return
    `undefined`, so the stream stops instead of looping;
  - leave every other error to the existing handling.
- **One-shot reads** (`readShapeOnce`, `GET /file_chunk/…`, `GET
  /file_chunk_status`): send the same header; on `401`, open the session and
  retry once.
- **The service-worker video streamer:**
  - the page puts the current `file_chunk` token into the video session it
    posts to the worker;
  - the worker sends `Authorization: Bearer …` on chunk fetches;
  - on `401`, the worker posts `need-token` (like the existing
    `need-session`), retries once, then fails the range.
- **Tokens are secrets:** never in URLs, logs, IndexedDB or the outbox. After a
  reload, sessions open lazily again.
- **Shape barriers:** a write waiting for its txid (`awaitTxId`,
  `sendMutationsAndAwaitShape`) on a stream stopped for approval must not wait.
  Treat the ingest `200` as the commit.

### 4. Awaiting approval (§ Awaiting approval)

- **Banner:** "Waiting for approval by the device owner", with the user's own
  `user_hash` and a copy button. `max_depth` is not shown.
- **Blocked state is tracked per shape:** a vouch can cover a single shape.
  - Show the banner when any shape the current screen needs is blocked.
  - `guarded` mode: reads work and sends queue.
  - `trust` mode: blocked shapes show only locally persisted data.
- **Probing:**
  - schedule: 15 s, then doubling to a 5-minute cap;
  - also immediately on "Check again", on the app becoming visible and on
    network reconnect.
  - A blocked read probes by opening a session and restarts that shape's
    streams on success.
  - A blocked write probes with the first blocked outbox entry and resumes
    draining on success.
- **Leaving:** any successful session open or write for a shape clears that
  shape's blocked state.
- **Revocation:** a revoked client gets `401` within 5 minutes, then `403` on
  renew, and lands here. Local data and pending writes are kept.

### 5. Vouch tokens (pq_vouch_tokens; pq_access_gating § Contacts as Trust Signal)

"Creating these vouch tokens is a frontend responsibility": after a successful
handshake, the frontend issues the vouch on the owner's behalf.

- **Schema and signing:**
  - add `'vouch_token.ex'` to `SCHEMA_FILES` in `scripts/gen-pq-schema.mjs`
    and regenerate `schema.generated.ts` — it is generated, and a hand edit
    fails `tests/pqSchemaGen.test.ts` or is lost on the next run;
  - fields: `kind`, `issuer_hash`, `subject_hash`, `owner_timestamp`,
    `deleted_flag`, `sign_b64`;
  - primary key: `(kind, issuer_hash, subject_hash)`;
  - sign with the existing `signFields` canonicalization.
  - the client reads its own issued rows (`vouch_tokens` where `issuer_hash`
    is itself, the shape or a one-shot read). The backend takes only insert
    and update: the first grant is an insert, while a revoke and a re-grant are
    updates of the existing row, with an `owner_timestamp` above the stored
    one. `nextOwnerTimestamp` is seeded from that value, or a revoke in the
    same second as its grant is refused as not newer. Re-confirming a removed
    contact is an update to `deleted_flag: false`, not a second insert — an
    insert on an existing key comes back as a conflict.
- **Issuing:**
  - **Where:** in `confirmContact` (`src/store/userPQ.store.js`), the only path
    that sets `confirmed`. That way it works with today's PQ1 handshake and
    with PQ2 when it lands.
  - **Rows:** two vouches, `device.<sn>.storage.write` and
    `device.<sn>.storage.read`, subject = the confirmed contact. `<sn>` is the
    device the client talks to.
- **Revoking:** removing a contact, or losing `confirmed`, tombstones both
  vouches.
- **Read-path verification:** add `vouch_tokens` to `VERIFIABLE` in
  `src/lib/data/rowVerification.ts`; the client reads these rows (above).

**Open questions for the backend** (1–3 before part 5; parts 1–4 do not
depend on them):

1. **The device id.** How does a client learn `<sn>`? Parsing
   `SyncBot_<device_id>` out of `/electric/v1/server_card` is fragile; an
   explicit field or endpoint is better.
2. **Non-owners.** Should a non-owner issue the vouch at all? The spec allows
   transitive vouches "attenuated from voucher's own scope", but a client does
   not know its own scope. Options: issue the same `device.<sn>.storage.*` and
   let the CTE attenuate, or issue only as the owner. How does a client know it
   is the owner?
3. **Several devices.** A vouch is per device. Should a handshake vouch for
   every device the user syncs with, or only the current one?
4. **File upload order.** `pq_access_gating` § Writes asks for chunks only
   after the `file` row is accepted; `File.Validation` accepts the row only
   after every chunk. One of the two has to change; until then the client
   keeps chunks first (part 2).

## Order and acceptance

Build in this order:

1. Parts 1 and 2: `guarded` mode works.
2. Part 4 for blocked writes, on top of `gated-reads`' gate and banner.
3. Part 3: review and finish `gated-reads` against it; `trust` mode works.
4. Part 5.

**Acceptance**, on a local backend, using its admin sandbox to switch modes and
issue or revoke vouches:

- **`guarded` mode:**
  - an unvouched account can read;
  - its message stays pending with the banner and leaves within one probe of
    approval;
  - nothing is dropped or rolled back;
  - a mixed `/ingest_each` batch keeps the rows that committed.
- **`trust` mode:**
  - an unvouched account sees only local data and the banner;
  - after approval, the streams resume without a reload;
  - after revocation, it is back in the banner within 5 minutes.
- **Video:** plays in `trust` mode, so the worker gets a token.
- **Handshake vouches:**
  - a confirmed handshake as the owner produces two vouch rows signed by the
    owner;
  - removing the contact tombstones them;
  - the backend's chain distance for the contact is 1, and absent after the
    tombstone.
- **Tests:** unit tests for the per-row classification, the session manager
  (shared opens, renewal, retry once) and the probe schedule. Each regression
  test must fail without its fix.
- `npm test`, `npm run lint` and `npm run build` are green.

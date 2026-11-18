# Task: access gating and vouch tokens (client side)

**Sources:** `chat` `main` at `ce00e687` (2026-10-03):
`docs/pq/reqs/pq_access_gating.done.md` (§ Client Behaviour is the
contract for this task) and `docs/pq/reqs/pq_vouch_tokens.in_progress.md`.
**Frontend base:** `chat-frontend` `main` at `caa3a4b`.

## Client integration

The installed SDK owns row schemas, signing, HTTP result classification and
read-session primitives. This frontend owns the active account, tokens in
memory, reactive collections, approval UI, durable blocked writes and contact
policy:

- `readSession.ts` obtains the active identity's sessions and wires their bearer
  tokens into shape and chunk reads.
- `accessGate.ts` tracks blocked shapes and schedules probes for the UI.
- `ingest.ts` maps SDK outcomes into the application's durable delivery states.
- `outbox.ts` retains writes held for approval and resumes them when access is
  demonstrated; an access refusal is not a retryable network failure.
- `contactVouches.ts` builds signed rows through the SDK while the contact
  store decides when the account grants or retracts its vouches.

Service gate mode, trust-chain evaluation and peer-vouch freshness are service
responsibilities. Client tests use an integration fake and do not prove the
behavior of a deployed server.

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
  like any blocked row; its chunks wait on the device until approval. The
  backend has to resolve this contradiction with the spec.

### 3. Reads (§ Reads)

- **Tables are not shapes.** A request names a table (`?table=user_cards`);
  the gate names a shape (`user_card`). Versions tables map to their owning
  shape (`dialog_messages_versions` → `dialog_messages`), and `files` maps to
  `file`. Key tokens and blocked state by the shape: from the `401` body, and
  for a request about to be sent, from a table→shape map mirroring
  `Chat.Data.Shapes`. Keyed by table, `bearerFor('user_cards')` finds no token
  for `user_card`, and every long-poll pays a challenge and a signature until
  Electric gives up. The SDK session manager (`createReadSessions`,
  `@buckitup/pq-client/transport`) keys tokens by shape and records each
  table's shape from the `401` body, so `bearerFor(table)` finds the shape's
  token.
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
- **Confirmation:** a stopped read stream does not revoke an exact per-row
  server acceptance. Preserve that acceptance and its durable snapshot;
  replicated visibility remains a separate state. Follow `writeContracts.ts`
  and [the confirmation invariant](invariants.md#5-dependent-writes-use-the-required-confirmation-level).

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
  - use the installed SDK's schema and row-signing API through
    `src/lib/data/contactVouches.ts`; schema generation and protocol tests
    belong to [pq-library](https://github.com/Buckitup-chat/pq-library);
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
    that sets `confirmed`, after the PQ2 engine has verified the peer.
  - **Rows:** two vouches, `device.<sn>.storage.write` and
    `device.<sn>.storage.read`, subject = the confirmed contact. `<sn>` is the
    device the client talks to.
- **Revoking:** deleting a contact (`deleteContact`) tombstones both vouches.
- **Read-path verification:** `src/lib/data/rowVerification.ts` verifies
  `vouch_tokens` through the SDK before the app uses a replicated grant.

## Device identity and contact policy

`deviceOwner.ts` reads `GET /electric/v1/device_identity`; the client does not
parse the device id out of a SyncBot name. Vouches target the server the app
is currently connected to. The issuer must be its known owner or hold a
verified device vouch; otherwise the app leaves the action for a later retry.
The server evaluates the resulting chain and attenuation.

Contact confirmation and retraction policy belong to the frontend.
Changing a confirmed contact's key clears its confirmation but does not retract
its device-access vouches; deletion is the retraction path.
Partner one-time-code admission is a different consumer policy and is not
implemented by this contact UI. File upload ordering likewise remains the app's existing
manifest/chunk lifecycle, not a vouch or protocol-test responsibility.

## Deployment acceptance

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
- **Tests:** SDK result-classification and read-session unit tests run in
  `pq-library`. Frontend tests cover their mapping to outbox states, account
  fencing, shared session use, probe scheduling, contact UI and service-worker
  token delivery. Each regression test must fail without its fix.
- `npm test`, `npm run lint` and `npm run build` are green.

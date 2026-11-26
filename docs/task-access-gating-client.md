# Task: access gating and vouch tokens (client side)

**Original backend sources:** `chat` `main` at `ce00e687` (2026-10-03):
`docs/pq/reqs/pq_access_gating.done.md` (§ Client Behaviour is the
contract for this task) and `docs/pq/reqs/pq_vouch_tokens.in_progress.md`.
**Original frontend base:** `chat-frontend` `main` at `caa3a4b`.

**SDK contract for contact access:** `@buckitup/pq-client@1.1.0`, installed
from the public npm registry with its exact version and integrity in
[package-lock.json](../package-lock.json). See
[SDK integration](../README.md#protocol-sdk) for installation and upgrades.
The versioned contact-access contract is in
[SDK revision b723b10](https://github.com/Buckitup-chat/pq-library/blob/b723b1042ae14bad84c88743ed9ed40b966c5a83/docs/contact-access.md).

## Client integration

The installed SDK owns row schemas, signing, HTTP result classification,
read-session primitives and the reusable contact-access policy. This
frontend owns the active account, tokens in memory, reactive collections,
contact persistence, approval UI, durable blocked writes and scheduling:

- `readSession.ts` obtains the active identity's sessions and wires their bearer
  tokens into shape and chunk reads.
- `accessGate.ts` tracks blocked shapes and schedules probes for the UI.
- `ingest.ts` maps SDK outcomes into the application's durable delivery states.
- `outbox.ts` retains writes held for approval and resumes them when access is
  demonstrated; an access refusal is not a retryable network failure.
- `contactVouches.ts` adapts the application's intent store, outbox, shape
  reads, row verification, device identity and locks to `createContactAccess`.
  The SDK owns grant decisions, signed-row planning, per-device request
  reconciliation and access view state.
- `userPQ.store.js` saves a verified confirmation and passes its prior state
  to SDK `initialAccessDecision`. EM supplies the prior-read evidence and
  schedules retries. The component and composable own the confirmation UI,
  subscriptions and page/account/device context guard.

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
- **Revocation:** if a client loses effective read access in `trust`, its
  sessions expire within 5 minutes; renewal returns `403` and it enters this
  state. Other chains, owner tombstones and gate mode determine effective
  access. Local data and pending writes are kept.

### 5. Vouch tokens (pq_vouch_tokens; pq_access_gating § Contacts as Trust Signal)

Creating vouches is client-side work: the application invokes the installed
SDK on the issuer's behalf. The backend does not turn a handshake into a
grant. `contactAccess` plans two scopes, `device.<sn>.storage.write` and
`device.<sn>.storage.read`, using the connected backend's device id.

- **Initial grant:** after the PQ2 result is verified, `confirmContact` saves
  the contact and supplies the reliable prior to `initialAccessDecision`.
  A genuinely new slot or a readable list without confirmation of that key
  can grant. A prior already confirming that key cannot. Adding by id alone
  grants nothing.
- **Unknown is not empty:** EM reports whether the slot UUID was generated
  by this write; SDK `classifySlotPrior` and `contactsPriorOf` classify the
  read evidence. An unreadable existing slot, malformed record/map/entry or
  invalid target confirmation fields cannot authorize an initial grant.
  A queued write with a valid readable prior can still grant.
- **Explicit change:** the contact page calls `setContactStorageAccess`
  with issuer, subject, desired state and device id. OFF asks for confirmation
  and retracts both own scopes; ON restores both. The contact stays saved,
  with its fields, visibility and QR confirmation unchanged. Deleting a
  contact also requests revocation. Hiding, editing, reopening, sign-in and
  repeating confirmation of the same key do not restore revoked access.
- **Mutation lifecycle:** SDK row planning uses the current verified rows and
  queued timestamps. Existing rows are updated above their `owner_timestamp`,
  including revoke/regrant; a conflicting insert is reconciled. Requests are
  partitioned by issuer, device and subject, and a request for another device
  is skipped without signing. Unverified scopes stay pending. Application
  adapters preserve durable intents and delivery across transient failures
  and reloads.
- **Confirmation:** HTTP acceptance is not sufficient. The SDK checks verified
  shape rows for both scopes and the timestamps this request sent before
  declaring it applied. Partial results remain pending. The UI distinguishes
  the confirmed row state from `Granting…` / `Revoking…`; absent or unreadable
  rows are not shown as confirmed tombstones.
- **UI context:** issuer, subject and device are captured before the revoke
  dialog. After confirmation, context is checked again; navigation, account
  or device changes and component disposal cancel the stale action. A pending
  request prevents duplicate submissions.
- **Verification:** `rowVerification.ts` and `getVerifiedSignPkey` adapt the
  existing row/card verification to the SDK. Cryptographic primitives,
  policy tests and protocol schema ownership stay in pq-library.

## Device identity and contact policy

`deviceOwner.ts` reads `GET /electric/v1/device_identity`; the client does not
parse the device id out of a SyncBot name. Vouches target the server the app
is currently connected to. A non-owner without a verified device vouch fails
the SDK's grant preflight as `skipped:not-vouched`; an ownerless device yields
`skipped:no-owner`. Neither is success. An unavailable device identity leaves
the request for retry. Effective permission is evaluated by the server's
chain, scope and depth rules; the SDK preflight is not that full evaluation.

A non-owner issuer withdraws its own edge, so another valid path may still
admit the contact. The device owner's direct tombstone blocks that subject
at the same or narrower scope through alternative paths. In `open`, neither
read nor write access is restricted by the gate; `guarded` restricts writes,
and `trust` also restricts reads. Existing read sessions can remain valid
until their fixed five-minute expiry. A confirmed revoke in the UI describes
the issuer's replicated tombstones, not immediate loss of every access path.

Changing a confirmed contact's key clears its confirmation but does not by
itself retract its device-access vouches. Permission changes are separate
explicit actions. Partner one-time-code admission is a different consumer
policy and is not implemented by this contact UI. File upload ordering
remains the app's manifest/chunk lifecycle.

## Ownership decision

The original integration placed grant/retraction decisions and request
planning in the frontend contact store and `contactVouches.ts`. The current
agreement puts reusable contact-access rules and behavior in SDK
`contactAccess`, so another client can use them without Vue, Pinia or TanStack.
The frontend retains contact persistence, infrastructure adapters, scheduling
and UI. This extends the original client implementation without changing the
vouch wire format or weakening its signature, timestamp or deployment
acceptance requirements.

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
- **Independent contact access:**
  - revoke and restore through the real contact-page control, leaving contact
    fields and confirmation unchanged;
  - HTTP acceptance before shape confirmation and one-scope failures remain
    pending; transient failures retry across reloads;
  - repeating QR, including while the prior is unavailable or malformed,
    does not restore explicitly revoked access;
  - cancellation or a changed issuer/contact/device context writes nothing;
  - verify non-owner alternative paths, owner direct tombstones, mode-specific
    effects and existing read-session expiry on the backend.
- **Tests:** SDK contact-access, result-classification and read-session tests
  run in `pq-library`. Frontend tests cover adapters, outbox state mapping,
  account fencing, shared sessions, scheduling, contact UI and service-worker
  token delivery. Fakes do not establish live-server acceptance. Each
  regression test must fail without its fix.
- **Required checks:** typecheck, tests, lint and build in each changed
  repository, and an independent consumer of the exact SDK tarball. Record
  actual results and outstanding live checks in the change report; this
  checklist does not assert that deployment checks have passed.

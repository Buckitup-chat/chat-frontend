# ADR: PQ Mutation Lifecycle Contract

**Status:** Proposed  
**Scope:** Frontend ↔ Backend ↔ Electric synchronization  
**Applies to:** user-visible PQ mutations, primarily dialog messages, edits, reactions and receipts.

## 1. Context

This ADR defines the canonical lifecycle of a PQ mutation: one common lifecycle for a user action between the moment it is created on the client and the moment it becomes synchronized state.

---

## 2. Core principle

Mutation state must distinguish three independent properties:

1. **Durability** — whether the user action survives application restart.
2. **Transport and replication** — whether the server accepted it and the resulting state became visible through synchronization.
3. **Protocol validity** — whether the synchronized state passed PQ verification.

Therefore:

```text
SERVER_ACCEPTED ≠ SHAPE_VISIBLE ≠ VERIFIED
```

A single `synced: boolean` is not sufficient to represent mutation state.

---

## 3. Canonical mutation lifecycle

For a normal user-visible mutation:

```text
LOCAL_CREATED
      ↓
DURABLE
      ↓
QUEUED
      ↓
IN_FLIGHT
      ↓
SERVER_ACCEPTED
      ↓
SHAPE_VISIBLE
      ↓
VERIFIED
```

Failures introduce additional states:

```text
                 ┌→ RETRYABLE_FAILURE ─→ QUEUED
IN_FLIGHT ───────┤
                 └→ PERMANENT_FAILURE ─→ QUARANTINED
```

---

## 4. State definitions

### `LOCAL_CREATED`

The user action exists locally but may still exist only in memory.

The client must not represent it as safely queued.

### `DURABLE`

The mutation is stored in persistent local storage and survives application/browser restart.

User-visible mutations must reach this state before they are considered safely queued.

### `QUEUED`

The durable mutation is waiting to be sent or retried.

The stored entry must contain enough information to replay the exact intended mutation.

### `IN_FLIGHT`

The exact mutation is currently being submitted to the backend.

The client must preserve its identity so the backend response can be matched to that exact mutation.

### `SERVER_ACCEPTED`

The backend has accepted and committed the exact mutation.

This does not mean that the frontend synchronized read model already contains the resulting state.

### `SHAPE_VISIBLE`

The committed state has appeared through the Electric/shape synchronization path used by the frontend.

### `VERIFIED`

The synchronized row has passed all applicable PQ verification.

Only verified rows are canonical trusted domain state.

A verification layer is a precondition for conformance with this ADR, not an option. Until one exists, rows stop at `SHAPE_VISIBLE`: an implementation without verification must mark its domain state as unverified rather than call it `VERIFIED`.

---

## 5. Failure states

### `RETRYABLE_FAILURE`

A temporary failure where retrying the same mutation may succeed.

Examples include network failure, timeout and temporary backend unavailability.

The mutation remains durable and returns to the queue for controlled retry.

The return to `QUEUED` must carry a time for the next attempt. An implementation that relies only on external events — login, a browser `online` transition — does not conform: a server can answer 5xx while connectivity never changes, and the queue would then never move again.

### `PERMANENT_FAILURE`

A failure where retrying the same mutation unchanged is not expected to succeed.

Examples include invalid signature, invalid parent revision, invalid causal reference or another protocol/domain violation.

A permanently failed mutation must not enter an infinite retry loop.

### `QUARANTINED`

A permanently rejected mutation retained so that the user action is not silently lost and the failure can be diagnosed or recovered.

User-visible mutations must not be silently deleted after permanent rejection.

A quarantined entry retains the signed mutation, the failure class and the server response. It leaves quarantine in exactly three ways: a retry once the state it depends on has changed, replacement by a newer mutation for the same key, or removal by an explicit user action. It does not expire on its own.

---

## 6. Confirmation rules

### Exact mutation confirmation

A successful backend response confirms only the exact mutation that was submitted.

If mutation `B` is created while mutation `A` is already in flight, successful confirmation of `A` must not acknowledge `B`.

### Independent batch results

Where the backend reports results per mutation, every result must be mapped independently to the corresponding submitted mutation.

### Retry after uncertain delivery

If delivery is retried after the client cannot determine whether the previous request succeeded, an existing server row may be treated as confirmation only after verifying that it represents the exact same mutation.

---

## 7. Write dependencies and dispatch

Three kinds of dependency exist. The first two constrain how a mutation is
constructed; the third constrains when it may be dispatched. None of them
requires waiting for another mutation's outcome before sending an unrelated
one.

### 7.1 Chained writes

A mutation that supersedes an existing row — a new version in a
`parent_sign_hash` chain, or any update of a row already published under the
same primary key — is constructed from a specific predecessor revision: it
carries the predecessor's `sign_hash` and an `owner_timestamp` strictly
greater than the stored one (the server rejects otherwise: "timestamp not
newer").

Both values are client-derived — `sign_hash` comes from the client's own
signature before any request is made — so a successor may be constructed and
signed before its predecessor is confirmed. Construction never waits on the
network; it waits on the client's knowledge of what it signed.

Whether to dispatch the successor before the predecessor's confirmation is a
quality policy, not a correctness rule. If the predecessor is rejected, the
in-flight successor is rejected too — noise in quarantine, never corruption.
The default policy is to hold a successor until its predecessor reaches
`SERVER_ACCEPTED`, to avoid minting doomed mutations; an implementation that
pipelines a chain (or co-batches it, §7.3) stays within this contract.

The base revision must be one the client may trust: its own immutable signed
snapshot, or a verified replicated row. When the client knows its view of a
chain is behind the server — an accepted write whose shape echo has not
arrived — new links in that chain are blocked, not built on the stale tip.
When a predecessor fails permanently, its dependents are blocked and
surfaced, never silently dropped and never auto-rebased unless the mutation
type explicitly allows it.

This applies to user_card updates, user_storage edits, message edits, message
tombstones and reaction toggles — the master + versions pattern of the
backend's 03_data_versioning.md, plus every in-place update.

### 7.2 Independent writes

A mutation that creates a new row — a new message, a first reaction on a
message, a receipt — captures the author's local scope at creation time and
carries no structural dependency on other in-flight mutations. For messages
that scope is `refs_map_b64`, the DAG tails observed at authoring time; a
reaction or receipt instead names the exact message revision it applies to
(`message_sign_hash`), which the author derives locally and does not need
confirmed.

The captured scope is fixed when the intent is created. Deferred encoding,
waiting on prerequisites, or a reload must not silently replace it with
fresher tails: the refs record what the author saw, not the newest state the
client has since learned.

Independent writes may be constructed, enqueued, and dispatched concurrently.
The client must not block them on confirmation of prior unrelated mutations.
Concurrency here means the dependency contract, not the transport: the
current transport dispatches ready entries sequentially. Bounded parallel
transport (a small cap, order preserved only inside real dependency chains)
remains the target and moves to the backlog until three preconditions hold:
metrics showing sequential dispatch is an actual bottleneck; a global
throttle that honours 429/Retry-After as a slow-down signal; and the batch
contract for /ingest_each (one request, many mutations, server-side order
guaranteed) — batching delivers most of the win with one challenge and one
connection, which suits the Pi-class deployment better than parallel
sockets.
Two sends observing the same tails — including two sends by the same author —
produce a fork, which the protocol handles by design (04_ordering.md,
§Invariants); display order comes from UUIDv7 regardless, and forks must not
be prevented by artificial serialization.

### 7.3 Prerequisites and dispatch order

Some rows are only accepted once another entity exists. These are not version
chains and the dependency is not visible in the row's own fields, but the
server enforces them:

- the author's `user_card` must exist before any row signed by that author;
- the sender's `dialog_key` for a dialog must exist before a message or a
  reaction in it ("dialog_key required before posting to dialog").

A prerequisite is satisfied by the prerequisite row reaching
`SERVER_ACCEPTED`; its visibility in a replicated shape is a separate,
stronger condition that is only required when the dependent step actually
reads the row from replicated state.

Dispatch order is expressed through explicit dependencies, not a global
account barrier:

- one sender per account — live-send, retry and replay all pass through the
  same coordinator under the leader lock; no send path bypasses it;
- creation order is the deterministic priority among mutations that are
  ready; it is not a promise that a later mutation waits for an earlier
  unrelated one;
- a mutation in retry backoff or quarantine leaves the dispatch path and
  blocks only its own dependents; unrelated mutations continue;
- sending dependent mutations as separate HTTP requests does not by itself
  guarantee the order the server applies them in — a dependency edge is
  closed either by awaiting the prerequisite's acceptance, or by an ordered
  batch if the backend confirms in-order application within one
  `ingest_each` request as a contract;
- replay after reload and after leader takeover follows exactly these rules —
  same edges, same priority; replay is not a stricter ordering mode.

---

## 8. Removal of durable entries

A durable entry is removed by exactly two events: confirmation of that exact mutation, or an explicit user action such as cancelling the pending write.

Nothing else removes it silently — not a timeout, not a failure, not an account switch, not queue capacity. When the queue is full, the new write is refused at the door; the oldest entry is never evicted to make room.

---

## 9. Account isolation

Durable mutations belong to a specific account.

Switching accounts must never cause another account's queued mutations to be sent, displayed as current pending state, acknowledged or deleted.

---

## 10. Crash recovery

Durable mutations must correctly recover after application/browser crash or reload without losing user intent or creating a different logical mutation.

---

## 11. What the interface may claim

Separating the three properties in §2 exists to keep the interface honest about which one has been reached.

| State | What may be shown |
|---|---|
| `LOCAL_CREATED` | nothing; "sent" here is a lie |
| `DURABLE` / `QUEUED` | "sending" / "waiting for network" |
| `SERVER_ACCEPTED` | "sent" |
| `SHAPE_VISIBLE` / `VERIFIED` | delivered |
| `RETRYABLE_FAILURE` | "sending", with an indication of delay |
| `QUARANTINED` | an explicit error, with an action the user can take |
| durability unavailable | an explicit failure — never "sent" |

The last row is the one most easily got wrong: if durable storage is unavailable, a user-visible mutation must fail visibly rather than fall back to a best-effort network send that looks identical to success.

This applies to user-card publication too. It runs before the vault unlocks,
so the encrypted outbox tier is unavailable — which is not a licence for
best-effort: the card mutation is durably queued in a plaintext outbox tier
(metadata needs no local encryption — CTO decision 2026-08-19) and replayed
by the same coordinator after login. Registration must not fail, and must
not half-create an identity, because the network was down.

---

## 12. Responsibilities

Every transition has exactly one owner. A layer may not skip a transition it does not own.

| Transition | Owner |
|---|---|
| `LOCAL_CREATED` → `DURABLE` → `QUEUED` → `IN_FLIGHT` | durable transport |
| `IN_FLIGHT` → `SERVER_ACCEPTED` / `RETRYABLE_FAILURE` / `PERMANENT_FAILURE` | durable transport, from that mutation's own result |
| `SERVER_ACCEPTED` → `SHAPE_VISIBLE` | replication layer |
| `SHAPE_VISIBLE` → `VERIFIED` | PQ verification layer |
| `PERMANENT_FAILURE` → `QUARANTINED` | durable transport |

**Domain layer:** constructs valid PQ mutations, including signatures, causal refs, version parents and timestamps.

**Durable transport layer:** persistence, queueing, retry, exact confirmation and permanent-failure handling.

**Replication layer:** observes committed state through Electric/shapes.

**PQ verification layer:** validates synchronized data before it becomes trusted domain state.

---

## 13. Relationship to PQ protocol documentation

This ADR defines mutation lifecycle only.

Schemas, signatures, versioning, causal ordering and other protocol invariants remain defined by the existing PQ documentation, including:

```text
docs/pq/invariants/*
docs/pq/dev/SCHEMAS.md
docs/pq/reqs/*
```

Conformance with this ADR is demonstrated by the queue and integrity acceptance tests (`T-QUEUE-01`…`06`, `T-INTEGRITY-01`…`04`); automated PQ conformance and adversarial tests are specified separately.

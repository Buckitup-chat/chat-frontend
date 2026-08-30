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

## 7. Dependent writes and replay order

A mutation that depends on current state must be constructed from the latest confirmed state and must not use a known stale local snapshot.

This includes operations that depend on values such as `sign_hash`, `parent_sign_hash`, previous `owner_timestamp` or current causal refs.

One account's queue replays strictly in creation order. Dependent writes — a dialog key before the message that needs it, a message before the edit that supersedes it, a user card before the storage row that references it — are only correct while that order holds, so a queue must never be drained concurrently.

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

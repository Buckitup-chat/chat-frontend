# Deep-review-loop report — TanStack migration branch, round 1

Repo: `chat-frontend`, branch `review/tanstack-migration-20260915-190600`
(worktree of `tanstack-migration`), base `main`.
Range reviewed: `main...HEAD` at merge-base `84adba85`, tip `4e81df3` (129
commits, 217 files, +28857/-3355). Fix commit: `9674c8f`.
Date: 2026-09-15.

## Method

Gate 0 (lint/test/build on the unreviewed tip) was green: 0 lint errors, 509
tests passed, build succeeded. Round 1 fanned out 5 context-free review-axis
agents in parallel over the full range — correctness/data-flow, data-layer
integration (`src/lib/data/`), security/crypto (`src/lib/pq/`,
`EncryptionManagerPQ.js`, `DialogCrypto.js`), migration/persisted-shape
versioning, and tests/UI reactivity (sonnet) — each scoped to the highest-risk
files rather than mechanically covering all 217 changed files (docs,
`package-lock.json`, generated schema output and e2e specs were excluded from
dedicated axis coverage as low-yield for the budget).

**Budget limitation, stated plainly:** the review fan-out alone spent
approximately $20 of the $24 allotted for the whole loop (five opus/sonnet
axis agents over a very large diff cost far more than the skill's own
per-round estimate, which assumes a much smaller diff). With ~$1 left, this
run did **not** do the skill's normal adversarial verification pass
(independent `review-verifier` agents attempting to refute each claim).
Verification of the findings acted on below was done directly — by reading
the cited source, the actual backend schema/controller in
`/workspace/repos/chat`, and by reverting each fix and watching its test go
red — not by an independent agent. Round 2 (review-of-fixes) did not run for
the same reason. This is a deviation from the loop's normal process, not a
silent gap: it is the reason this report stops after one round instead of
iterating to convergence.

## Fixed and verified this round

| # | Finding | Severity | File |
|---|---|---|---|
| 1 | `/ingest_each` "exists" status unhandled — idempotent retries misclassified as failures, retried forever | critical | `src/lib/data/ingest.ts` |
| 2 | `dialog_keys` insert `'accepted'` — republish race on a second send | high | `src/lib/data/writeContracts.ts` |
| 3 | `dialog_message_reactions` insert `'accepted'` — un-react re-sends "on" | high | `src/lib/data/writeContracts.ts` |
| 4 | Reaction retraction sends literal empty `type_b64`, rejected 422 forever | high | `src/store/dialogs.store.js` |

All four verified end to end against the backend source
(`/workspace/repos/chat`), not just this repo's comments:

- **#1**: `chat/lib/chat_web/controllers/electric_controller.ex:88-92` —
  `detect_conflict/1` intercepts unique-key conflicts for every relation with
  a registered `Shapes` module (all relations this client writes) and returns
  `%{status: "exists", conflicted: bool}` under HTTP 200, not the
  `status: "error"` shape `sendMutations` was written to expect.
- **#4**: confirmed against the backend's own test,
  `chat/test/live_server/buckitup_xyz_ingest_each_test.exs:22-30`, which
  documents this exact client bug against a captured request.
- **#2/#3**: read `writeContracts.ts` and `dialogs.store.js` directly —
  `initDialogKeysUnguarded`/`runReactionWrite` read the relation back from
  the shape as their own "did I already do this" check, which an
  `'accepted'` contract (no shape wait) does not satisfy.

Each fix has a regression test that fails when the fix is reverted (checked
by actually stashing the source change and re-running):

```
# ingest.ts reverted:
FAIL sendMutations > treats a different-signature "exists" row as a permanent conflict
FAIL sendMutations > an idempotent "exists" row does not block other rows...
FAIL sendMutations > returns txids when all rows succeed  (pre-existing, unaffected)

# writeContracts.ts reverted:
FAIL write contracts pin the agreed barrier table > the contested rows keep shape visibility...
  dialog_keys/insert: expected 'accepted' to be 'visible'

# dialogs.store.js reverted:
FAIL reaction toggle coalescing > a fast double click ends with the reaction removed
  expected '' to be 'enc()'
```

`npm test`: 512 passed, 2 skipped (was 509 passed before this round's 3 new
cases). `npm run lint`: 0 errors, 199 warnings — identical to the
pre-existing baseline, no new warnings in touched files. `npm run build`:
green.

**Reachability**, checked directly: `sendMutations` is the sole transport
under `sendMutationsAndAwaitShape`, which is what every `pushRow` call in
`dialogs.store.js`, `userStorage.ts` and `EncryptionManagerPQ.js` goes
through — not new code sitting unwired. The `writeContracts.ts` change is
read by `contractFor()` inside that same function. The `type_b64` change is
inside `runReactionWrite`, reached from `toggleReaction`, bound to the
reaction click handler in `ChatWindow.vue`.

## Confirmed, not fixed — budget exhausted before this round could continue

These were independently verified (by reading the cited code and, where
noted, by the axis agent's own executed proof) but not acted on. Ranked by
severity; not a re-review, just this session's triage.

### Needs the owner's decision — protocol/wire-format change, not a local fix

**`user_cards` canonical signature payload is not injective**
(`src/lib/pq/signature.ts:136-141`, `canonicalPayload`) — high/security.
`name` and `owner_timestamp` are adjacent, variable-length, and joined with
no delimiter or length framing. The axis agent demonstrated by execution that
two different `(name, owner_timestamp)` pairs can serialize to the same
payload and therefore validate under the same signature (e.g. `"Agent7",
1788470000` vs `"Agent", 71788470000`) — letting an attacker who has read
access to a published card (all `user_cards` reads are public) re-publish it
with a truncated name and a timestamp far enough in the future to permanently
block the real owner's own future edits (`compare_timestamps` requires
strictly increasing). The minimal fix (length-frame each field, the same
`u32be(len)||bytes` scheme `checkpoint.ts` already uses) requires the
backend's `Chat.Data.Integrity.encode_field/1` to change in lockstep — this
is exactly the "protocol change, prepare but do not apply" case the loop's
own rules call out. Not applied. `files` has the same non-injective shape
(`chunk_count`/`chunk_size`, `owner_timestamp`/`total_size`) but no
receive-side verifier yet, so lower immediate impact.

### High, local-only, ready to fix next round

- **Cancelling the last live row of a transfer batch drops every attachment
  already uploaded** — `src/store/transfers.store.js:204-213`. `cancel()`'s
  `maybeSendBatch` check runs before the aborted row's rejection is observed,
  so the batch decision is never re-run; `runOne`'s aborted branch removes
  the row without deciding either. Minimal fix given by the axis agent:
  re-run the batch decision after the abort settles.
- **The 3-second "done" removal timer drops finished parts from the composed
  message** — `src/store/transfers.store.js:229-233` vs `:151-161`.
  `maybeSendBatch` reads parts from `items.value`, which the timer has
  already pruned for any upload that finished more than 3s before the
  slowest one in the batch. Minimal fix: hold `parts` on the batch, not
  derive them from the live row list.
- **Losing writer in a slot-creation race silently discards the write**
  (two tabs/devices) — `src/lib/data/slots.ts:99`,
  `src/libs/EncryptionManagerPQ.js:644-648`. Demonstrated by execution: the
  losing tab tombstones its own row but never writes its payload to the
  address it lost to, so the save reports success and the data is gone.
  Minimal fix given: re-issue the write against the adopted address before
  returning.

### Medium — backlog

- `src/store/transfers.store.js:168-174,278-281` — a failed file-message send
  reports nothing to the UI (`batches` not exposed); silent third state the
  project's own invariant #2 forbids.
- `src/views/chats/Page_Chat.vue:969-988` — editing a composed message
  (photo/file + caption) replaces attachments and quote with plain text.
- `src/lib/data/ingest.ts:281-283` vs `dialogs.store.js:470,581` —
  `assertFreshBase` is only called for `dialog_messages`; `user_storage` and
  reaction writes mark themselves unconfirmed on a barrier timeout but nothing
  ever checks the flag before building the next write on that base.
- `src/libs/EncryptionManagerPQ.js:105` — `#pushOwnCard` reads
  `user_cards` without `preload()` under an `'accepted'` (unbarriered) write
  contract; two rapid renames can sign the same `owner_timestamp` and the
  second is rejected while the local registry already shows it applied.
- `src/lib/data/userStorage.ts:92-94` — `getStorageRow` picks by
  `owner_timestamp` alone, ignoring `syncStatus`; a server-rejected local
  revision (always stamped with a timestamp ≥ the winner's) can permanently
  shadow the accepted one after a quarantine.
- `src/lib/pq/verifyCard.ts:64-78` — key certificates bind a public key to
  itself, not to `user_hash`; two identities can certify the same key
  (unknown-key-share). Pre-existing backend format, not introduced by this
  branch, but `verifyCard.ts` is new and its docstring claims a binding the
  code does not check.
- `src/store/dialogs.store.js:367-392` — `dialog_keys` rows are consumed
  without a signature check, despite this branch adding a `signableFields`
  entry for the relation with no caller. Pre-existing pattern, notable
  because every other replicated relation now has a verification layer and
  this one does not.
- `src/components/chat/ChatWindow.vue:626-653` — the open lightbox tracks a
  numeric index into a list that can reorder (out-of-order message admission
  is the expected case for this app), so a message finishing decryption
  while the lightbox is open can silently swap which photo/caption is shown.

### Low — backlog

- `src/store/dialogs.store.js:237-239` — confirmed optimistic message entries
  are filtered from the view but never removed from the underlying map.
- `src/components/chat/ChatWindow.vue:859-866` — long-press timer not
  cleared in `onBeforeUnmount`.
- `src/lib/pq/slotId.ts:45-52` — the new root-storage-slot address
  derivation has no golden vector; the axis agent showed the full suite stays
  green after changing the HKDF `info` string, meaning nothing pins the one
  derivation that decides whether an account can find its own data.
- `tests/transferDock.test.js` — the dialog-count pluralization branch is
  untested; the seed helper never populates the collection the count reads
  from.

## What this review does not cover

- No adversarial verification pass (see Method) — findings above rest on
  direct reading and, where the axis agent already executed a proof,
  reproduction of that reading, not an independent second agent trying to
  refute them.
- Round 2 (review-of-fixes) did not run. The fix commit `9674c8f` has not
  been reviewed by a fresh agent for regressions it might have introduced.
- Docs, `package-lock.json`, generated schema output (`schema.generated.ts`'s
  generator script itself), and `e2e/*.spec.ts` were not covered by a
  dedicated axis.
- E2E (Playwright) suite was not run, per this repo's own standing
  instruction that it only runs on explicit request.
- The `files` relation's non-injective signature payload (same class as the
  fixed... as the *reported* `user_cards` issue) has no receive-side
  verifier in this codebase at all yet, so its exploitability could not be
  demonstrated end-to-end the way `user_cards` was.

## Recommendation

Not mergeable to `tanstack-migration` yet on this review's own findings —
one high-confidence identity-forgery path (`user_cards` signature
canonicalization) is open and needs the owner's decision before code changes
touching the backend wire format proceed. Locally-fixable high findings
(transfer-batch data loss ×2, slot-creation race) are scoped and ready; each
has a minimal fix already written out above.

Shortest path from here: a follow-up round with a smaller, targeted budget —
review-of-fixes on `9674c8f` (regression check only, cheap), then fix the
three local-only high findings with the same test-reverts-red discipline
used this round. The security finding is a decision for the owner, not
something to fix unilaterally across two repos in an unattended run.

# Backlog

A living list of product and technical tasks with no urgency attached. Numbers
are stable: a finished item leaves a gap, so references keep pointing at the
same item.

---

## 2. Exchanging avatars between users

There is no mechanism today. `EncryptionManagerPQ.loadAvatar` reads the
`user_storage` row of **its own** `user_hash` and decrypts it with a key from
**its own** `crypt_skey` (salt `avatar-encryption`). There is nothing to decrypt
someone else's avatar with, and `user_cards` has no avatar field at all. A
contact's avatar is shown only if they are saved in local contacts; otherwise a
generated placeholder is drawn.

Options: put the avatar in `user_card` in the clear (cards are public anyway),
or encrypt it with the dialog key instead of a personal one. Needs a product
decision.

---

## 3. The weight of the `user_cards` shape

Measured 2026-08-14: a 740 KB snapshot over 30 rows (~24 KB per card because of
the ML-DSA/ML-KEM keys) plus a 2.08 MB catch-up log over 112 entries — one card
appears in the log 27 times, because every rename publishes the whole row. That
is ~2.8 MB to reach "up-to-date".

The server does not compress: a response with `Accept-Encoding: gzip, br` is the
same size, while locally gzip -9 takes off 25%. The bytes are cached by the
browser (`max-age=604800`), but parsing and loading them into a collection
repeats on every start.

What to do: enable gzip on the endpoint (backend side, every client benefits);
think about compacting the shape log.

---

## 4. Verifying collection persistence (L1) on devices

The layer is on by default (`309731b`): collections come up from SQLite before
the network answers, and Electric fetches the delta from the stored offset.

Still to check: OPFS support in the target browsers (Safari, the WebView on a
Pi) — without it the code falls back to in-memory by itself, but that needs to
be seen; a warm start against live staging (log in → messages → reload → instant
render → only new rows fetched); and how two tabs behave through
`BrowserCollectionCoordinator`.

---

## 6. Covering the migration of old records in CI

The migration of records written before encryption has only been checked by hand
in a browser: a test hook mutes the IndexedDB path. `fake-indexeddb` is already
in devDependencies (the chunk-cache tests use it) — what remains is to drop the
hook and move both scenarios into CI.

---

## 7. Claude Code skills for repeated procedures

**What.** `CLAUDE.md` and `docs/invariants.md` cover *knowledge*: what must not
be broken and why. They do not cover *procedures* — multi-step actions that
repeat from task to task and are reconstructed from session memory every time.
There is a separate mechanism for those: `.claude/skills/<name>/SKILL.md`,
picked up on invocation or by the task's context.

**Candidates** (from the experience of this migration):

- **Handling an external review.** For each finding: verify against the backend
  source → fix → write a test → check the test fails without the fix → run
  lint/test/build → push to the working branch → merge into the integration
  branch → push that. Three rounds of review went through this, and steps kept
  getting lost (not pushed, not merged into the integration branch).
- **Syncing with staging by hand.** Start the dev server, check the backend is
  alive (`/shapes` is not 503), walk a scenario with two accounts, capture the
  HAR and the console. Today it runs into WebAuthn (§1) — the skill makes sense
  once that is solved.
- **Adding a table or field to the wire format.** Open the Ecto schema → check
  the fields → update `createGenericMutation`/`CHECK_FIELDS` → a test on the
  mutation's shape. We already sent `sign_hash` somewhere it does not exist.

**When.** Not as a separate task — create a skill at the moment the next task
needs that procedure again. The obvious first trigger is the next round of
external review.

---

## 8. Recorded earlier

- Component tests for `Page_Chat.vue` — the biggest gap in coverage.
- The merge decision after comparing with the parallel developer's branch.
- Check PR #26 (`chore/add-typescript`) and #27
  (`ref/dialog-crypto-types-and-tests`).
- Do NOT build out the read-cache fallback for dialog history, versions and keys
  until OPFS device-validation on a real Raspberry Pi / WebView (the Pi
  acceptance comes first): stable OPFS removes the fallback entirely.
- Bounded-concurrency transport for the outbox — in the backlog with
  preconditions (ADR §7.2): metrics for the bottleneck, global accounting of
  429/Retry-After, and the batch contract for /ingest_each.

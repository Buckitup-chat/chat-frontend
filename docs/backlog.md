# Backlog

A living list. The top block is what blocks work right now; below it are product
and technical tasks with no urgency attached.

---

## 1. A rig with automatable WebAuthn (blocks autonomous testing)

**The problem.** Logging into the app requires Touch ID. Every check that needs
a live account — dialog sync, message delivery, avatars, offline → online, two
accounts in one browser — runs into a human pressing a finger. A scenario cannot
be run autonomously, let alone in CI. Right now every login costs one
interruption of whoever owns the laptop.

**What is needed.** A mode where `navigator.credentials.create/get` answer
without a human, while the production path stays untouched.

### Option A — a virtual authenticator over CDP (recommended)

Chrome has a first-class `WebAuthn` domain in the DevTools Protocol:

```js
const client = await page.context().newCDPSession(page);
await client.send('WebAuthn.enable');
await client.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
```

After that `create()` and `get()` return instantly and without prompts.

- **Upside:** zero changes in application code — what is exercised is exactly
  the path that ships, including `@lo-fi/webauthn-local-client` and unlocking
  the vault. Works locally and in CI.
- **Downside:** a `playwright` (or `puppeteer`) dependency plus a Chromium
  download (~150 MB) — devDependencies only.
- **Size:** about a day. A `tests/e2e/authenticator.ts` helper, a "logged-in
  account" fixture, and one or two scenarios on top of it.

### Option B — a test flag in the application

`VITE_FAKE_AUTHENTICATOR=1` replaces the WebAuthn calls with a stub holding a
deterministic key.

- **Upside:** no new dependencies, works in any browser, including the preview
  panel.
- **Downside:** what is exercised is not the code that ships, and the codebase
  gains a branch that bypasses authentication — one that must never be built
  into a release by accident. It takes discipline (a CI check that the flag is
  off in the production build).
- **Size:** half a day.

### Option C — vault fixtures without the UI

Lay a ready unlocked vault straight into IndexedDB before the app starts,
skipping the login screen.

- **Upside:** the fastest of the three, no WebAuthn at all.
- **Downside:** it covers neither login nor account creation — which is exactly
  the stretch that breaks most often. The fixture has to be repaired every time
  the vault format changes.

**Recommendation:** A as the main route, C as an accelerator for tests that do
not care about login. B only if A turns out to be incompatible with the build.

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

---

## 9. Drag and drop files into the composer (desktop)

**What.** On a desktop browser, dropping files anywhere over an open dialog
starts the same upload the 📎 button starts today, captioned by whatever is in
the input.

**Why it is small.** The picker path already does the work: `onFilePicked`
(`ChatWindow.vue`) turns a `FileList` into `emit('sendFile', files, caption)`,
and `transfers.store` enqueues and drains it. A drop handler produces the same
`File[]` and calls the same emit — no new upload code, no protocol change.

**What the change has to get right:**

- **Drop target is the dialog pane**, not the 40 px input — a drop zone the
  size of a text field is a target users miss. Show an overlay while a file is
  dragged over it (`Drop to send to <name>`).
- **`dragover` must call `preventDefault()`.** Without it the browser navigates
  away to the dropped file and the open dialog is lost — the classic way this
  feature ships broken.
- **Ignore drags that carry no files** (dragged text, links, images from
  another tab arrive with different `dataTransfer` types) and ignore in-app
  drags, so reordering the upload queue in `TransferPanel` does not turn into a
  send.
- **Folders**: `DataTransferItem.webkitGetAsEntry()` — either walk the tree or
  refuse with a visible reason. Silently dropping a dragged folder on the floor
  is the one outcome to avoid.
- **Caption follows the picker rule**: the text in the input becomes the
  caption of the composed message and the input clears. One behaviour, two
  entry points.
- **No open dialog, no drop target.**

**Natural companion, same entry point:** pasting a screenshot from the
clipboard (`paste` event with `clipboardData.files`). Same `File[]`, same emit;
worth doing in the same change while the handler is open.

Touch platforms have no file drag and drop, so this is desktop-only by nature —
nothing to hide or degrade on mobile.

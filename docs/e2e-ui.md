# UI E2E: a real browser against staging

`npm run test:e2e` runs the whole UI cycle in headless Chromium with nobody
watching. The tests live in `e2e/` in this repository: they are versioned with
the UI they check, and a markup change is fixed in the same PR that made it. A
separate repository would buy nothing here except drift.

## How the passkey is handled

There is no special build — the production code is what gets tested. Playwright
attaches a CDP Virtual Authenticator to the page (`e2e/fixtures.ts`): a platform
authenticator with user verification and automatic presence. Every
`navigator.credentials` call — creating the passkey, unlocking the vault —
resolves silently, and `isUserVerifyingPlatformAuthenticatorAvailable()` honestly
answers true. The production WebAuthn path runs end to end.

## Rules learned from real failures

- **Navigate inside the app only** (menu clicks). `page.goto()` is a full SPA
  reload: the vault locks and the app drops to the login screen. Reload and
  re-login is its own scenario, not a side effect of navigation.
- **The account pair is worker-scoped and created concurrently** (~80 s per
  account against staging). One pair serves every test in the worker, and tests
  inherit a dialog with real history.
- **One worker.** Staging is shared and dialogs are stateful; parallelism comes
  later.
- Account names are unique per run (`e2e-<role>-<runId>`) and double as the
  lookup key: adding a contact by hand means searching that name in the list, no
  QR involved.
- Cross-account sync waits go up to 90 s — the card and the message travel
  through staging's shapes.

## Coverage

Done:
- [x] account creation through a passkey (account.spec)
- [x] manual contact search and messages both ways — asynchronous sync observed
      through the receiving UI (dialog.spec)
- [x] editing a message (the edited mark and the revision history, screen 06)
- [x] deletion (a tombstone on both sides)
- [x] quoting and the jump back to the original
- [x] reactions (on the receiving side)
- [x] delivery marks ✓✓ (automatic) and the read receipt only on an explicit act
- [x] files: a document as a file row; cancelling one file of a batch leaves the
      rest to arrive
- [x] images: arrive as an image (a decrypted `<img>`), not as a file row
- [x] video: arrives as a playable frame (the webm is recorded by the browser
      itself)
- [x] drafts: type, leave, come back; sending clears it
- [x] checkpoints: creation, EXACT_MATCH, the diff after a change, the future
      marker
- [x] alerts: the dot on the dialog, click through to the comparison
- [x] profile: a rename reaches the other side through the card
- [x] offline: setOffline, send into the outbox, delivery after reconnect
- [x] reload: reload, log back in with the same passkey, history intact (OPFS)

Limited by the harness:
- [~] multi-tab (z-multitab, test.fixme): the product supports several tabs, but
      Chrome gives one internal authenticator per context and two tabs of one
      account must share that context. A limitation of the virtual passkey, not
      of the application.

## Limitations

- Every run leaves fresh user_cards and messages on staging — same as the
  protocol-level `e2e.staging.test.ts`; acceptable while staging is a test
  environment.
- Browser binaries come from the container image (`/ms-playwright`);
  `PLAYWRIGHT_BROWSERS_PATH` is wired into the npm script.
- The suite is not in CI: a run costs minutes and depends on staging being up.
  Start it by hand or on a schedule; putting it in CI is a conversation for when
  the suite has settled.

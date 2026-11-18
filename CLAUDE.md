# BuckitUp frontend — guidance for Claude Code

Read this before touching code. It exists because the same things were
rediscovered from scratch in several sessions and by more than one developer.

## What this is

Privacy-first, offline-first, end-to-end encrypted messenger. Runs in the
browser and on Raspberry Pi nodes that may have no internet at all. Vue 3
(`<script setup>`), Vite, Pinia. Data layer: ElectricSQL shapes → TanStack DB
collections (`src/lib/data/`). Crypto: ML-DSA-87 signatures, ML-KEM-1024,
SHA3-512, AES-256-GCM.

Product landing: buckitup.info. Backend repo: `Buckitup-chat/chat` (Elixir /
Phoenix / Ecto).

## Before you change anything

1. **Read `docs/invariants.md`.** Every rule there came from a real failure.
   Do not violate one without a written, agreed exception.
2. **Use the released SDK contract for protocol operations.** Wire fields,
   signing and normalization come from the installed SDK, not local field
   lists. Verify compatibility against backend schemas and requirements when
   investigating a mismatch; do not silently change the SDK contract in the
   frontend. When a review says "the backend does X", open the backend and
   check before fixing.
3. **Branch discipline.** `main` is the only integration branch, and staging
   deploys from it. Every feature or fix branch starts from the current
   `origin/main`. Start every working session — and always before opening a
   PR — with `git fetch origin` and a merge of (or rebase of your unpushed
   work onto) `origin/main`. A stale base is not a style issue: it reproduces
   bugs that are already fixed upstream and turns the eventual merge into an
   archaeology dig. Every change reaches `main` through a PR, after review and
   with CI green. `tanstack-migration` is not a base for new work, and new
   changes are not ported back into it. Only the repository owner pushes or
   merges directly into `main`. "Done" means pushed and visible to the
   others, not sitting in a local commit.

4. **No backward compatibility is owed.** The project is in active development
   with no user base: when a format changes, change it outright. Do not write
   migrations for existing rows, legacy read paths or version compatibility
   shims, and do not treat data already published by test accounts as something
   to protect. Ask first if a case seems to need otherwise.

## Things that bit us (short list; details in docs/invariants.md)

- Local storage does not need extra encryption to hide metadata (CTO
  decision, 2026-08-19): access control for metadata starts at the backend.
  Message content stays end-to-end encrypted by the protocol, and a key that
  opens content (a file's `enc_secret`, a dialog key, a private key) is
  content: never stored in the clear. `secureStore` exists for
  outbox/localStore; a new store needs it only if it holds such a key.
- Per-row server acceptance is distinct from shape visibility and verification.
  App writes use durable intents/outbox; `writeContracts.ts` selects accepted
  or visible confirmation. Chained writes can use durable accepted snapshots;
  a caller that needs replicated state must await visibility.
- `owner_timestamp` must be strictly monotonic: use `nextOwnerTimestamp`, never
  bare `Date.now()/1000`.
- Use SDK normalization for shape binary columns; do not compare raw Base64
  encodings. The encoding contract is in pq-library/docs/row-encoding.md.
- Build mutation fields from the installed SDK schema, including sign_hash;
  do not maintain a second relation/field list in the app.
- `/shapes` is the sanctioned read endpoint; `/user_card`, `/user_storage`
  proxies are deprecated.
- Read receipts are irreversible and must **never** be sent on render/scroll —
  only on an explicit user action.
- Reactions bind to a message *revision* (`message_sign_hash`); messages are
  versioned, reactions are not.
- Multiple tabs are allowed. The old single-tab gate guarded PGlite, which is
  gone on this stack.

## Verification standard

- `npm run typecheck`, `npm test` (vitest), `npm run lint`, `npm run build` —
  all green before a commit is called done. CI runs the same four.
- A regression test must **fail without the fix**. Verify by temporarily
  reverting the fix; if the test stays green, it is not testing anything.
- Prefer real dependencies over mocks where they run under node/jsdom
  (composables, crypto). Where a transport must be faked, make the fake honour
  the contract (e.g. a write is readable after the barrier), otherwise every
  "re-read after barrier" is tested against a lie.
- Component tests: `// @vitest-environment jsdom` per file; default env stays
  node so unit tests stay fast.

## Review

For reviewing a branch, PR or release candidate use the `deep-review` skill
(`/deep-review <branch> --base origin/main`); `deep-review-loop` alternates review
and fixes until no confirmed critical/high defect remains. Neither is for a
quick look at a small diff — they fan out subagents and cost real money.

Facts reviewers cannot infer from the code:

- Tests: `npm test` runs the frontend integration and component suite. SDK
  tests and releases live in `Buckitup-chat/pq-library`. The frontend consumes
  an exact npm registry dependency; never restore an alias to SDK sources.
- Compare a branch against the current `origin/main` (`git fetch origin`
  first): compute the merge-base with it and check the commit count against
  what the author claimed.
- SDK crypto changes are reviewed and tested in `Buckitup-chat/pq-library`.
  App passkey recovery golden vectors remain in `tests/passkeyRecovery.test.ts`.
- When reading eslint output, the total is the "N problems (X errors, …)"
  line; the "potentially fixable" line below it is not the error count.

## Where things live

- `src/lib/data/` — collections, ingest transport, barrier, outbox, secure
  store, persistence flag. Start here for anything sync-related.
- `src/store/dialogs.store.js` — dialog write path, optimistic state, reaction
  and receipt logic.
- `src/libs/EncryptionManagerPQ.js` — vault, identity, user card publication.
- `@buckitup/pq-client/dialogs` — protocol hashes, key wrapping and content encryption, maintained in the SDK repository.
- `docs/` — invariants, backlog, encryption layout, migration reports.
  Work notes go there or into the PR description, never the repo root.

## Documentation

SDK protocol and API documentation live in `Buckitup-chat/pq-library/docs`.
Keep frontend usage in the README's Protocol SDK section and link to SDK documents
instead of duplicating their protocol definitions here.

Documents meant to be read and shared — `README.md`, `docs/*.md`, specs, handover
notes, exported reports — describe how things are **now**. The path that led there
is not part of them: a reader who has never seen an earlier version should not be
able to tell which parts were edited.

- When something turns out wrong or unnecessary, rewrite the sentence. Do not
  append a correction beside it — no "UPD", no "this is no longer true", no
  crossed-out text, no warning about a problem that is already gone.
- Something removed from the product does not earn a line saying it was removed.
- Keep what looks like history but is current knowledge: why a decision was made,
  a rule derived from a past failure (state the rule, not the story), migration
  instructions, and a deprecation notice while the deprecated thing still answers.
- The record of what changed belongs in the commit message, the PR description or
  a report — not in the document.

Exempt: logs, working notes, investigation and migration reports. Their subject
*is* the past, and stripping it would empty them.

Task and specification documents are current requirements unless explicitly
marked as historical or superseded. A `task-` filename or completed
implementation alone does not make a document historical. Update implementation
paths, ownership and commands when code moves, while preserving requirements,
security properties and acceptance criteria. Relocation does not authorize
weakening them; a deliberate scope change must be stated explicitly.

Exception to the no-history rule for tasks: retain a concise decision summary
when the agreed implementation approach changes. Distinguish the original
agreement, the replacement decision, why the task or requirement remains, and
the current implementation. This is context for the task, not an edit log;
outdated paths in that summary must be labelled as the original plan.

Separate required behavior from verification evidence. An acceptance checklist
does not mean those checks passed. Record the tested version, environment and
results in a report or PR; identify device/deployment checks that remain required.
When a specification delegates protocol details to an SDK, name the consumed
package version and link to an immutable revision of its contract. A moving
`main` link is navigation, not a versioned requirement.

## Environment notes

- Staging backend: `buckitup.xyz` (may be down; a 503 on `/shapes` is theirs,
  not ours).
- WebAuthn login in the embedded browser panel is unreliable after host sleep;
  account *creation* works. Logged-in flows are checked by the E2E suite
  instead, whose virtual authenticator needs no finger (`e2e/fixtures.ts`,
  `npm run test:e2e`). The suite is heavy and runs against staging: run it
  when asked, not after every change.
- Vite pre-bundling breaks packages that ship workers as relative-URL assets
  (`@tanstack/browser-db-sqlite-persistence`, `@journeyapps/wa-sqlite`); they
  are excluded in `vite.config.js`. If you see "OPFS worker terminated
  unexpectedly", check that exclude list and clear `node_modules/.vite`.

## Language

The owner communicates in Russian; everything that lands in the repository —
code, comments, commit messages, PR descriptions, and every document under
`docs/` — is written in English.

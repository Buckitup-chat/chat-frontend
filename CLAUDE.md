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
2. **The backend source is the contract**, not this repo's comments and not a
   reviewer's claim. Wire fields come from `chat/lib/chat/data/schemas/*.ex`;
   protocol from `chat/docs/reqs/pq_dialogs.md`. When a review says "the backend
   does X", open the backend and check before fixing.
3. **Branch discipline.** Two developers work on the TanStack migration in
   separate branches; results are compared when both are ready. Do not merge
   migration work into `main`. Work branch → `tanstack-migration` (integration,
   for testing) → owner's decision. "Done" means pushed and visible to the
   reviewer, not sitting in a local commit.

4. **No backward compatibility is owed.** The project is in active development
   with no user base: when a format changes, change it outright. Do not write
   migrations for existing rows, legacy read paths or version compatibility
   shims, and do not treat data already published by test accounts as something
   to protect. Ask first if a case seems to need otherwise.

## Things that bit us (short list; details in docs/invariants.md)

- Local storage does not need extra encryption to hide metadata (CTO
  decision, 2026-08-19): access control for metadata starts at the backend.
  Message content stays end-to-end encrypted by the protocol. `secureStore`
  exists for outbox/localStore but is optional for new stores.
- HTTP 200 from `/ingest_each` ≠ row visible in the shape. Writes whose
  successor reads the shape must go through `sendMutationsAndAwaitShape`.
- `owner_timestamp` must be strictly monotonic: use `nextOwnerTimestamp`, never
  bare `Date.now()/1000`.
- Base64 padding differs by direction and this bites every time: the signature
  payload is built with padding, the shape endpoint returns binary columns
  without it. Re-pad a value taken from a shape before signing or verifying.
- Only `dialog_messages` and `dialog_messages_versions` have `sign_hash`.
- `/shapes` is the sanctioned read endpoint; `/user_card`, `/user_storage`
  proxies are deprecated.
- Read receipts are irreversible and must **never** be sent on render/scroll —
  only on an explicit user action.
- Reactions bind to a message *revision* (`message_sign_hash`); messages are
  versioned, reactions are not.
- Multiple tabs are allowed. The old single-tab gate guarded PGlite, which is
  gone on this stack.

## Verification standard

- `npm test` (vitest), `npm run lint`, `npm run build` — all green before a
  commit is called done. CI runs the same three.
- A regression test must **fail without the fix**. Verify by temporarily
  reverting the fix; if the test stays green, it is not testing anything.
- Prefer real dependencies over mocks where they run under node/jsdom
  (composables, crypto). Where a transport must be faked, make the fake honour
  the contract (e.g. a write is readable after the barrier), otherwise every
  "re-read after barrier" is tested against a lie.
- Component tests: `// @vitest-environment jsdom` per file; default env stays
  node so unit tests stay fast.

## Where things live

- `src/lib/data/` — collections, ingest transport, barrier, outbox, secure
  store, persistence flag. Start here for anything sync-related.
- `src/store/dialogs.store.js` — dialog write path, optimistic state, reaction
  and receipt logic.
- `src/libs/EncryptionManagerPQ.js` — vault, identity, user card publication.
- `src/libs/DialogCrypto.js` — hash derivations (`dialog_hash`,
  `reaction_hash`, `receipt_hash`), key wrapping, content encryption.
- `docs/` — invariants, backlog, encryption layout, migration reports.
  Work notes go there or into the PR description, never the repo root.

## Documentation

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

## Environment notes

- Staging backend: `buckitup.xyz` (may be down; a 503 on `/shapes` is theirs,
  not ours).
- WebAuthn login in the embedded browser panel is unreliable after host sleep;
  account *creation* works. This blocks manual verification of logged-in flows
  — see `docs/backlog.md` §1 for the planned fix.
- Vite pre-bundling breaks packages that ship workers as relative-URL assets
  (`@tanstack/browser-db-sqlite-persistence`, `@journeyapps/wa-sqlite`); they
  are excluded in `vite.config.js`. If you see "OPFS worker terminated
  unexpectedly", check that exclude list and clear `node_modules/.vite`.

## Language

The owner communicates in Russian. Code, comments and commit messages are in
English. Docs under `docs/` are in Russian unless they are developer-facing
references (like this file).

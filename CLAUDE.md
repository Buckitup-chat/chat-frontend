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

## Things that bit us (short list; details in docs/invariants.md)

- Local storage must be encrypted **including metadata**, not just message
  bodies. Check any library that writes to disk before adopting it.
- HTTP 200 from `/ingest_each` ≠ row visible in the shape. Writes whose
  successor reads the shape must go through `sendMutationsAndAwaitShape`.
- `owner_timestamp` must be strictly monotonic: use `nextOwnerTimestamp`, never
  bare `Date.now()/1000`.
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

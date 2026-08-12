# TypeScript Guidelines

How we migrate `chat-frontend` from JavaScript to fully-typed TypeScript,
**incrementally and without regressions**. This is a living contract: when a
rule here proves wrong or a phase completes, update the doc in the same PR.

## Goal

Every module type-checked under `strict` mode. We get there file by file, not
in one rewrite. The rule that makes gradual migration safe is a **ratchet**:
the amount of untyped code and the number of type errors may only ever go
**down**. A change that adds a new `.js` file, introduces a type error, or
weakens types to silence one is rejected by CI — even while most of the
codebase is still JavaScript.

## Current state (2026-08)

- New data layer `src/lib/data/**` is written in TypeScript.
- Overall the tree is still majority JS: ~33 `.js`, ~25 `.ts`, 67 `.vue`
  (only a few with `lang="ts"`).
- Type-checking infrastructure (a `tsconfig.json`, a `typecheck` script, and a
  CI gate) lives on branch **`chore/add-typescript`** and is owned by the dev
  doing that work. Do not duplicate it; align with it.
- Because that infra is not yet merged everywhere, some `.ts` is currently
  "TypeScript-flavoured" — the types exist but nothing checks them, so they
  have already drifted (see the `Row<unknown>` fix in `git log`). **Typed code
  is only as good as the gate that checks it.**

## The tooling (from `chore/add-typescript`)

- `tsconfig.json`: `strict: true`, `allowJs: true`, `checkJs: false`.
  - `allowJs` lets `.js` and `.ts` coexist during the migration.
  - `checkJs: false` means `.js` files are **not** themselves type-checked —
    but TypeScript still **infers** types from them for any `.ts` that imports
    them. This is why untyped JS at a boundary poisons typed callers (see
    "Type the boundary first").
- `npm run typecheck` → `vue-tsc --noEmit` (checks `.ts` **and** `.vue`; plain
  `tsc` cannot read `.vue`).
- CI runs `typecheck` alongside `lint`, `test`, `build`. A red typecheck
  blocks merge — that is the ratchet's teeth.

## The ratchet, concretely

`scripts/ts-ratchet.mjs` counts what is still untyped in `src/` and compares it
with the committed baseline `ts-ratchet.json`. CI runs it on every PR
(`.github/workflows/ts-ratchet.yml`).

| Command | What it does |
|---|---|
| `npm run ratchet` | Check against baseline. Fails if untyped files increased. |
| `npm run ratchet:list` | List every file that still counts (your worklist). |
| `npm run ratchet:update` | Rewrite the baseline to current counts. |

It counts two things: `.js` files under `src/`, and `.vue` files without
`lang="ts"`. Three outcomes:

- **Counts grew** → CI fails. You added untyped code; make it `.ts`.
- **Counts unchanged** → passes. Business as usual on legacy files.
- **Counts dropped** → CI fails *on purpose*, telling you to run
  `npm run ratchet:update` and commit `ts-ratchet.json`. That commit is the
  ratchet clicking forward: the new, lower number can never be exceeded again.

The dropped-count failure is deliberate. If progress silently passed without
updating the baseline, the slack would stay in the system and a later PR could
re-add untyped files for free.

**This is a separate gate from `typecheck`.** The ratchet tracks *how much* is
migrated; `typecheck` verifies the migrated code is *correct*. Both are needed:
the row-types bug in `src/lib/data/` was typed code that no one checked.

## Rules for every change

1. **New code is TypeScript.** New files are `.ts`; new components use
   `<script setup lang="ts">`. Do not add new `.js`.
2. **`npm run typecheck` must be green.** Not "green except mine". If your
   change can't pass yet because it depends on untyped JS, type that boundary
   first (rule 5) rather than shipping red.
3. **No `any`, no `@ts-ignore`/`@ts-expect-error`** without an inline comment
   explaining why and a linked issue. These are ratchet-release valves; each
   one is debt someone must remove.
4. **Types passed to library generics must be `type` aliases, not `interface`.**
   Concrete lesson from this repo: `electricCollectionOptions<T>` constrains
   `T` to `Row<unknown>` (an object with a string index signature). A TS
   `interface` has **no** implicit index signature (it can be augmented by
   declaration merging), so row *interfaces* failed the constraint; the same
   shape as a `type` alias satisfies it without weakening fields. Model
   Electric/TanStack row and DTO shapes as `type`.
5. **Type the boundary before the leaf.** The largest source of hidden errors
   is typed code importing untyped JS: `tsc` infers `null`, `unknown`, or
   narrow literals there. Example: `EncryptionManagerPQ.getInstance()` is
   inferred as `null` because its module is untyped JS, so every typed caller
   that dereferences it errors. Fixing the caller is impossible until the
   module has types. **Priority order for conversion: modules the typed layer
   already imports come first.**

## Migration order

Work inward from what typed code already depends on:

1. **Boundary modules imported by `src/lib/data/**`** — `src/api/client.js`,
   `src/libs/EncryptionManagerPQ.js`, `src/libs/DialogCrypto.js`, `enigma`.
   Convert to `.ts` (preferred) or add a colocated `.d.ts`. This clears the
   remaining `src/lib/data` errors that are *not* fixable from inside the
   data layer (`ingest.ts`, `userStorage.ts`, `localCrypto.ts` — all four
   trace back to these untyped imports).
2. **Pinia stores** — `dialogs.store.js`, `userPQ.store.js`, `user.store.js`.
   They sit between the typed data layer and the components; typing them
   propagates types outward in both directions.
3. **Composables and shared utils.**
4. **Components** — convert `<script>` to `<script setup lang="ts">`,
   leaf/simple components first.

## Definition of done, per file

- Renamed to `.ts` (or `.vue` gains `lang="ts"`).
- No `any`/`@ts-ignore` added (rule 3).
- `npm run typecheck`, `npm run lint`, `npm test` all green.
- If an allowlist of "not yet typed" paths exists, the file is removed from it
  — that removal *is* the ratchet clicking one tooth forward.

## Anti-patterns

- **Big-bang conversion.** Convert in small, reviewable PRs; a giant rename PR
  is unreviewable and collides with everyone.
- **Casting to pass the gate.** `x as SomeType` / `as any` to make `typecheck`
  green re-hides the very bug the type system just found (see the reverted
  `localCrypto` null-guard in this branch's history — a cast there would have
  masked that the *module*, not the caller, needs typing).
- **Typing `.js` in place expecting it to be checked.** With `checkJs: false`,
  JSDoc types on a `.js` file are used for inference but the file itself is not
  verified. To actually check a module, it must be `.ts`.

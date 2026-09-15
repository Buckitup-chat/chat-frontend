# PoC: Electric Shapes → TanStack DB for the message path

> **Status: migration completed (2026-08).** Kept as the historical record of
> the investigation. The migration landed as stacked PRs: #21 (typed data
> layer) → #22 (dialog read path) → #23 (direct-mutation writes) → #24
> (PGlite removal). PoC PR #20 is superseded. Current architecture lives in
> `src/lib/data/` — see README.

Branch: `poc/tanstack-db-sync`. Status: proof of concept, not production code.

## Why

PGlite (WASM Postgres over IndexedDB) is the message-sync bottleneck, measured on
https://buckitup-client.netlify.app (2026-07-21, desktop, empty fresh account):

| Metric | PGlite path | TanStack DB path (this PoC) |
|---|---|---|
| DB/collection ready, cold start | **13 700 ms** | **676 ms** |
| DB ready, warm start | 2 900 ms | n/a (in-memory + shape resume) |
| Trivial SELECT on empty table | ~300 ms | in-memory, sub-ms |
| Full outgoing-changes scan (`sendChanges`) | 2 300–2 500 ms per cycle | n/a (mutations post directly) |

ElectricSQL itself has narrowed scope to the sync engine and recommends TanStack DB
as the client store (see blog posts of 2025-07-29 and 2026-03-25); `pglite-sync`
remains alpha with no local-write path.

## What the PoC contains

1. **Push-protocol fix** in `src/utils/db/localDBv2.js` (independent of the migration,
   fixes today's "messages never deliver" bug):
   - per-row outcome handling on any HTTP status (server sends per-row results even on 4xx);
   - permanently rejected rows (`validation_failed`) are quarantined locally instead of
     poisoning every subsequent batch forever;
   - exponential backoff (5s → 5min) for transient failures.
   Verified live: previously stuck queue (2 rows, permanent 422/500 loop on the stand)
   now reports `Sent 2 pending changes (all ok)`.

2. **TanStack DB read path for one dialog**: `src/lib/tanstack/dialogMessages.js`
   (Electric collection over the client-controlled `/electric/v1/shapes` endpoint with
   `where: dialog_hash = '…'`) + experimental page `src/views/chats/Page_Chat_TanStack.vue`
   at `/chat2/:address` with an on-screen metrics badge (shape-ready ms, rows,
   send→shape round-trip ms). Writes still go through the existing localDB queue;
   sent rows come back through the shape stream (measured end-to-end).

## Gotchas discovered (important for the real migration)

- **`@electric-sql/client` ≥1.5 pauses all shape streams while `document.hidden`**
  (battery saver). The netlify build still uses 1.4.x (no pause). Once the lockfile
  moves to 1.5.x, backgrounded tabs stop receiving sync — probably desired on mobile,
  but must be a conscious decision (option `runtimeVisibility` overrides it; the PoC
  collection keeps streaming when hidden).
- **HTTP/1.1 limits ~6 concurrent connections per origin** — Electric's own warning in
  console. Many long-polled shapes + app requests can starve; HTTP/2 (HTTPS) required,
  and per-dialog shapes should be opened lazily (active dialog only), not all at once.
- Vite prebundling can duplicate `@tanstack/db` between adapter packages — import
  `createCollection` from `@tanstack/db` directly (or configure dedupe).
- PoC rough edge: decrypting own just-sent messages on the PoC page still needs the
  dialog_keys row locally; the page shows `[decrypt failed]` for rows it cannot yet
  decrypt instead of breaking.

## Suggested migration order

1. Land the push-protocol fix (standalone PR, fixes message delivery today).
2. Move the dialog read path (messages, versions, reactions, receipts) to Electric →
   TanStack collections per open dialog; keep PGlite for user_cards/user_storage.
3. Replace the write path with TanStack optimistic mutations posting to `/ingest_each`
   per transaction (no more full-table scans).
4. Move user_cards/user_storage, delete PGlite/worker/schema/localDBv2 (~2 MB less WASM).
5. Optional: TanStack DB 0.6 SQLite persistence for instant warm start / offline.

## Files (delivery & sync) — see main report

File blobs must NOT go through the sync layer: sync `files` manifests as a collection,
upload/download chunk blobs over plain HTTP per `chat` repo `docs/reqs/pq_files.md`
(protocol v2 moves blobs to filesystem; manifests stay in PG/Electric).

# Task: verify file manifests and chunks on the read path

**Base:** `chat-frontend` `main` at `caa3a4b`. Related backend spec:
`chat/docs/pq/reqs/pq_integrity_checker.proposed.md`. That spec is a
server-side sweep; it calls the client's read path "a separate concern", and
this task is that concern. Wire fields come from
`chat/lib/chat/data/schemas/file.ex` and `file_chunk.ex`.

## The hole

Every relation the client reads goes through `verifyReplicatedRow`
(`src/lib/data/rowVerification.ts`):
- `user_cards`, `user_storage`, `dialog_keys`;
- `dialog_messages` and `dialog_messages_versions`;
- `dialog_message_reactions`, `dialog_message_receipts`.

File rows do not.
- **`files`** (the manifest: `total_size`, `chunk_size`, `chunk_count`,
  `chunk_sign_hashes`, `deleted_flag`) is read with `readShapeOnce` and used
  unverified, in two places in `src/lib/data/fileTransfer.ts`:
  - `downloadFile` sizes its loop by `chunk_count`;
  - `fileAvailability` reports `chunk_count` as the total and `deleted_flag`
    as deleted.
- **The chunk bytes** from `GET /file_chunk/:file_id/:i` are checked only by
  AES-GCM. Each chunk is encrypted under the file secret from the signed
  dialog message, with a random nonce and no associated data. So GCM proves a
  chunk belongs to *this file*, not that it is chunk *i*. A server can return
  chunk 3 for index 1, or chunk 0 for every index. Every chunk decrypts, the
  result is cached, and the file is assembled corrupted with no error.

What the hole lets a malicious or corrupted server, a peer in sync or a bad
migration do (the integrity checker's threat table):
- reorder or repeat chunks, so a file opens wrong or does not open;
- change `chunk_count`, so a download stops early or never finishes;
- set `deleted_flag`, so a file shows as deleted.

The name, size and type shown to the user come from the signed dialog
message, not the manifest. They are not affected.

## Fix

`downloadFile` is also changed on branch `gated-reads` (a Bearer token on
chunk fetches); build on it once it lands.

1. **Generate the schemas.** Add `'file_chunk.ex'` to `SCHEMA_FILES` in
   `scripts/gen-pq-schema.mjs`. `file.ex` is there already. Then regenerate
   `src/lib/pq/schema.generated.ts`.
2. **Verify the manifest.** Before `downloadFile` or `fileAvailability` uses
   a `files` row, verify it under the uploader's `sign_pkey` (`uploader_hash`).
   Add `files` to `VERIFIABLE` with that author.
3. **Bind every chunk to its index.** For chunk *i*:
   - read its `file_chunks` row (`file_id`, `chunk_index`), which carries
     `sign_b64`;
   - verify that signature under the same uploader, over the row with
     `data_hash` recomputed from the **fetched** encrypted bytes
     (`chunkDataHash` in `src/lib/pq/fileCrypto.ts`: `fd_` + hex SHA3-512)
     and with `chunk_index = i`;
   - check that SHA3-512 of the row's `sign_b64` equals
     `chunk_sign_hashes[i]` in the verified manifest — how the upload builds
     that list.

   Only then decrypt. This check is mandatory, not "where available": it is
   the only thing that pins a chunk to its position.
4. **Refuse, do not retry.** An invalid manifest or chunk ends the download
   before any further fetch, and the UI says "This file could not be
   verified". A cached chunk that fails the check is evicted. It is not a
   network error.
5. **One rule for invalid rows.** Today each caller of `verifyReplicatedRow`
   decides alone what an `invalid` row does. Pick one rule:
   - dropped and counted;
   - or shown as "could not be verified".

   Write it into `docs/invariants.md`, and apply it here first.

## Acceptance

- A `files` row with `chunk_count` changed and `sign_b64` untouched is refused
  by both `downloadFile` and `fileAvailability`, before any chunk request.
- A server that serves chunk 1's bytes for index 0: the download fails on
  chunk 0, naming it, and nothing corrupted is cached.
- The same for a `deleted_flag` flipped without a signature.
- An untouched file downloads and plays as before, video included.
- **Tests:** a regression test for each refusal, each failing without its
  check (revert the check and watch it go red).
- `npm test`, `npm run lint` and `npm run build` are green.

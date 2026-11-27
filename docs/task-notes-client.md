# Task: notes to self in the client

**Sources:** `chat` `main`: `docs/pq/reqs/pq_notes_to_self.proposed.md` (the
contract; phases 1–3). SDK `@buckitup/pq-client` 1.1.0
([versioned contract](https://github.com/Buckitup-chat/pq-library/blob/b723b1042ae14bad84c88743ed9ed40b966c5a83/docs/protocol.md)):
`notes` (`accountNotes`, note peers), `derivedIdentity` (`DERIVED_CARD_NAMES`),
`dialogs` (`sender_msg_key` without `evm_skey`).
**Design:** "Notes and QR" (notes list, new note, rename, delete,
search, voice note; "Each note is a separate chat with yourself. It syncs to
your other devices.").
**Frontend base:** `chat-frontend` `main` at `de48486` (includes #130).
**After this task:** `docs/task-subaccounts-client.md` reuses its machinery.

## Where it stands

| Step | State |
|---|---|
| PR 1: session identities and per-signer outbox | Merged, #89 |
| Review follow-ups of PR 1 | Issue #107. Items 2, 4, 5 merged in #130: fresh owner/server-card checks before replay, quarantined-card queue checks, and distinct device-read failure outcomes. Items 1 and 3 remain open, below |
| PR 2: notes dialogs in `dialogs.store` | To do |
| PR 3: the note list | To do |
| PR 4: UI | To do |
| PR 5: guarded mode | To do |

`ensureDerivedCard` has no production call sites yet. Notes dialogs, the
note list and the UI remain to be wired in PRs 2–4.

## Before the notes UI: two items of #107

1. **#107 item 1 — a derived card on a server with no owner.** The card waits
   (retryable) and the account's sync status stays "syncing" for as long as the
   server has no owner. The spec says notes wait and "the client says so".
   Decided (2026-11-27): a hold state like `approvalHeld`, released by itself
   when an owner appears, shown in the notes UI as "Notes are kept on this device until this server
   has an owner". Also settle here: `ensureDerivedCard`'s first check can
   answer `present` from the card cache after a node reset; ask the server
   instead, as #130 does for the owner gate.
2. **#107 item 3 — an older build replaying a derived write with the account's
   key.** An old tab holding the leader lock ignores `entry.signer` and proves
   a notes row with the account's key: the server refuses it but has seen the
   two together. Decided (2026-11-27): outbox records are written in a format
   older builds cannot read, so a tab still running an older bundle never
   picks them up.

Both must be closed before PR 4 ships.

## PR 2: notes dialogs in `dialogs.store`

- "Me" in a note is the notes identity, not `currentUserHash`: a `selfFor(peer)`
  (or a `useDialogIdentity` composable supplying `selfHash`) used for the
  dialog hash, keys, edit, delete, reactions and `isMine`.
- Keys: `sender_msg_key` from the notes identity and the note peer, the SDK's
  derivation (no `evm_skey`); a `dialog_keys` row from the notes identity
  wrapped to the peer's `crypt_pkey`.
- **No receipts in a note, ever.** `Page_Chat.vue` acknowledges every row whose
  `sender_hash` is not the current user (lines ~223 and ~307): in a note it would
  sign a delivered receipt as the account into the note dialog. This is the
  worst possible leak.
- **Firewall before enqueue:** refuse a row whose author does not match the
  note-ness of its dialog; refuse every receipt in a note dialog.
- Note shapes get no account read-session bearer (`collections.ts`
  `dialogShape`, `gatedStream`'s 401 path); a 401 marks the note unavailable.
- The note peer's card is a dependency of the dialog rows (published lazily
  with the first message of the first note, `ensureDerivedCard`).
- Account-signed side paths must not run for notes:
  `scanCheckpointAlerts`, gallery reads, read sessions.

## PR 3: the note list

- `src/lib/notes/notesList.ts`, `src/store/notes.store.js`.
- Slot `notes`: `{ "notes": { "<note_id>": { "name": "…", "created_at": 0 } } }`,
  written with `patchSlotJson('notes', { $keyed: ['notes'], … })`.
- `note_id`: 16 random bytes, 32 lowercase hex.
- Rename patches the name. Delete in this order: message tombstones, the
  `dialog_keys` row's `deleted_flag`, the slot entry.
- A note missing from the slot is still reachable through the notes
  identity's `dialog_keys` rows; list it as "Unnamed note" (may come later).

## PR 4: UI

- Route `/note/:noteId`, served by `Page_Chat`.
- For notes hide receipts ("saved", not "delivered"), gallery, guardian
  invites, checkpoints; files come later.
- "Notes" entry in the chats menu; list, new, rename, delete, search per the
  design.
- `UserList` and contact search hide derived cards.
- The "waits for an owner" state from #107 item 1.

## PR 5: guarded mode (spec phase 3)

- On a notes write held as `not_in_trust_chain`, write the vouch on demand:
  call `setContactAccess(account, notesHash, true)` on the active
  `EncryptionManagerPQ` instance, which delegates to the SDK's `contactAccess`
  service; then the write resumes.
- Approval holds become per signer.
- An account at the owner's maximum chain depth cannot keep notes on that
  server: say so, never fail silently.
- `trust` mode: read sessions as the notes identity.

## Acceptance

- [ ] Nothing the account signs lands in a note dialog: no receipts, reactions
      or PoP (fake-server test checks the PoP against each row's author).
- [ ] Notes created on one device appear on another device of the account.
- [ ] Rename and delete from two devices at once merge.
- [ ] Restoring the account from a backup file brings back the notes and
      their names.
- [ ] On a server with no owner, notes stay on the device and the UI says so;
      they go out once the server has an owner.
- [ ] In `guarded` mode the first note works after the on-demand vouch.
- [ ] No notes card is published at registration or sign-in, only with the
      first message of the first note.

# Community backup and recovery: implementation plan

Every product question in
[backup-recovery-overview.md §6](backup-recovery-overview.md) is decided, so
this is the plan to build the decided thing. The defects it has to close are in
[backup-recovery-audit-2026-09.md](backup-recovery-audit-2026-09.md); the target
architecture is [restoration.livemd](restoration.livemd).

Repositories touched: `chat-frontend`, `Community-secret-sharing/*` (node,
relayer, SDK, contracts), and one spec change in `Buckitup-chat/chat`.

## Ordering principle

Three rules decide the order, in this priority:

1. **What is live and dangerous goes first.** One critical is in production
   today (F-C1), and it is closable without anyone else's involvement.
2. **Decisions that delete work are applied before the work they delete.**
   Several audit findings describe paths the product decisions retire — the
   manual copy-paste Shamir path, the testbed's fake network. Retiring them is
   cheaper than fixing them, and doing it first stops the fixes being written.
3. **Deployment-bound items go last.** Contracts v2 needs a fresh deployment,
   which is the owner's action, not a code merge.

## Phase 0 — close the live client defects (no dependencies)

The only phase that blocks nothing and is blocked by nothing.

- **F-C1 — the Local File KDF.** `src/lib/backupCrypto.ts` (PBKDF2-SHA-256 600k
  → AES-256-GCM, a versioned header, an anti-downgrade floor on the iteration
  count) is wired into the export screens — `Account_Backup.vue` and
  `Modal_Account_Backup_Local.vue` — and into `Modal_Account_Restore_Local.vue`.
  Only the new format is written: old files are test data (invariant §1a), so
  there is no legacy read path.
- **F-H3 — keys in `localStorage`.** Profiles that opened the teststand hold
  `testbed.guardians` and `testbed.backups` in the clear — guardian EOA and
  spending keys, an owner key and a master secret — and nothing in the app
  clears localStorage. The store reaps both on boot, which is where it has to
  be: most profiles never sign out. The reaper goes once a build carrying it has
  shipped.
- **F-H2, and the decision that manual Shamir is scaffolding — retire the sandbox surfaces.** The teststand has
  no place in the tree: with the design settled it has nothing left to
  demonstrate. The manual Shamir modals stay behind the dev flag until the
  community scheme lands, since they are still the only share-restore path.
  Local File stays a real feature but moves out of the primary path so it does
  not read as the recommended backup.
- **F-H1 dissolves with them.** The finding is about raw key fragments handed
  around by copy-paste; once the manual path is dev-only and the payload is a
  wrap key (Phase 1), there is nothing left to envelope.

Acceptance: a file exported by the new code cannot be opened by a password
guess that would have worked before (a probe, not an argument); no teststand key
material survives a boot, in `localStorage` or anywhere else — not a logout,
since `logout()` is also the first half of signing in and must not wipe;
manual Shamir is unreachable in a production build.

## Phase 1 — the payload and where the vault lives

The foundation the two planes split. Nothing below works without it.

- `S` is 32 random bytes, the wrap key. The vault is encrypted under it with
  AES-256-GCM.
- The ciphertext goes to `user_storage`, addressed by
  `uuid = uuidv8(HKDF(S, "buckitup/vault-locator/v1", "locator", 16))` — the
  same derivation shape the root slot address already uses. Reads are public
  and unauthenticated, so a recovering client with no account can fetch it;
  writes stay owner-signed and happen while the account is alive.
- Recovery order: gather shares → reconstruct `S` → compute the locator → fetch
  → decrypt.

Acceptance: a client holding only `S` and no account recovers the vault against
staging; the server sees nothing that distinguishes a vault row from any other
`user_storage` row.

## Phase 2 — the social plane over the chat

Guardians are confirmed contacts, and their shares travel through the dialogs
that already exist. This is what makes the friends' half post-quantum for free:
every dialog message is wrapped with ML-KEM-1024.

- **Spec (chat repo):** a new content type in the `07_content_polymorphism`
  registry — a new JSON key, per the invariant that governs envelope evolution.
  It carries the share, the scheme parameters, and the owner's locator hint.
- **Client:** issue shares to selected contacts as messages; the guardian's
  client recognises the type, stores the share, and confirms receipt; the owner
  sees who holds what.
- **Spares:** generate shares with a reserve at backup time and keep the
  unissued ones in the account, so the circle can grow later without a reshare.

Acceptance: two accounts on staging — one issues shares, the other receives and
confirms; a third contact added later gets a spare with no reshare.

## Phase 3 — the node plane, hardened

Both criticals and all three highs live here, and the repository is pushable
again.

- **N-C1** — distinguish "the secret is not on-chain" from "the RPC failed";
  refuse with 503 on transport errors instead of falling through to the
  unauthenticated branch.
- **N-C2 / N-H1** — the deposit signature covers `hash(share)`, a nonce and the
  node id, and is required always, including before `addSecret` is mined.
- **N-H2** — refuse deposits while `recoveryActive`, so a share cannot be
  mangled mid-round.
- **N-H3** — release moves to POST with a single-use nonce, rejects future
  timestamps, and binds the node id; the window returns to the documented 300 s.

Acceptance: the audit's probes are re-run against the fixed node and fail to
reproduce; a replayed deposit and a replayed release are both rejected.

## Phase 4 — relayer, gas and notifications

- **R-H1** — rate limits, per-caller quotas and a gas cap on the relay
  endpoints.
- **R-H2** — an idempotency key per payload and dedup between preflight and
  send, so N parallel copies cost one transaction rather than N−1 reverts.
- Bounded field sizes, so the caller cannot choose the cost of a transaction.
- **The `/notifications?wallet=` leak** — it hands the owner's Telegram chat id
  to anyone who asks. Close it, and require proof of wallet ownership before a
  subscription is created.
- **Paying your own gas.** A client path that signs and submits directly, with
  the relayer as the default convenience. The relayer endpoint becomes
  configuration, not a constant: a node owner can run one for their users.
- **Notification channels.** Email, SMS and messengers as subscriptions the
  owner composes; the notification server is pluggable the same way the relayer
  is. This is the veto path — without a channel that reaches the owner, the
  timelock decorates nothing.

Acceptance: the gas-drain probe from the audit no longer drains; a second
relayer configured by hand serves a full round; a notification arrives on a
foreign round within the timelock.

## Phase 5 — one stealth implementation, in the SDK

- **S-H1** — pick the spending/viewing canon and import the SDK's
  implementation, which Phase 0 leaves as the only one in the tree.
- **F-H4** dissolves here: the broken add-versus-multiply derivation goes away
  with the file that holds it.
- `hexToBytes` rejects garbage instead of turning it into zeros; `threshold = 1`
  is refused; `recoverSecret` verifies integrity so one malicious node cannot
  hand back a silently wrong `K`.

Acceptance: a golden vector from production round-trips through the SDK; a
corrupted share is detected rather than absorbed.

## Phase 6 — contracts v2 (deployment)

Deployment-bound, and the last thing that changes. Existing secrets are test
data, so this is a fresh deployment rather than a migration.

- **K-H1** — bind `version` into `Reshare` and `round` into `CancelRecovery`,
  add public nonce invalidation, cap deadlines. Without it a withheld signature
  reinstates an evicted guardian.
- **SI-4** — an owner reshare implicitly resets the round, so one compromised
  guardian cannot pin `recoveryActive` and block their own eviction.
- **SI-2 + the restart rule** — `canDecrypt` gains a window, and when the window
  closes the round resets by itself. That is also what makes "mint a new
  ephemeral key and run it again" work after a lost recipient key.
- `revokeSecret` mid-round emits `RecoveryCancelled`, so the indexer stops
  drifting.

Acceptance: the audit's contract probes (rollback, pinning, ten-year
`canDecrypt`, the wedge) all fail to reproduce against v2.

## Phase 7 — the product surface

- **Parameters** — a simple screen with defaults and an advanced one exposing counts,
  thresholds and the timelock.
- **Share lifecycle**: notify the owner when a guardian starts a recovery
  of their own, since the share they hold becomes questionable.
- **Device-link** ships before recovery: logging in on a second device is
  the more basic need, and both live behind the same "I can't get in" door.

## Sequencing

Phase 0 runs now. Phases 1 and 3 are independent of each other and can run in
parallel. Phase 2 waits on the spec change landing in the chat repo. Phase 4
depends on nothing but is worth doing after 3, since both touch the same
deployment. Phase 5 gates Phase 6, because the contract's address derivation has
to agree with the canon. Phase 7 follows the device-link work.

## What is not in scope

- Post-quantum share transport on the node plane: that plane follows Ethereum's
  key format and migrates when Ethereum does. The social plane is already
  ML-KEM-1024.
- An offline recovery: the on-chain oracle is what makes a request objective, so
  a node serving a recovery needs the internet. It still carries chat and files
  offline.

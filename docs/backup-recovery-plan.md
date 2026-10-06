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

- **Spec (chat repo):** `pq_recovery_shares` owns the wire contract and the
  lifecycle, and registers `recovery_share`, `recovery_share_return` and
  `recovery_binding` in `07_content_polymorphism` — new JSON keys, per the
  invariant that governs envelope evolution.
- **Client primitives:** the friends' half split with a commitment per split,
  so a share from another split or an edited one is caught before it is
  combined (`src/lib/recovery/shareSplit.ts`); the `recovery_share` codec;
  contacts confirmed only through a verified QR handshake. The flows built on
  them — issuing, keeping, spares, the owner's view — are Phase 7 (7.2–7.4).

Acceptance: the split is pinned by golden vectors; a share from another split,
or with one byte changed, fails its check; a contact becomes confirmed only
through the handshake.

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

Phases 1–6 built the primitives and the services, and none of them reaches a
user: the Backup page shows "Blockchain Recovery — Coming Soon", and nothing in
the client talks to the contract, the relayer or the nodes. This phase is that
wiring, as screens. Device-link, which the decisions put first, is live: the
login page's "Sync with other device".

What it builds on:

- **In the tree:** the sealed vault and its locator (`src/lib/recovery/vault.ts`),
  the two halves (`vaultEnvelope.splitIntoHalves`), the split and its checks
  (`src/lib/recovery/shareSplit.ts`), the `recovery_share` codec
  (`src/lib/pq/content.ts`), confirmed contacts, and the account's `evm_skey` in
  the vault.
- **Deployed:** contracts v2 on Sepolia, the relayer with its indexer and
  notifications, and the v2 nodes (overview §5).
- **The wire contract:** the chat repo's `pq_recovery_shares` and the
  `recovery_*` types in `07_content_polymorphism`.
- **References:** `backitup-recovery-demo/src/lib/flows.ts` runs every on-chain
  step but changing the policy and invalidating nonces, both through the
  relayer and paying its own gas. The backend's `docs/INTEGRATION.md` documents
  the relayer, the indexer and notifications; where it puts ECIES shares on
  chain and reads meta-addresses from the registry, `pq_recovery_shares` and
  7.1 replace it. The node API is the `backitup-node` README (`POST
  /shares/:id/release`), its signed messages the SDK's
  `src/constants/messages.ts`.

The slices, in build order:

### 7.0 Plumbing, no screen

- `backitup-secret-recovery-sdk`, the stealth canon of Phase 5, comes in.
  `buckitup-sdk-0.0.24.tgz` goes, and with it Account activation and the older
  registry it writes to: nothing opens that modal, and Phase 7 reads no
  registry, since the meta-address travels in the dialog (7.1).
- The Sepolia entry of `bcConfig.json` carries the v2 addresses and start
  blocks. The relayer, the notification servers and the node list are
  configuration with ours as the default, since the design assumes many of
  each.
- `src/lib/recovery/` gains chain reads (`getSecret`, `roundState`,
  `getGuardiansAt`, `getShareAt`, `hasApproved`, the round events), a gateway
  that submits through the relayer or directly, and the node client.
- `src/lib/pq/content.ts` gains the `recovery_invite`,
  `recovery_invite_reply`, `recovery_binding` and `recovery_share_return`
  codecs; the meta keys of § Inviting and the ten-word code of § Returning come
  with them. All of it is pinned by golden vectors.

Acceptance: a dev build creates a secret on Sepolia through each gateway, and
every configured node accepts a deposit for it.

### 7.1 Becoming a guardian

A guardian signs approvals with stealth keys derived from a meta seed in their
vault (`src/lib/recovery/guardianInvite.ts`), and the owner needs the guardian's meta-address to address a slot to them. A
card carries no EVM address, and adding one would publish the very link between
a chat identity and a chain address that stealth addresses exist to break. So
the meta-address travels in the dialog, as `pq_recovery_shares` § Inviting
specifies: the owner sends a `recovery_invite`, the guardian's client says
plainly what is asked and by whom, and a `recovery_invite_reply` accepts with
the meta-address inside the ML-DSA-signed row, or declines. Consent comes
before custody, and the meta keys come from the vault alone — not the
account's EVM key — so the guardian's own recovery keeps them.

Acceptance: an invitation accepted on one staging account yields, on the
other, a meta-address from which the owner derives a stealth address the
guardian's keys control. The guardian's meta-address is the same on a linked
device and after the guardian restores their account; an acceptance that
replays another guardian's meta-address is refused.

### 7.2 Creating a backup

**Simple screen:** pick at least three guardians among the contacts who
accepted; everything else has a default:

| Parameter | Default |
|---|---|
| Shares needed (Shamir threshold) | a majority of the guardians, at least 2 |
| Approvals needed (contract quorum) | equal to the threshold |
| Spares | 2 |
| Nodes | our configured set, a majority needed |
| Timelock / window | the contract's defaults: 3 days / 7 days |
| Gas | our relayer |

**Advanced screen:** every row above, within the contract's bounds (timelock
10 min – 365 d, window 1 h – 30 d), plus a relayer of the user's choice or
paying their own gas with the address's balance shown.

- It allows two guardians, saying that losing either loses the backup.
- It refuses a quorum below the threshold: past quorum further approvals
  revert, so an honest recovery could not gather enough shares.
- The contract takes up to 50 guardians; the relayer takes up to 32 shares
  and a call under its gas cap, so a larger set pays its own gas. The run
  estimates gas before it publishes anything.
- A node set other than ours travels with every share, since a recovering
  device has no other way to learn which nodes hold the node half.

The run follows `pq_recovery_shares` § Issuing: split S into halves and the
friends' half into shares with the spares, seal the vault with the split inside
and publish it, register the secret with delivery records in the slots, deposit
the node shares, send one `recovery_share` per guardian, write the roster. Each
step is resumable after a crash or a closed tab, and the persisted split is
where a resume starts — a client that registers and then loses the split can
only reshare.

The screen does not finish without an alert channel (7.4). Skipping one is an
explicit choice, and the roster keeps showing it as a warning.

Acceptance, checked once 7.3 is in: on staging and Sepolia, an owner backs up
to three guardians; the chain shows the delivery records, every node holds its
share, and every guardian's client holds theirs.

### 7.3 Keeping a share

The guardian's side of § Holding and § Dying: validate, check against the
on-chain root, copy into the guardian's own `user_storage`, tell the owner
the share is stored, and list it under "Shares I keep" against the dialog
peer's name — the chain answers with an address, so the holding stays the
peer's claim. A share that does not verify, or names a deployment this build
cannot reach, is kept and reported to the owner. A share can be given back,
which the owner sees as a prompt to reshare.

The client watches the contract. After a reshare it drops the superseded share
once the replacement arrives, or once its viewing key finds no slot of the new
version addressed to it — the case of a dropped guardian, who will never get a
replacement and cannot read the owner's roster. A revoked secret drops at once.

Acceptance: a share edited in transit is reported, not combined; a secret
revoked on chain leaves its guardians holding nothing; the owner's client
receives a *stored* receipt from each guardian.

### 7.4 The owner's roster, alerts and veto

- **Roster:** who holds a share, at what version, whether receipt is confirmed,
  and confirmed holders against the threshold — the one number that answers "is
  my backup real". Spares left, holdings gone stale after a reshare, shares
  given back. It lives in a `user_storage` slot reached through the root map,
  so a second device sees the same picture.
- **Controls:** add or drop a guardian (a reshare), change the timelock and
  window, hand a spare to an existing guardian, revoke for good.
- **Alerts in the app:** on every start and while open, the client reads the
  rounds on the owner's secrets. A round shows as a banner over every screen,
  with the timelock's deadline and a one-tap veto (`cancelRecovery`).
- **Alerts outside the app:** subscriptions on the notification servers the
  owner has configured, several at once. Ours serves Telegram — the app signs
  the bot's challenge with the owner key and shows the reply line to send — and
  webhooks, which are how email, SMS and other messengers attach. Listing and
  deleting subscriptions; the alert history.

Acceptance: a round a guardian starts on Sepolia reaches the owner both in the
app and on Telegram within the timelock, and the veto from the banner returns
it to `None`; a reshare from three guardians to two leaves the two holding the
new share and the dropped one holding nothing.

### 7.5 Recovery — the "I can't get in" door

The login page offers "Recover with friends" next to "Sync with other device".
Device-link stays first: a person with any working device is better served by
it.

- **The recovering device** creates a temporary account and shows its
  `user_hash` to pass to a guardian. When the guardian writes with `secret_ref`,
  it answers with a `recovery_binding` and shows the ten-word code. A progress
  screen follows the round — approvals, the timelock's countdown, the window,
  node releases from the node set the returned shares name, and each returned
  share as verified or set aside with its sender named. After an expired window
  it offers a restart with a fresh candidate key. At the threshold it combines,
  opens the vault, and lands in the original account.
- **The guardian** opens "Help someone recover", enters the `user_hash`, picks
  the holding, compares the ten words with the person on the call, opens the
  round if none is open, and approves naming the candidate it verified. The
  client sends the `recovery_share_return` by itself once the send gate opens.
- **Manual return** (§ Manual return): the guardian's app emits the sealed
  block, the recovering app imports nothing until the six digits match. The
  digits come from the derivation inside `src/lib/pq/deviceLink.ts`, factored
  out with the salt as a parameter rather than copied.
- **The finale is not optional:** back in the original account, the client
  runs a reshare and destroys the temporary account, keys and vault together.

Acceptance: a full recovery on staging and Sepolia with two of three
guardians, once through dialogs and once by manual return, ending in a reshare
and no temporary account left; a veto in the timelock stops a third.

### 7.6 Share lifecycle

A guardian's own recovery makes the share they hold questionable, and the chain
cannot reveal it without linking identities. Their client can: at the finale of
its own recovery it tells every owner whose share it holds, and each owner's
roster marks that holding and prompts a reshare. This relies on a cooperating
client; for a device in an attacker's hands, the owner's own timelock and
veto remain the defence.

Acceptance: a guardian who recovers their account appears as questionable in
the owner's roster without either of them doing anything else.

### Retired by this phase

The "Coming Soon" card, and with 7.5 the manual Shamir modals and
`src/lib/wrapKeyShares.ts`, which were scaffolding for it.

### Spec work in the chat repo

`pq_recovery_shares`, with § Inviting and its `recovery_*` types, is merged to
the chat repo's `main` before 7.1. What this phase adds to it lands before the
slice that names it:

- content types for a receipt that says *stored* (7.3), giving a share back
  (7.3) and a guardian's notice of their own recovery (7.6), each answering an
  open question of the spec;
- a field on `recovery_share` and `recovery_share_return` for a node set other
  than the default (7.2);
- § Dying: a dropped guardian learns it from the new version's slots rather
  than the owner's roster (7.3).

## Sequencing

Phases 0, 1 and 3–6 have landed in the repositories they own, and Phase 2's
primitives in this one; its spec waits on the chat repo. They ran in the order
their dependencies set: Phase 0 first, Phases 1 and 3 in parallel, Phase 4
after 3 since both touch the same deployment, Phase 5 before 6 because the
contract's address derivation has to agree with the canon. What they leave on
the client side — Phase 2's flows, Phase 4's own-gas path and alert channels,
Phase 5's SDK — is built in Phase 7.

Phase 7 builds its slices in order and waits on the chat repo for the content
types it adds. 7.2–7.4 reach a production build together: once a secret is on
chain and guardians hold its shares, any quorum can run a round through the
public relayer, with or without the screens of 7.5, so the alerts and veto of
7.4 have to be there first — without them the timelock decorates nothing.

## What is not in scope

- Post-quantum share transport on the node plane: that plane follows Ethereum's
  key format and migrates when Ethereum does. The social plane is already
  ML-KEM-1024.
- An offline recovery: the on-chain oracle is what makes a request objective, so
  a node serving a recovery needs the internet. It still carries chat and files
  offline.

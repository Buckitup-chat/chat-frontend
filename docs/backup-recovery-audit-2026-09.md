# Community Sharing Backup & Recovery stack audit — September 2026

Report of the "code review + security audit across every module" phase.
Method: six context-free auditors (one per axis); every non-trivial finding
proven by execution (hardhat/jest/vitest probes, locally-run node instances,
read-only probes of the live production). Base: the July snapshots of the
`Community-secret-sharing/*` repositories (verified to match the deployed
production via health/bytecode checks) and the current `chat-frontend`.
Every module's tests are green before and after (contracts 62, SDK 15,
client 517).

Severity shorthand: C/H/M/L = critical/high/medium/low.

## Severity summary

| Module | C | H | M | L/info |
|---|---|---|---|---|
| Contracts (security + correctness) | — | 1 | 4 | 8 |
| SDK | — | 1 | 3 | 4 |
| Relayer | — | 2 | 4 | 7 |
| Node | **2** | 3 | 3 | 3 |
| Client (backup/testbed) | **1** | 4 | 4 | 4 |

## Critical and high — full list

### Node (`backitup-node`)
- **N-C1. Deposit fails open on any RPC error** — `ownerOnChain` swallows
  every error as "the secret is not on-chain yet" → deposits accepted
  **without a signature**; DoS-ing the RPC opens a window to overwrite any
  share with garbage (confirmed by execution). Fix: distinguish
  `SecretDoesNotExist` from transport errors; on the latter refuse (503),
  never fall through to the unauthenticated branch.
- **N-C2. The deposit signature does not cover the share bytes** and carries
  no nonce and no node id → a captured owner request replays with an
  attacker-substituted body, against all three nodes. Fix: put
  hash(share) + nonce + nodeId into the signed message.
- **N-H1. The pre-chain window**: before AddSecret is mined, deposits need no
  signature, and the overwrite rule admits equal/higher versions → poisoning
  plus lockout of the legitimate v1 (409 "stale"). Fix: require the owner
  signature always.
- **N-H2. No overwrite lock during an active recovery** → "veto by
  corruption": the owner (or an N-C2 attacker) mangles their own share
  mid-round. Fix: reject deposits while `recoveryActive`.
- **N-H3. The release request**: a GET with the signature in the URL
  (logs/Referer), replayable for the whole window (default 3600 s where the
  docs say 300), and `Math.abs` accepts future timestamps. Fix:
  nonce/single-use, POST, reject `age < 0`, bind nodeId into the message.

### Client (`chat-frontend`, backup/testbed)
- **F-C1. Local File has no KDF**: the Blowfish key is a slice of the raw
  password bytes (for a 10-character password — its last **2 characters**),
  the IV is the first 8 characters in the clear, no salt, no MAC (proven by
  probe). Fix: PBKDF2-SHA-256 ≥600k (or Argon2id) → AES-256-GCM with a
  versioned file header.
- **F-H1. Shamir shares are raw fragments of the unencrypted key JSON**,
  dispensed via copy-paste → one machine's clipboard history collects all n
  shares and t-of-n collapses. Fix: an envelope (random AES-GCM key; only
  the key is split) + a share header (version/id/checksum) + file downloads.
- **F-H2. The teststand ships in production routes** with buttons that hit
  live Sepolia/relayer. Fix: behind a dev flag.
- **F-H3. Private keys and the payload sit in plaintext localStorage** with
  no cleanup (`testbed.guardians`, `testbed.backups`). Fix: do not store;
  wipe on logout.
- **F-H4. Broken stealth math in `buckitup.js`**: the private-key derivation
  uses addition while the address derivation multiplies → the addresses
  never match (proven), recovery through this path cannot work.

### Relayer (`backitup-recovery-backend`)
- **R-H1. No rate limits/quotas/gas caps** on 9 unauthenticated relay
  endpoints → the dispatcher's gas is drainable with throwaway EOAs.
- **R-H2. TOCTOU between preflight and send with no dedup** → N parallel
  copies of one payload: N−1 on-chain reverts at the dispatcher's expense;
  self-front-running.
- (M) Unbounded field sizes let the attacker choose the cost of each
  transaction; `/notifications?wallet=` hands out the **owner's Telegram
  chat id** to anyone (confirmed on production); bot subscription without
  proof of wallet ownership = recovery surveillance; the indexer has no
  reorg rewind.

### Contracts (Sepolia; require a v2 deployment)
- **K-H1. Stale `*WithSig` payloads as a "rollback"**: direct calls never
  consume nonces → a withheld/reverted reshare signature stays valid until
  its unbounded deadline and **reinstates an evicted, compromised guardian**
  (proven); in the KeyRegistry it rolls the meta-address back to a
  compromised one; the cancel signature is not round-bound. Fix: bind
  `version` into `Reshare` and `round` into `CancelRecovery`, add public
  nonce invalidation, cap deadlines.
- (M) **One compromised guardian can pin `recoveryActive` forever** and
  block its own eviction (the threat model's T4 defence is refuted by
  execution; SI-4 is mandatory, not an "improvement"). Fix: owner reshare
  implicitly resets the round.
- (M) **`canDecrypt` never expires** (still true ten simulated years later —
  T9/SI-2 confirmed).
- (M) Post-quorum liveness wedge: losing the elected recipient locks the
  social half forever (see the restart rule in the overview).
- (M) `revokeSecret` mid-round emits no `RecoveryCancelled` → the indexer
  projection drifts (fixable on the backend today).

### SDK (`backitup-secret-recovery-sdk`)
- **S-H1. The spending/viewing roles are swapped**: inside the SDK two swaps
  cancel out (the golden vector pins the swapped behaviour); the client
  testbed does the opposite → cross-implementation shares are silently
  unrecoverable. Pick the canon against production vectors; fixing only one
  of the two swaps orphans existing backups.
- (M) `hexToBytes`: NaN→0 — garbage hex turns into an all-zero "secret"
  (both halves equal); `threshold=1` is accepted (a single guardian owns the
  whole half); `recoverSecret` has no integrity — one malicious node → a
  silently wrong K.

### Cross-cutting observations
- **Three mutually incompatible stealth implementations** (SDK /
  buckitup.js / testbed): compressed- vs uncompressed-point address hashing,
  add vs multiply. Canon: one implementation in the SDK; clients import it.
- The testbed's network mode **does not implement** the RFC scheme: node
  shares come back in plaintext (no encryption to the ephemeral key), the
  XOR splits a random K, and the payload itself sits next to it in
  localStorage — the Vernam layer protects nothing.
- The RFC↔production↔testbed parameter drift is tabulated in section C of
  the client report.
- The contracts' threat model: T4/T6/T10 are stated incorrectly (refuted by
  execution); SI-2/SI-4 are reclassified from "improvements" to mandatory.

## Clean (the most important of the "checked and clean" lists)

- SDK crypto core: XOR (CSPRNG, lengths), Shamir, ECIES (MAC/IV),
  stealth-CDH, **injective** secret-id derivation (standard ABI).
- Contracts: EIP-712 hashing (including struct arrays), quorum accounting,
  timelock boundaries, access control on every external function, no
  reentrancy; the KeyRegistry is clean.
- Relayer: authorization as such is contract-borne (signature + nonce +
  deadline verified over the same bytes); the dispatcher key does not leak.
- Node: the release gate fails closed on `canDecrypt`; shares are not
  written to logs.
- Client: RNG near key material is CSPRNG-only; no console.log of keys.

## Treatment order

1. **Client (pushable now)**: F-C1 KDF, F-H1 share envelope, F-H2 dev gate
   for the teststand, F-H3 localStorage wipe, F-H4 stealth fix,
   importVaultKeys/share validation, duplicate consolidation, dead code.
2. **Node + relayer (code prepared locally, pushed once repo access is
   restored)**: N-C1/C2, N-H1..H3; R-H1/H2 + MaxLength + notifications
   privacy. The deposit/release message format change drags the SDK and the
   harness along — one coordinated package.
3. **Contracts v2 (deployment)**: K-H1 (version/round bindings, nonce
   invalidation, deadline cap), SI-4 (reshare resets the round / cooldown),
   SI-2 (a `canDecrypt` window), an event on revoke-mid-round.
   Threshold/timelock — per the Q3 decision.
4. **SDK**: the stealth-role canon (after checking production vectors),
   hex/threshold validation, recoverSecret integrity, exported EIP-712
   types.

The full texts of the six reports with probe code live in the audit
transcripts; this document is the consolidation for tracking.

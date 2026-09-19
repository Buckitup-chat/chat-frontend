# Community Sharing Backup & Recovery — algorithm overview and open questions

Status: **awaiting approval**. This document is a human-readable description of
the whole account backup and recovery scheme, with the list of contested points
that need a product decision before the final implementation. Technical base:
the RFC `docs/restoration.livemd`, the `Community-secret-sharing/*` contracts
and services, and the client flows in `src/views/backup/`.

---

## 1. What we protect

A BuckitUp account is a bundle of secret keys in a local passkey-locked vault:
signing (ML-DSA-87), encryption (ML-KEM-1024), and an EVM key. Lose the device
or the passkey and the account is gone: by construction the server does not
know the keys and cannot restore them.

A backup must survive losing every device at once — while no single custodian
of it may gain power over the account.

## 2. The idea: two planes of trust

The secret S is split into two "master shares" with a one-time pad (XOR):

```
MasterA = pure random noise      → infrastructure (federated nodes)
MasterB = S ⊕ MasterA            → social circle (friend guardians)
```

Each master share on its own is mathematically pure noise: neither all the
nodes together nor all the friends together learn anything about the secret.
Recovery requires the consent of both planes.

Inside each plane the master share is further split with Shamir:

- **Nodes**: k-of-n (3-of-5 in the RFC) to survive partial federation
  failure; shares are released only after a **timelock** — the window in
  which the real owner can notice an attack and veto it.
- **Friends**: k-of-n (2-of-3 in the RFC), responding instantly — they are
  live people who can verify by voice that it is really their friend
  recovering.

Properties: stealing a friend's phone yields nothing (a quorum of both planes
is required); a compromised node — nothing; even the whole federation
colluding — nothing without the friends, and vice versa.

## 3. Coordination: why a blockchain is here

Someone has to answer neutrally: has a recovery started, by whom, when does
the timelock expire, is the quorum reached, has a veto been cast. In the
current implementation that is a smart contract (Sepolia):

- the owner registers the secret and the guardian circle (by stealth
  addresses — the guardians themselves are not exposed in the registry);
- recovery = a round: initiation → guardian approval signatures (EIP-712) →
  quorum → timelock → the contract records "the recipient is entitled"
  (`canDecrypt`);
- nodes consult `canDecrypt` before releasing their share — the contract is
  the gate of the infrastructure plane;
- the owner can **veto** and cancel a foreign round;
- gas is paid by the **relayer** — a dispatcher service; users sign payloads
  but need no wallets and no ether.

## 4. Recovery through the user's eyes

1. A new device creates an **ephemeral user** — a temporary anonymous
   identity with one-time keys.
2. It initiates a round; friends receive the request, verify (in person, by
   voice) and sign approvals; the quorum is reached.
3. The timelock runs — the real owner's veto window.
4. After it expires: nodes and friends each encrypt their share to the
   ephemeral user's public key and hand it over. Intercepting the traffic is
   useless.
5. The client combines Shamir in both planes, XORs — obtains S, unwraps the
   vault, creates a new passkey. The ephemeral keys are destroyed (forward
   secrecy: even a later device compromise does not expose the recovery
   traffic).
6. The recommended finale: **reshare** — old shares are invalidated and the
   circle is reissued (see question Q8).

## 5. What already exists (September 2026)

| Component | Where | State |
|---|---|---|
| Architecture RFC | `docs/restoration.livemd` | adopted as the basis of this work |
| Contracts (SecretRecovery + KeyRegistry) | Sepolia, deployed | 62/62 tests; live since July |
| SDK (split/ECIES/stealth/EIP-712) | `backitup-secret-recovery-sdk` | 15/15 tests |
| Relayer | Railway, live | no tests |
| Nodes ×3 | Railway, live | no tests |
| E2E of the whole chain | `/workspace/harness` | 10/10 scenarios, 7 full recoveries (July) |
| Client: Local File + manual Shamir | `src/views/backup` | works; declared sufficient for its purpose |
| Client: network-mode teststand | `Page_Backup_ShamirTestbed` | prototype against the live stack |
| Threat model + hardening RFC SI-1…SI-6 | `backitup-smart-contracts/docs/security` | written, not implemented |
| Audit of every module | `docs/backup-recovery-audit-2026-09.md` | done: 3 critical, 11 high; crypto cores clean |

## 6. Contested points and product questions — FOR APPROVAL

**Q1. What exactly is backed up (the "Compact Secret").**
Today the prototypes split the JSON of the whole vault (the ML-DSA key alone
is 4896 bytes); the RFC explicitly requires a compact payload, otherwise the
shares bloat P2P traffic. Proposal: S = a 32-byte wrap key; the vault itself
is encrypted under it and can live anywhere (e.g. in `user_storage` on the
server — it is E2E-encrypted anyway). Decide: adopt the wrap key as canon?

**Q2. Who the "friends" are in the product.**
The natural answer: chat contacts, with the E2E dialogs themselves as the
share-delivery channel (a share as a special message type, with the guardian
confirming receipt). The prototype today is manual copy-paste. Decide:
contacts + chat channel as canon? Can a guardian be outside BuckitUp
(QR/file)?

**Q3. Scheme parameters.**
RFC: nodes 3-of-5 and a 48 h timelock; the live contract: a 10-minute
timelock minimum; the production federation: 3 nodes with threshold 2.
Decide the targets: node count/threshold, friend count/threshold (defaults
and user-adjustable bounds), timelock length (48 h?), and whether the on-chain
minimum must be raised to the product value.

**Q4. Is the blockchain mandatory.**
Pros: a neutral arbiter of quorum/timelock/veto, already working. Cons: an
external dependency (after Sepolia comes mainnet/L2 — a fee for every backup
and recovery), public round metadata on-chain, and a philosophical conflict
with the offline-Pi scenario of the messenger. Alternative: a quorum gate
inside the node federation (no chain), at the price of trusting the
federation. Decide: stay on-chain (which chain?), or move the gate into the
federation.

**Q5. The relayer is a central point.**
It pays gas, sees every request, and its outage means backup/recovery is
unavailable. Decide: who hosts it in production, whether a single relayer is
acceptable at launch, whether a "pay gas yourself" fallback is needed.

**Q6. The veto channel.**
A veto works only if the owner LEARNS about a foreign round within the
timelock. Decide the notification channel (push to all owner devices? email?
a message to self in the chat?) — without it the timelock is decorative.

**Q7. Post-quantum share transport.**
Shares are encrypted with ECIES/secp256k1 (not PQ); the ephemeral user is
secp256k1. The "acceptable" argument: a share is useful to an attacker only
until recovery + reshare, a short window. The "not acceptable" argument: the
whole chat is PQ and the backup is the most valuable thing in it. Decide:
migrate share transport to ML-KEM in the final version, or consciously keep
classical crypto with a threat-model entry.

**Q8. Share lifecycle.**
Changing the friend circle, a lost guardian, share "staleness", a mandatory
reshare after every recovery, reminders for the owner to check the circle's
liveness. Decide the policy (how often, what is automatic, what is manual).

**Q9. Relation to linking a second device (device-link, variant B).**
These are different operations (recovery = everything is lost; device-link =
a live device exists), but the user has a single entry point: "I can't get
in". Decide: a single UX wizard that branches into device-link/recovery, and
the implementation order.

**Q10. The fate of manual Shamir and Local File.**
Do they remain an "expert" fallback next to the network scheme, or get hidden
once it launches? (Manual-path shares today carry raw keys without an
envelope; adopting Q1 moves both paths onto the wrap key.)

**Q11. Post-quorum behaviour when the recipient is lost.**
The audit showed: after quorum the only exit from a round belongs to the
owner — if the elected recipient's key is lost, the social half is locked
forever (the owner has already lost their keys — that is the very recovery
scenario). Decide: give guardians the right to reopen a round (keeping the
timelock), or accept the wedge as the price of strictness.

## 7. Next

1. The all-module audit report + automatic treatment of confirmed bugs
   (separate document).
2. Decisions on Q1–Q11 (this document; after approval the answers are edited
   in place).
3. The final implementation plan, phased.
4. A branch with the full functionality and tests.

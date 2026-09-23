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

## 6. Decisions and what is still open

### Decided

**The payload is a 32-byte wrap key.** Shamir never touches bulk data — the
RFC's whole point, since an ML-DSA key alone is 4896 bytes and splitting it
bloats P2P traffic. The vault is encrypted under the wrap key, and only that
key is split. There is no password anywhere in the scheme: the secret is full
entropy rather than something an attacker can guess.

**A guardian is a user from the confirmed contact list**, and the delivery
channel is the E2E dialog itself — a share travels as a message type. Nothing
exotic for now: no guardians outside BuckitUp, no QR or file hand-off. This
also settles the post-quantum question for the social plane, since every
dialog message is already wrapped with ML-KEM-1024.

**Every parameter is customisable within reason.** A simple screen with
defaults, and an advanced one exposing counts, thresholds and the timelock.
The circle of helpers can grow *after* the backup exists: shares are generated
with a reserve and the spares are kept in the account for exactly that.

**The chain stays.** What it buys is not storage but an objective, observable
record of who asked for recovery and who approved or refused — and the ability
to block a backup or revoke a helper reliably. Eventual consistency does not
give that.

**Gas: a "pay it yourself" fallback is required**, with the relayer as the
convenience path rather than a dependency. A relayer can be anyone — ours by
default, plus alternatives run by users and organisations; a node owner
offering gas to their trusted users is a natural case. The design must assume
many relayers, not one.

**Notifications are a subscription, not a channel.** Email, SMS, messengers —
the owner subscribes to whichever they want. The notification server follows
the relayer's shape: run your own, use ours, or attach several at once.
Without a channel that actually reaches the owner the timelock is decorative,
so this is part of the veto path, not a nicety.

**The vault ciphertext lives in `user_storage`, addressed by the secret.**
That table is public-read and authenticated-write (pq_user_storage §FR-3), so a
client with no account can fetch a row; writing happens while the account is
alive, so the asymmetry costs nothing. What a keyless client cannot do is
*name* a row — the key is `(user_hash, uuid)` and `user_hash` derives from the
signing key that was lost — so the locator comes from the secret instead:
`uuid = SHA3-512(S ‖ "vault-locator")[0..16]`. Gather shares, reconstruct S,
compute the locator, fetch by uuid alone, decrypt with the same S. No account
appears anywhere in the chain, and the server can tell neither which row is a
vault nor which accounts hold a backup. Durability is not this scheme's
problem: account data is replicated across servers and swept into server-side
backups like everything else on the platform.

**A stuck recovery is restarted, not rescued.** If the ephemeral key is lost,
the user mints a new one and runs the round again — no new authority, no
guardian-held cancel button. Before quorum this already works: a guardian can
move their vote to the new candidate. After quorum the deployed contract
forbids it, so v2 gives a round a lifetime: `canDecrypt` gains the window the
audit already requires (SI-2), and when the window closes the round resets by
itself. One change buys both the missing window and the restart.

**Share lifecycle is a second-phase feature.** The case that matters: a
helper who starts a recovery of their own — with us or elsewhere — makes the
share they hold questionable, and the owner is told so.

**Device-link ships before recovery.** Logging in on a second device is the
more basic operation and the more common need; recovery is the harder path
behind the same "I can't get in" door.

**Manual Shamir is a sandbox, not a feature** — scaffolding for the community
scheme, and it goes when the scheme lands. Local File stays but is tucked away
where it will not tempt anyone into using it as their backup.

**The node plane follows Ethereum, and recovery needs the internet.** The
policy oracle stays on-chain: it is what makes a recovery request, an approval
and a refusal objective, and the node reads it rather than holding policy of
its own. Share transport there keeps the elliptic crypto the chain is keyed by;
if Ethereum itself goes post-quantum, we migrate with it. The social plane is
already ML-KEM-1024 through the chat, so the exposure is bounded to the node
half. A node serving a recovery therefore needs a working internet connection —
a normal precondition of the operation, not a defect: an offline node still
carries chat and files, it simply cannot run a recovery round.

When that custodian moves to our own Elixir nodes, the transport can go
post-quantum cheaply without touching the chain: the node already demands a
fresh signature from the recipient, so the recipient's ML-KEM key rides along in
that signed message and needs no registry.

## 7. Next

1. The all-module audit report + automatic treatment of confirmed bugs
   (separate document).
2. The three open points above.
3. The final implementation plan, phased.
4. A branch with the full functionality and tests.

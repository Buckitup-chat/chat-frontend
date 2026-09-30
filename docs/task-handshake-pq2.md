# Task: optical handshake v2 (`PQ2`)

The QR handshake that confirms a contact in person. This document is the
specification to implement; it replaces the `PQ1` protocol in
`src/components/engines/QRScannerEngine.vue` outright — no compatibility
between the two is owed (CLAUDE.md, "no backward compatibility"). The
handshake is also the trust root for community backup (a recovery share goes
to a confirmed contact only, `docs/backup-recovery-overview.md`) and for the
backend's access gating (an optical-handshake contact is a vouch at chain
distance 1, `chat/docs/pq/reqs/pq_access_gating.in_progress.md`), so what
"confirmed" means is decided here.

## 1. What changes, and why

| `PQ1` today | `PQ2` | Why |
|---|---|---|
| Two ECDSA signatures per side, over the counterpart's bare nonce and over `own user_hash ‖ nonce`, with no protocol label | One ECDSA signature per side over a **transcript** of the whole session under a protocol label | A signature over a bare value the counterpart chose is a signing oracle for the contact key; a transcript signature is valid for this session and this protocol only, and cannot be mixed between two handshakes running in one room |
| The optical proof is secp256k1 only | After the optical step, each side sends an **ML-DSA-87 signature over the transcript** through the data channel; `confirmed` needs it | A recording adversary with a quantum computer recovers the secp256k1 key from the scanned public key and passes the classical handshake as the victim; the identity is post-quantum and its confirmation has to be too |
| The data channel opens only when a card is missing; the card received on it is pushed into `allNetworkUsers` unverified | The channel opens on every handshake and carries the card and the post-quantum signature; the card is verified (`verifyUserCard`) and never enters the store from here | An unverified card under a chosen `user_hash` was accepted as that user's; the channel is now what makes the confirmation post-quantum, so it is not optional |
| STUN servers of a third party, hard-coded | No ICE servers by default (same network, or a hotspot); a configured list is a second attempt | The handshake promises to work offline and without a third party; a STUN query is neither |
| No session bound | A session lives 90 s from the nonce being shown; every code names the session | Bounds replay and relay |
| Nothing for the users to compare | A six-digit code from the transcript, shown next to "Add contact" | Two people can see they completed the same session, not two sessions bridged by a hidden device |
| `src/libs/QRHandshakeManager.js` (unused) | Deleted | Dead code with its own copy of the protocol |

Unchanged: face to face, front cameras, each device shows its code under its
own camera and scans the other's; either device may scan first; the person
taps "Add contact" (or "Contact confirmed") at the end.

## 2. Keys

An account has (`src/libs/EncryptionManagerPQ.js`, `createUserVault`):

| Key | Algorithm | On the card | Role here |
|---|---|---|---|
| `sign_skey` / `sign_pkey` | ML-DSA-87 (pk 2,592 B, sig 4,627 B) | `sign_pkey`, `sign_b64` (self-signature) | The identity; `user_hash = 'u_' + hex(SHA3-512(sign_pkey))` |
| `contact_skey` / `contact_pkey` | secp256k1, compressed (33 B) | `contact_pkey`, `contact_cert = ML-DSA-87.sign(contact_pkey, sign_skey)` | What the QR carries and what signs the optical transcript |
| `crypt_skey` / `crypt_pkey` | ML-KEM-1024 | `crypt_pkey`, `crypt_cert` | Not used by the handshake |

The QR carries `contact_pkey` because neither the ML-DSA key nor its
signature fits one code (2,953 bytes at most; sizes above). The certificate is what ties the small key to the identity:
**a contact is confirmed only when the key proved optically is the one the
identity's verified card certifies** (`cardVouchesForContactKey`,
`src/lib/pq/verifyCard.ts`) — without that, anyone can show a friend's
`user_hash` with their own key.

## 3. Messages

Text in QR byte mode. Fields are separated by `:`; binary fields are
base64url without padding (`toBase64Url`, `src/lib/pq/signature.ts`), which
contains no `:`. `user_hash` travels as is (`u_` + 128 hex). A reader ignores
any code that does not start with `PQ2:`, and any message whose fixed-length
fields do not decode to their length.

```
A  PQ2:A:<user_hash>:<contact_pkey>:<nonce>
B  PQ2:B:<user_hash>:<contact_pkey>:<nonce>:<sig>
C  PQ2:C:<sig>:<qwbp>
D  PQ2:D:<qwbp>
```

| Field | Bytes | Meaning |
|---|---|---|
| `user_hash` | 130 chars | The sender's identity |
| `contact_pkey` | 33 | The sender's handshake key, compressed secp256k1 |
| `nonce` | 16 | Fresh random per session (`randomBytes(16)`) |
| `sig` | 64 | ECDSA over the transcript, §4, compact `r‖s` |
| `qwbp` | 55–100 | The sender's QWBP bootstrap payload (`QWBPConnection.getQRPayload()`), which carries its DTLS certificate fingerprint |

Sizes: A ≈ 205 bytes, B ≈ 292, C ≈ 230, D ≈ 140 — QR versions 7–11 at
error-correction level L, as today.

## 4. Transcript and signatures

Both sides compute the same transcript. The two parties are ordered by their
`user_hash` strings (byte-wise, they are hex): `lo` and `hi`. The two are
never equal: a code carrying the reader's own `user_hash` (its own screen in
a reflection, or a second device of the same account) is ignored at every
step.

```
T = "buckitup/handshake/v2\n"
    || hash_lo (130 B, UTF-8) || pk_lo (33 B) || nonce_lo (16 B)
    || hash_hi (130 B, UTF-8) || pk_hi (33 B) || nonce_hi (16 B)
```

Every field is fixed-length, so the encoding is unambiguous; a parser still
checks each length before hashing (a field that is short lets bytes move
between fields).

- **Optical signature** (in B and C): `sig = ECDSA_secp256k1(SHA-256(T))` under
  `contact_skey` — `EncryptionManagerPQ.signContactChallenge(T)` as it stands.
  Verified under the counterpart's `contact_pkey` from its A or B.
- **Post-quantum signature** (over the channel, §5):
  `sigPQ = ML-DSA-87.sign(M, sign_skey)`, with
  `M = "buckitup/handshake/v2/pq\n" || T || fp_lo (32 B) || fp_hi (32 B)`,
  where `fp` is each side's DTLS certificate fingerprint — the 32-byte
  fingerprint in its QWBP payload (`decode(payload).fingerprint`). Verified under `sign_pkey` of
  the counterpart's verified card.
- **Short authentication string**:
  `sas = u32be(hkdfDerive(T || fp_lo || fp_hi, "buckitup/handshake/v2", "sas", 4)) mod 10^6`,
  six digits, zero-padded, with `hkdfDerive` from `src/lib/pq/hkdf.ts` (the
  derivation device-link uses). It covers the fingerprints on purpose: `T`
  holds only values shown in plain codes, and the `qwbp` fields are not under
  the optical signatures, so a relay that swaps the bootstrap payloads would
  leave a `T`-only code equal on both screens. With the fingerprints in it,
  the two screens differ whenever the channel does not join the two phones.

## 5. Sequence

Each device runs the same state machine. "Show" means render as the QR under
the camera; "read" means the camera decoded a code. A device's own data is
`(hash_me, pk_me, nonce_me)`; the counterpart's, once seen, is bound for the
rest of the session: a later code naming a different `user_hash` or
`contact_pkey` is ignored.

1. **Start.** Generate `nonce_me`; show **A**; start the 90 s session timer.
2. **Read A** (state 1 only): bind the counterpart; compute `T`, sign it; show
   **B**.
3. **Read B** (states 1–2): bind the counterpart if not bound (both scanned
   each other's A at once, and both are showing B — the symmetric race);
   compute `T`; verify `sig` under the counterpart's `contact_pkey`. If it
   fails, log and stay. Otherwise sign `T`, create the QWBP connection with
   **no ICE servers**, take its payload, show **C**; mark *optically verified*.
4. **Read C** in state 2 (this device showed B): verify `sig` as in 3;
   mark *optically verified*; create the QWBP connection, feed it the
   counterpart's payload, take own payload, show **D**.
   **Read C** in state 3 (this device showed C too — both read B at once, the
   symmetric race): verify `sig` as in 3 and feed the counterpart's payload to
   the connection this device already has. Both hold both payloads; QWBP picks
   offerer and answerer by comparing fingerprints, so neither needs a D.
5. **Read D** (state 3 only — this device showed C): feed the payload to the
   connection.
6. **Channel.** QWBP derives the ICE credentials from the scanned
   fingerprint, and WebRTC's DTLS handshake accepts only a peer whose
   certificate has that fingerprint — that is what makes the channel the one
   negotiated on screen. When the data channel opens, each side sends **one**
   message and expects one:

   ```json
   { "type": "PQ2_CONFIRM", "card": <own signed user card row>, "sig": "<base64 sigPQ>" }
   ```

   The card is the freshest self-signed card row (with `sign_b64`), not the
   unsigned local registry entry. `EncryptionManagerPQ.signedOwnCard()` (new)
   returns it through the same freshest-of lookup `#pushOwnCard` uses today,
   taken out into one private helper. If none exists (never published,
   offline), the handshake ends *optically verified*.

   On receipt: the card vouches for the bound counterpart and key —
   `cardVouchesForContactKey`, extended to check `user_hash` as well — and
   `ML-DSA-87.verify(sig, M, card.sign_pkey)` holds. Both, and the
   counterpart is **confirmed**. Any failure is logged, the
   handshake ends *optically verified* only, and the card is dropped.
   The camera stops decoding once both payloads are known; nothing is left to
   read while the channel opens and the ML-DSA work runs.
7. **Done.** Stop the camera; keep the last code on screen (the counterpart
   may still be reading it — `docs/handshake_fix_report.md`); show the SAS;
   emit `completed`:

   ```ts
   {
     user_hash: string;
     contact_pkey: string;     // padded base64, as cards carry it
     confirmed: boolean;       // step 6 passed
     card: UserCardRow | null; // the verified card, when confirmed
     sas: string;              // six digits
     name: string;             // card.name, else a known card's, else 'Unknown user'
   }
   ```

**Channel failure.** If the channel has not opened 15 s after both payloads
are known: when `VITE_HANDSHAKE_ICE_SERVERS` is configured, one retry with
those servers (the setting is documented as "reaches across networks at the
price of a query to those servers"); otherwise, or after the retry, the
handshake ends *optically verified*. The UI says so: "Key verified in person;
not yet confirmed — scan again on a shared Wi-Fi or hotspot to confirm."

**Session end.** After 90 s without completion, or when the person stops the
scanner, the session is discarded; a new start mints a new nonce. Codes from
an ended session verify against nothing.

## 6. What the modal does with the result

`Modal_QrHandshake.vue`, on `completed`:

- `confirmed` and not a contact yet → `confirmContact(user_hash, contact_pkey, { name, notes: '', hidden: false })`; toast "Contact added and confirmed", SAS shown.
- `confirmed` and already a contact → `confirmContact(user_hash, contact_pkey)`; toast "Contact confirmed".
- not `confirmed` → `saveContact(user_hash, { name, notes: '', hidden: false, contact_pkey })` if new; toast "Key verified in person; not yet confirmed" with the reason.
- The contact page opens by `user_hash`.

`confirmContact` is the only path that sets `confirmed` (`src/store/userPQ.store.js`),
and it no longer trusts its caller: it takes the verified card and runs
`cardVouchesForContactKey` itself, refusing when it fails. It sets
`confirmedAt` (unix seconds) itself; neither field is among those
`saveContact` callers may write (`STORED_FIELDS`). A `saveContact` that
changes the `contact_pkey` of a confirmed contact clears `confirmed`: the
confirmation was of the old key. The modal no longer derives `confirmed` from
the card alone (`onHandshakeCompleted`); the engine decides.

The modal keeps its own-account check: a handshake whose counterpart is the
signed-in account is refused before anything is saved.

The card is not written into `allNetworkUsers` (§1).

## 7. Code layout

- `src/lib/pq/handshake.ts` — pure functions, no DOM: `encode`/`parse` for A–D
  (length-checked), `transcript(a, b)`, `pqMessage(T, fpA, fpB)`, `sasOf(T)`,
  the transport fingerprint via `qwbp`'s own `decode(payload).fingerprint`
  (no second parser of its format), and the confirm-message check
  (`checkConfirm(msg, bound, T, fps) → { ok, card } | { ok: false, reason }`).
- `src/components/engines/QRScannerEngine.vue` — camera, QR rendering, the
  state machine and the QWBP connection, calling the module above. Session
  state is one object, reset by `start()`.
- `EncryptionManagerPQ` gains `signHandshakePQ(M)` (ML-DSA-87 under
  `sign_skey`) beside `signContactChallenge`.
- `src/store/userPQ.store.js` — `confirmContact(userHash, card)` as in §6.

## 8. Tests

`tests/handshake.test.ts` (node, real crypto — `@noble` runs under node):

- Golden vectors: `T`, `M` and `sas` for two fixed identities and fixed
  nonces, computed outside the module and pinned byte for byte.
- Ordering: `transcript(a, b)` equals `transcript(b, a)`.
- Parsing: every message type round-trips; a field of the wrong length, a
  missing field, a `PQ1:` code and a non-base64url field are refused.
- Optical signature: verifies under the sender's key; fails under another key,
  under another nonce, under another counterpart, under a `PQ1`-style bare
  nonce signature.
- Confirm message: passes with a signed card whose `contact_pkey` is the bound
  key; fails when the card does not verify, when its `contact_pkey` differs
  (someone showing Alice's hash with their own key), when `sigPQ` is under
  another identity, when the fingerprints differ.

`tests/qrHandshakeEngine.test.js` (jsdom, camera and QWBP stubbed):

- Two engines driven against each other complete in both orders (A→B→C→D from
  either side), in the symmetric race (both read A first, then both read B
  first — both show C, and the channel still opens), and a code carrying the
  reader's own `user_hash` is ignored.
- A code from another session (different nonce) is ignored; a code naming a
  different `user_hash` mid-session is ignored; after 90 s the session is gone.
- A channel that never opens ends *optically verified*; `completed` carries
  `confirmed: false` and no card.
- A confirm message with a foreign card leaves `confirmed: false`.

Each regression test is run against the `PQ1` engine once before it is
deleted, to show it fails there (CLAUDE.md, verification standard).

## 9. Acceptance

- Two phones, face to face, on one Wi-Fi: both show "Contact confirmed" and
  the same six digits within about two seconds of both cameras opening.
- The same, on mobile data with no shared network and no ICE servers
  configured: both show "Key verified in person; not yet confirmed".
- A third phone showing `PQ2:A:` with Alice's `user_hash` and its own key: the
  scanning phone reaches *optically verified* and then ends not confirmed
  (card check fails); nothing is saved as confirmed.
- A recorded B replayed to a fresh session: ignored (nonce differs).
- `npm test`, `npm run lint`, `npm run build` green.

## 10. Out of scope, noted for later

- **Multi-frame (animated) QR** for the post-quantum signature and the card,
  so confirmation works with no network at all: ~2 frames of 2.9 KB for the
  signature, ~5 for the card. Needs camera reliability work; the protocol
  above leaves room for it (a `PQ2:E:<frame>/<n>:<bytes>` message).
- **Vouch token issuance** on confirmation (`pq_vouch_tokens`): the engine's
  result carries everything a token needs; issuing it is that requirement's
  work.
- Radio (NFC) transport of the same messages.

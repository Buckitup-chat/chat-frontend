# PQ2 handshake sandbox

A standalone page that runs the optical handshake v2
(`docs/task-handshake-pq2.md`) between two phones: QR codes through the
front cameras, a transcript signature, a WebRTC channel bootstrapped by QWBP,
a post-quantum confirmation over it, and the six digits both screens show.
It is not the app: no account, no server, no contacts. Each phone makes a
test identity when the page loads (ML-DSA-87 identity key, secp256k1
contact key, a self-signed card made by the app's own code). Its keys stay
in the page: a reload makes a new identity under the same name. The browser
keeps only the settings and the card of the last phone confirmed.

The protocol and the card check use the app's own crypto layer
(`src/lib/pq`: card verification, signatures, HKDF), so a confirmation here
is the one the app would make.

## Open it

On both phones, in Chrome (Android) or Safari (iOS):

**https://raw.githack.com/Buckitup-chat/chat-frontend/sandbox-handshake-pq2/sandbox/handshake-pq2/dist/index.html**

Allow the camera. On iOS, allow "Local Network" if asked — without it
Safari cannot reach the other phone directly.

## Test by hand

Hold the phones face to face, screens towards each other, about 25–40 cm
apart: closer, a front camera does not focus. Each screen shows its code;
the small preview in the corner is its camera. The frame around the code
changes colour as the session advances (grey A → purple B → dark purple C →
blue D), and turns green, amber or red at the end.

| # | Setup | Expected |
|---|---|---|
| 1 | Both on the same Wi-Fi, STUN off (default) | Both: ✅ Confirmed, the other phone's name, the **same six digits**, in about 2–4 s |
| 2 | Both on mobile data, STUN off | Both: 🟡 "Key verified in person, not confirmed — no channel within 15 s", and the same six digits |
| 3 | Both on mobile data, ⚙︎ → Channel: STUN on | Often ✅ (depends on the carriers' NAT); otherwise as in 2 |
| 4 | One phone in airplane mode | That phone: 🟡 "no channel: …" (it has no address to offer). The other: ⌛ Session expired after 90 s |
| 5 | After test 1, reload phone B: it gets a new identity. On phone A: ⚙︎ → Mode: Impostor. A now shows B's old identity with A's own key, and sends B's old card | B: 🟡 "card does not certify the contact key the codes showed". Never ✅ |
| 6 | Point a phone at a mirror | Nothing happens: its own code is ignored (see the log) |
| 7 | Start a session and wait 90 s without scanning | ⌛ Session expired |
| 8 | Laptop and phone. A laptop webcam reads the phone's B — the densest code — only from about 20 cm, if at all: hold the phone's screen to the webcam, then turn the phone to read the laptop's screen (⚙︎ → Camera: Back reads better), or pass a code by hand with "Copy my code" / "Paste a code" | Same as 1, slower |
| 9 | Both on mobile data (or in airplane mode), ⚙︎ → Channel: Animated QR on both. After the B codes, keep the phones still while the codes change several times a second | Both: ✅ Confirmed and the same six digits, with "identity key matches · optical and post-quantum signatures ok". Note the time in "Timings" — "frames started" to "done" — and try the frame sizes and rates |
| 10 | Both on mobile data, ⚙︎ → Channel: TURN with the relay server's URL, user and password (section "TURN") | Both: ✅ Confirmed, the same six digits; the log's "own payload" line offers `relay/…` addresses |
| 11 | On one Wi-Fi, Channel: TURN with "offer the relay's addresses only" | Same as 10: the relay works without leaving the room |

In test 5, a phone that has confirmed nobody impersonates a stand-in
identity instead. Without the reload, B would see its own identity and
ignore the code.

What to report: the result on each phone, whether the six digits matched,
the "Timings" list, and — on failures — the log (long-press to copy, or a
screenshot). The log names the ICE candidates each side offered (`host` or
`srflx`, and the address), which tells whether the phones could reach each
other at all.

## What it does not do

- The relay's credentials are typed into the settings; the app fetches
  short-lived ones from its backend (spec §5a).

## TURN

With ⚙︎ → Channel: TURN, the phones reach each other through a relay
server when they share no network — both on mobile data, for instance. The
settings take the server's URL (`turn:host:port?transport=tcp`), user and
password, kept in this browser's storage. "Offer the relay's addresses
only" leaves the phones' own addresses out of the code, so the connection
goes through the relay even on one Wi-Fi.

QWBP's code has no room for relay addresses: its format knows host and
srflx candidates only, and it drops relay ones. The sandbox reads them from
the connection's own description and puts them in the code as srflx — the
other phone needs only where to send. The app does the same inside QWBP
rather than around it (spec §5a).

The relay sees only encrypted traffic: DTLS runs between the phones, and
the fingerprints in the codes make sure the channel ends at the phone that
showed them. What the relay learns is that two addresses exchanged a few
kilobytes.

### A relay server

The app's relay is the chat backend's: a relay release on ProcessOne's `stun`
library next to the chat release, with short-lived credentials from
`POST /electric/v1/turn_credentials`
(`chat/docs/pq/reqs/pq_turn_relay.proposed.md`). The sandbox takes any TURN
server with a user and a password; a local one:

```
docker run --network=host coturn/coturn -n --lt-cred-mech --user=pq2:<password> --realm=buckitup --listening-port=3478 --fingerprint --no-cli
```

The Chromium check runs the same through any relay:
`PQ2_TURN_URL=turn:… PQ2_TURN_USER=… PQ2_TURN_PASS=… node sandbox/handshake-pq2/scripts/check.mjs`.

## Animated QR

An experiment that is not in the spec: with ⚙︎ → Channel: Animated QR, the
phones use no network at all. After the B codes, each phone shows a loop of
QR frames instead of C and D, reads the other's, and the post-quantum proof
goes through the cameras (`src/frames.ts`).

A phone sends the smallest proof that confirms it: its optical signature,
its identity key (2,592 bytes) and an ML-DSA-87 signature over the
transcript and its name (4,627 bytes) — about 7.3 KB. The network channel
carries the whole card instead, about 30 KB. The transcript holds the
contact key the codes showed, so the identity's signature over it ties that
key to the identity for this session, as the card's certificate does for
good. The receiving phone checks that the identity key is the user_hash the
codes showed and that both signatures verify.

The proof travels in base45 (RFC 9285), whose alphabet is the QR
alphanumeric mode: 5.5 bits a character instead of 8. A frame reads
`PQ2:F:<sender>:<index>:<count>:<received>:<data>`: the sender is its
session (three bytes of its nonce), and "received" is how many of the other
phone's frames it holds — a phone that holds everything keeps its frames up
until the other one says so too, or for 20 s. Frame sizes: small about 48
frames (QR version 8), medium about 25 (version 11, as dense as B), large
about 16 (version 15). The six digits come from the transcript alone, as no
channel is there to cover.

## Develop

From the repository root (the page imports `src/lib/pq`, so it builds here):

```bash
npx vite --config sandbox/handshake-pq2/vite.config.ts --host      # dev server
npx vitest run --config sandbox/handshake-pq2/vite.config.ts       # protocol and engine tests
npx vite build --config sandbox/handshake-pq2/vite.config.ts       # → dist/, committed for the link above
node sandbox/handshake-pq2/scripts/check.mjs                        # two Chromium pages, real WebRTC, no STUN
```

A phone gets the camera and WebCrypto only in a secure context, so to open
the dev server from phones on the same network, serve it over HTTPS. A
self-signed certificate does; each phone asks once to accept it:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=pq2-sandbox \
  -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -keyout /tmp/pq2-key.pem -out /tmp/pq2-cert.pem
PQ2_CERT=/tmp/pq2-cert.pem PQ2_KEY=/tmp/pq2-key.pem npx vite --config sandbox/handshake-pq2/vite.config.ts --host
```

Then open `https://<the computer's address>:5173` on each phone.

Code: `src/protocol.ts` (messages, transcript, signatures, comparison code,
confirmation check), `src/engine.ts` (the state machine, no DOM),
`src/channel.ts` (QWBP adapter, and the fake network the tests use),
`src/identity.ts`, `src/main.ts` (camera, QR, settings).

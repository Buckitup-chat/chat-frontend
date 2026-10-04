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

Hold the phones face to face, screens towards each other, about 15–25 cm
apart. Each screen shows its code; the small preview in the corner is its
camera. The frame around the code changes colour as the session advances
(grey A → purple B → dark purple C → blue D), and turns green, amber or red
at the end.

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

In test 5, a phone that has confirmed nobody impersonates a stand-in
identity instead. Without the reload, B would see its own identity and
ignore the code.

What to report: the result on each phone, whether the six digits matched,
the "Timings" list, and — on failures — the log (long-press to copy, or a
screenshot). The log names the ICE candidates each side offered (`host` or
`srflx`, and the address), which tells whether the phones could reach each
other at all.

## What it does not do

- The spec's "one retry with configured ICE servers" (§5) is a setting here
  instead: a QWBP connection gathers its candidates before its code is shown,
  so changing ICE servers means new codes, i.e. a new session.
- No multi-frame codes: with no network path between the phones, the result
  is "verified in person, not confirmed", by design.
- The QWBP connection is set up when the session starts, not after the
  optical check (§5 step 3), so C shows without waiting for the address
  gathering. Nothing of it is shown before C.

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

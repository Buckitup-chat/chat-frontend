# PQ2 handshake sandbox

A standalone page that runs the optical handshake v2
(`docs/task-handshake-pq2.md`) between two phones: QR codes through the
front cameras, a transcript signature, a WebRTC channel bootstrapped by QWBP,
a post-quantum confirmation over it, and the six digits both screens show.
It is not the app: no account, no server, no contacts. Each phone makes its
own test identity (ML-DSA-87 identity key, secp256k1 contact key, a
self-signed card in the app's format) and keeps it in the browser.

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
| 2 | Both on mobile data, STUN off | Both: 🟡 "Key verified in person, not confirmed — no channel within 15 s" |
| 3 | Both on mobile data, ⚙︎ → Channel: STUN on | Often ✅ (depends on the carriers' NAT); otherwise as in 2 |
| 4 | Phone A confirms phone B (test 1). Then on a third phone, or on A after "New identity": ⚙︎ → Mode: Impostor. Phone C now shows B's identity with its own key | The honest phone: 🟡 "card does not certify the contact key the codes showed". Never ✅ |
| 5 | Point a phone at a mirror | Nothing happens: its own code is ignored (see the log) |
| 6 | Start a session and wait 90 s without scanning | ⌛ Session expired |
| 7 | Laptop and phone: ⚙︎ → Camera: Back on the phone, or "Paste a code" / "Copy my code" to pass codes by hand | Same as 1, slower |

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

## Develop

From the repository root (the page imports `src/lib/pq`, so it builds here):

```bash
npx vite --config sandbox/handshake-pq2/vite.config.ts --host      # dev server; phones need https for the camera
npx vitest run --config sandbox/handshake-pq2/vite.config.ts       # protocol and engine tests
npx vite build --config sandbox/handshake-pq2/vite.config.ts       # → dist/, committed for the link above
node sandbox/handshake-pq2/scripts/check.mjs                        # two Chromium pages, real WebRTC, no STUN
```

Code: `src/protocol.ts` (messages, transcript, signatures, comparison code,
confirmation check), `src/engine.ts` (the state machine, no DOM),
`src/channel.ts` (QWBP adapter, and the fake network the tests use),
`src/identity.ts`, `src/main.ts` (camera, QR, settings).

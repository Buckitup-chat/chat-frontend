# Task: ship the optical handshake v2 (PQ2) with the relay

**Spec:** `docs/task-handshake-pq2.md`. It is the contract; this task says
how to get there. Read the spec's §5a first: it is what changed after the
sandbox.
**Reference implementation:** `sandbox/handshake-pq2`. It runs the protocol on
two phones, including through a TURN relay, and has unit tests and a Chromium
check. Both come from the branch `sandbox-handshake-pq2` (PR: spec update plus
sandbox).
**Backend dependency:** `chat/docs/pq/reqs/pq_turn_relay.proposed.md` — the
relay credentials endpoint and coturn on the host. It is not built yet. Develop
against a local coturn (part 4) and switch when it lands.
**Base:** `origin/main` once the `sandbox-handshake-pq2` PR has merged. Until
then `main` has neither the sandbox nor the spec's §5a, D's session tag or the
relay, and building from `main` alone builds the old design.

## What the user gets

- **Two phones face to face:**
  - on one Wi-Fi, "Contact confirmed" and the same six digits in about two
    seconds;
  - both on mobile data, the same, through our relay;
  - with no internet but a shared network, the same, directly.
- **No third-party servers** (the hard-coded Google STUN goes).
- **No animated QR.** The sandbox has it; the app does not ship it (spec
  §10).

## Work, in order

### 1. The protocol module (pure, no DOM)

- Create `src/lib/pq/handshake.ts` from `sandbox/handshake-pq2/src/protocol.ts`.
  It already uses the app's own `src/lib/pq` (signature, HKDF, card checks).
- Keep the spec's names (§7):
  - `encode` and `parse` for A–D;
  - `transcript`;
  - `pqMessage`;
  - `sasOf` (the sandbox's `comparisonCode`);
  - `checkConfirm`.
- Drop the sandbox's frame message (`F`) and everything from `frames.ts`.
- Golden vectors (spec §8): pin `T`, `M` and `sas` for two fixed identities
  and nonces, computed outside the module. The sandbox's
  `tests/protocol.test.ts` is the starting point; move it to
  `tests/handshake.test.ts`.

### 2. The engine in the app

- Rewrite `src/components/engines/QRScannerEngine.vue` around the sandbox's
  `HandshakeEngine` (`src/engine.ts`). The engine stays a plain class with a
  `ChannelAdapter`; the Vue component owns the camera, the QR canvas and the
  emit.
- **D carries the session tag** (spec §3): the first 6 bytes of `SHA-256(T)`.
  A D with another tag is ignored.
- Keep the sandbox's hardening; these are bugs it has already had:
  - **A session id, checked after every `await`.** A restarted session must not
    be drawn over, have its camera stopped by, or be completed by the old one.
  - **A code that does not verify binds nothing.** A stale B from a previous
    session must not lock the counterpart.
  - **The QWBP timeout is at least 3 minutes**: its timer starts after
    gathering, and a channel may open up to 105 s into the session.
  - **One confirm message per channel.** QWBP can hand over two data
    channels; send on the first only.
  - **A message that arrives before the engine listens is kept**, not dropped
    (`linkOf` in the sandbox): the peer may confirm the moment the channel
    opens.
  - **A channel that opens late but inside the window counts on both sides.**
  - **No network interface at all** ends *optically verified* at once,
    instead of hanging until the timeout.
- **Camera:**
  - decode with qr-scanner's own decoder, not `BarcodeDetector`;
  - show the code large;
  - tell people to hold the phones 25–40 cm apart: closer, front cameras do
    not focus.
- Remove PQ1 completely: the `PQ1:` paths, the Google STUN servers and
  `src/libs/QRHandshakeManager.js`.
- Add `EncryptionManagerPQ.signHandshakePQ(M)` and `signedOwnCard()` (spec
  §5 step 6).
- Change `confirmContact` to `confirmContact(userHash, card, fields?)`: it
  takes the verified card and runs `cardVouchesForContactKey` itself (§6).
  Today it checks **nothing** — it writes `confirmed: true` for whatever key it
  is given, and the only check is in `Modal_QrHandshake.vue`. Move the check
  into the store, keep it in no caller, and finish the §6 contract
  (`confirmedAt`, and `saveContact` clearing `confirmed` on a key change).
- Update `Modal_QrHandshake.vue` per §6: the toasts, the SAS on screen, and no
  write into `allNetworkUsers`.

### 3. Addresses and QWBP (spec §5a)

- **Patch QWBP** (`qwbp@0.1.0`, github.com/magarcia/qwbp) with one public
  hook and nothing else:
  - `selectCandidates(all)` gets every gathered candidate, relay included,
    with its real type, and returns the list to encode;
  - the limit stays QWBP's existing `maxCandidates`, set explicitly to 6 —
    its default of 4 would cut the list to two relays, one srflx and a single
    host address, possibly a VPN's;
  - the payload is yielded once the hook's list is complete, or after 2 s,
    not at gathering-complete.

  Teaching QWBP to parse relay candidates as srflx is **not** enough: its own
  selection keeps host addresses plus the first srflx, and the STUN answer
  arrives before the relay, so the relay would still be dropped. Ship the
  patch with the app (a fork pinned by git URL, or `patch-package` with the
  patch committed) and offer it upstream. Reading `localDescription` through
  QWBP's private `pc`, as the sandbox does, must not reach the app.
- **The candidate list** is a pure function in the app, ported from the
  sandbox's `relaysOf` and `selectAddresses` in `channel.ts` (tested in
  `tests/channel.test.ts`):
  - UDP only, at most six, at most two IPv6;
  - relay first (at most two, typed as srflx), then one srflx, then host.
- **QWBP options:**
  - always pass `iceServers` explicitly — `[]` when there is no relay. QWBP
    falls back to Google's STUN servers when the option is missing;
  - set `timeout` to at least 3 minutes; the 30 s default closes the
    connection while the codes are still being read.
- **One QWBP connection per session,** created at session start (step 1), with
  the relay as its only ICE server, or none.

### 4. Relay credentials

- **`src/lib/data/turnCredentials.ts`:**
  - `api.getChallenge()`, then `POST /electric/v1/turn_credentials
    {user_hash, challenge_id, signature}`;
  - keep the result in memory, never on disk; refresh when less than 150 s
    remain, so a session never outlives its credential;
  - any failure (offline, `503`, no answer) returns "no relay", and the
    handshake goes on with local addresses.
- **The proof:** ML-DSA-87 over the challenge string's **UTF-8 bytes**,
  unpadded base64 — what `api.ingestWithAuthEach` sends and what read sessions
  send (`src/lib/data/readSession.ts` on branch `gated-reads`, which also
  makes `EncryptionManagerPQ.signChallenge` sign those bytes). One helper for
  all three. On `main`, until `gated-reads` lands, `signChallenge` still
  base64-decodes the challenge first: do not build on it there. The test below pins the bytes: a proof over anything else is
  refused, and every handshake would then run without a relay, silently.
- **Timing:** request the credentials when the add-contact view opens, one
  screen before the scanner. At session start, use what is cached or wait at
  most 1 s, then go without.
- **Until the backend endpoint exists:** a dev-only setting
  (`VITE_HANDSHAKE_TURN_URL`, `…_USER`, `…_PASS`) for a local coturn:

  ```
  docker run --network=host coturn/coturn -n --lt-cred-mech --user=pq2:<password> --realm=buckitup --listening-port=3478 --fingerprint --no-cli
  ```

  Read them only under `import.meta.env.DEV`, as `src/config/sandbox.ts`
  gates dev-only surfaces: Vite inlines any `VITE_*` value set at build time,
  so without the guard a developer's `.env.local` or a hosting variable puts
  the password into the deployed bundle. Remove the setting when the endpoint
  lands.

### 5. Tests (spec §8)

- **`tests/handshake.test.ts`** (node, real crypto):
  - the golden vectors;
  - ordering;
  - parsing, including refusing `PQ1:` and wrong lengths;
  - the optical signature under the wrong key, nonce or counterpart;
  - `checkConfirm` with a foreign card, a wrong key or a wrong fingerprint;
  - the candidate list: relay first, at most two, then srflx and host, UDP
    only, at most six, at most two IPv6, relay typed as srflx;
  - the challenge proof verifies over the UTF-8 bytes of the challenge, as the
    server checks it.
- **`tests/qrHandshakeEngine.test.js`** (jsdom, camera and QWBP stubbed):
  - both scan orders and the symmetric race;
  - a code from another session, and the 90 s end;
  - a channel that never opens;
  - a failed or slow (over 1 s) credentials request still starts a session,
    and the `RTCPeerConnection` it creates has an empty ICE server list — the
    configuration is checked, not the option passed;
  - a D from another session is ignored and the real D taken;
  - a confirm message that arrives before the engine listens is still read;
  - a restart during an `await` of the old session.
  - The sandbox's `tests/engine.test.ts` already covers most of these with
    `FakeChannel`.
- **Regression tests:** run each once against PQ1 before deleting it, and show
  it fails there.
- **Chromium:** port `sandbox/handshake-pq2/scripts/check.mjs` (two pages,
  real WebRTC) to run against the app. For the relay case it takes
  `PQ2_TURN_URL`, `PQ2_TURN_USER` and `PQ2_TURN_PASS`. Two pages on one host
  would connect directly, so the case offers relay addresses only, through a
  test-only switch unreachable in a production build, and asserts from
  `getStats()` that the selected candidate pair's local type is `relay`.

## Acceptance (spec §9)

- **Two phones, staging:**
  - one Wi-Fi: confirmed;
  - both on mobile data: confirmed through the relay;
  - one Wi-Fi with no internet: confirmed directly;
  - both on mobile data with the relay down: *optically verified*, with the
    message from spec §5.
- **An impostor phone** showing Alice's `user_hash` with its own key: never
  confirmed, nothing saved as confirmed.
- **A recorded B replayed** to a new session: ignored.
- **No requests** to any server other than ours during a handshake (check
  `chrome://webrtc-internals` and the network tab).
- **Checks:** `npm test`, `npm run lint` and `npm run build` are green.

## Notes

- **A flaky test** on current `main`, unrelated to this work:
  `tests/userCardBootstrap.test.ts` › "two tabs retrying the import at once
  share the one operation…" passes and fails on the same tree. Branch
  `gated-reads` raises its timeout from 20 s to 45 s; whether that is the
  cause or only hides it is worth a look.
- **The access-gating task** (`docs/task-access-gating-client.md`, part 5)
  issues vouch tokens in `confirmContact`. Whichever lands second builds on
  the other's `confirmContact`.

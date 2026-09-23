# Message delivery latency: a measurement and its analysis

**Measured:** 2026-08-14
**Build:** branch `docs/tanstack-migration`, commit `2ffd2c1`, Vite dev server
**Backend:** `https://buckitup.xyz`, Electric over Postgres (restarted shortly
before the measurement)
**Client:** TanStack DB + `@tanstack/electric-db-collection`, shapes through
`/electric/v1/shapes`

---

## 1. In brief

Messages between two dialog participants are delivered **in batches** rather
than as they are sent. Three messages sent eight seconds apart reached the
recipient **in the same millisecond**. The observed latency ranges from 1 to 17
seconds, and what determines it is not load but where in the long-poll cycle the
send happened to fall.

The recipient's network layer shows two consecutive `live=true` requests hanging
for 20.2 seconds each and returning "no changes", although some of the messages
had already been sent by then.

**An important caveat that must not be skipped:** the data collected is **not
enough** to distinguish "the reader did not see it in time" from "the writer
wrote later than it appears". Both hypotheses are described in §5, along with the
specific measurement that separates them. Please do not treat this as a
confirmed Electric bug until §6 has been done.

---

## 2. How it was reproduced

Two independent application sessions in one browser. The application forbids a
second tab, so the sessions were separated by origin:

| Session | Origin | Account |
|---|---|---|
| Sender | `http://b.localhost:5174` | `ClaudeTest-C` — `u_5cbb0089…d9b06c` |
| Recipient | `http://localhost:5174` | `ClaudeTest-B` — `u_c6098dc8…5607b0` |

Chrome maps any `*.localhost` to loopback; that is separate storage while still
being a valid RP ID for WebAuthn (`127.0.0.1` would not do — WebAuthn does not
accept IP addresses). Both sessions talk to the same dev server and the same
backend.

Both sides kept the dialog **open** for the whole measurement. That matters: see
§7.

Sending was done programmatically — set the value of the input and click the send
button, recording `Date.now()` immediately before the click. The recipient
recorded the text appearing in the DOM through a `MutationObserver` plus a 50 ms
poll.

---

## 3. The result

| # | Marker | Sent (wall, ms) | Delivered after |
|---|---|---|---|
| 1 | `LAT-1867146` | 1786701868207 | **17,005 ms** |
| 2 | `LAT-2875207` | 1786701876206 | **9,006 ms** |
| 3 | `LAT-3883208` | 1786701884207 | **1,005 ms** |

The moment of appearance at the recipient for all three: **1786701885212**.

```
1786701868207 + 17005 = 1786701885212
1786701876206 +  9006 = 1786701885212
1786701884207 +  1005 = 1786701885212
```

A match to the millisecond — all three rendered from one response.

---

## 4. The recipient's network layer

Requests for the `dialog_messages` shape at the recipient, from
`performance.getEntriesByType('resource')`. `start`/`dur` are milliseconds since
page load; `size` is `decodedBodySize`.

```
live  offset            start   dur     size
true  0_inf             51669     464   7232
true  150786056_0       52136   20221     73     ← "no changes"
true  150786056_0       72358   20238     73     ← "no changes"
true  150786056_0       92597    3535   7461     ← all three arrived
true  150792376_0       96134     483   7461
true  150798696_0       96619     375   7461
```

Requests to the dialog's shapes in total: 9, of which `live=true`: 6. The gaps
between one long-poll ending and the next starting: **3, 1, 1, 2, 2 ms** — the
client reopens the connection immediately, so there is no idling on its side.

### Anchoring to a common clock

The origin is derived from the coincidence of the render moment and the end of
the request that delivered the data: `1786701885212 − 96132 ≈ 1786701789080`.

| Request | Start (wall) | End (wall) | Duration | Size | What it returned |
|---|---|---|---|---|---|
| A | 1786701840749 | 1786701841213 | 464 ms | 7232 | snapshot (`offset=0_inf`) |
| B | 1786701841216 | 1786701861437 | 20,221 ms | 73 | no changes |
| **C** | 1786701861438 | 1786701881676 | 20,238 ms | 73 | **no changes** |
| **D** | 1786701881677 | 1786701885212 | 3,535 ms | 7461 | **all three messages** |
| E | 1786701885214 | 1786701885697 | 483 ms | 7461 | — |
| F | 1786701885699 | 1786701886074 | 375 ms | 7461 | — |

The sends laid over that timeline:

```
C: [1786701861438 ─────────────────────────────── 1786701881676]  → 73 bytes
        ↑ msg1 1786701868207          ↑ msg2 1786701876206
D: [1786701881677 ────────── 1786701885212]                        → 7461 bytes
        ↑ msg3 1786701884207
```

- **msg1** was sent 13.5 s before request C ended — C returned "no changes".
- **msg2** was sent 5.5 s before request C ended — C returned "no changes".
- **msg3** was sent during request D — D finished **1.0 s** after it and brought
  all three at once.

Note that the `offset` in requests B, C and D is **the same** — `150786056_0`.
So from the server's point of view the position in the shape log did not move
during that time.

---

## 5. Two hypotheses

The observation "D woke 1.0 s after msg3 while C did not wake at all in 13.5 s"
admits two explanations, and they are fundamentally different.

### Hypothesis 1 — the reader: a long-poll is not woken by a write that happens while it waits

Request C hung for its full timeout (20.2 s) and returned `up-to-date` with no
data, although the records were already in the log. The wake mechanism worked for
D but not for C.

*For it:* D woke before its timeout, so waking works in principle, and C's
silence looks like a missed notification. The identical offset in B, C and D says
the server considered the position unchanged the whole time.

*Against it:* it is unclear why the mechanism worked once and failed twice in a
row.

### Hypothesis 2 — the writer: the commits happened later than the send was recorded

The measurement records the moment of the **click**, not the moment of the commit
in Postgres. The client's write path is asynchronous: the ML-DSA signature, the
HTTP request, then the `sendMutationsAndAwaitShape` barrier waiting for the txid
to become visible. If the sender's POST itself took seconds (or queued), then
msg1 and msg2 may have reached Postgres only around 1786701884–885, that is
**during request D**. The server's behaviour would then be impeccable: C honestly
saw no data because there was none, and D returned everything that had appeared.

*For it:* it explains the simultaneous arrival with no missed notifications, and
explains why D behaved "correctly".

*Against it:* it requires two consecutive writes to be delayed by 8–16 s, which
is a problem in itself — just in a different place.

**Both hypotheses mean a problem, but they are fixed in different places.**
Hypothesis 1 is Electric's side. Hypothesis 2 is the write path (the client, or
mutation intake on the server).

---

## 6. What to measure to tell them apart

One run with extra instrumentation on the sender's side is enough.

1. **The sender's commit time.** Record `Date.now()` at three points: before
   sending the mutation's HTTP request, on receiving the `200`, and when the txid
   visibility barrier fires. If the `200` arrives seconds later — hypothesis 2,
   and the next place to dig is mutation intake.
2. **The server's truth.** For the three records take `xact_commit_timestamp`
   from Postgres (or `inserted_at`, if such a column exists) and compare with the
   click moments. That settles the question for good.
3. **Electric's log** for the interval `1786701861438–1786701885212`: did a
   change notification for the `dialog_messages` shape with the filter
   `dialog_hash = '<hash of the C↔B dialog>'` arrive, and when.

If item 2 shows the commits happened at click time, hypothesis 1 is confirmed and
the question moves to Electric. If the commits are late, the question is about the
write path.

---

## 7. A side finding: dialogs do not sync in the background

Before the recipient **opened** the dialog, their tab made **not a single**
request to the dialog's shapes:

```
tables: ["user_cards", "user_storage"]   ← across 48 requests to /api/shapes
dialogReqs: 0
```

A message sent during that period did not arrive at all — not after 15 seconds,
not later. It appeared immediately after the dialog was opened and the client
created the subscription (14 requests).

This is behaviour separate from §3: dialog collections are created lazily, by the
`dialog_hash` of the open dialog. To a user it looks like "messages only arrive
when you open the chat" — and it is easily confused with the latency of §3,
although the cause is different.

It needs a product decision: either a background subscription to all of the
user's dialogs, or a separate lightweight notification channel.

---

## 8. Appendix: the weight of the `user_cards` shape

Measured at the same time. It has nothing to do with delivery latency but it does
shape the feeling of slowness at startup.

```
GET /electric/v1/shapes?table=user_cards&offset=-1
  → 200, 740,080 bytes, 30 rows           (~24 KB per card: ML-DSA/ML-KEM keys and certificates)

GET /electric/v1/shapes?table=user_cards&offset=0_0&handle=…&live=true
  → 200, 2,075,992 bytes, 112 log entries
```

The log holds 75 distinct keys, and one card appears **27 times** — every rename
publishes the whole row. That is about **2.8 MB** for the client to reach
`up-to-date`.

There is no compression: a request with `Accept-Encoding: gzip, br` returns the
same 740,080 bytes. Locally `gzip -9` takes off 25% (740,080 → 551,481 and
2,075,992 → 1,534,602).

The bytes are cached by the browser (`cache-control: public, max-age=604800`), so
an ordinary reload puts no load on the network — but parsing the JSON and loading
it into a collection repeats on every start.

**A proposal for the backend:** enable gzip on the shapes endpoint. A server-side
change, and every client benefits at once.

---

## 9. How to reproduce

```bash
git checkout docs/tanstack-migration
npm install --legacy-peer-deps
npm run dev
```

Open `http://localhost:5174` and `http://b.localhost:5174`, create an account in
each, add one to the other's contacts by `user_hash`, open the dialog on both
sides, and send messages about 8 seconds apart, noting the time of the click and
the time of appearance at the recipient.

Watch DevTools → Network with the `live=true` filter: the duration of each
request and the size of the response. A response of about 73 bytes means "no
changes".

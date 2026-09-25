# Reviews: context for the frontend

The reviews feature is ours to build on the client. This document describes what
the server already provides, what has to be written in `chat-frontend`, and what
of our code is reused as-is. Source — the `Buckitup-chat/chat` repository, commit
`867607a`; the full spec is `docs/pq/proposal/reviews.md` (919 lines).

## The short version

**The server side is done.** Nine review/origin shapes are registered in the
shape registry (`lib/chat/data/shapes.ex`), the migrations are applied, the
moderation pipeline works in all three modes, and 241 tests are green. The
feature has no HTTP routes of its own: the same `/ingest_each` and
`/electric/v1/shapes` as the dialogs.

**There is no client at all** — `chat-frontend` has zero mentions of origins or
reviews. The spec marks this as `UI ✗` in both phases.

The good news: our data layer fits the feature almost unchanged, and the backend
carries working reference implementations of every role (see "Sandboxes").

## The model

A review is about an **origin** (a venue, a place). An origin is not a room but a
**sub-account**: it has its own row in `user_cards` with its own ML-DSA-87 +
ML-KEM-1024 pair, and an owning user linked through `owner_cert`. An important
consequence: a private review sent "directly to the venue" (`to_origin`)
**requires nothing new** — it is an ordinary dialog message to the origin's
`user_hash`, and the whole `pq_dialogs` machinery works as-is. The separate
tables exist only for public reviews (`to_public`).

The visibility of a public review is controlled by the **server**, not the
author. A review's content is encrypted with `review_password`; the review
becomes publicly readable only when that password appears in
`review_public_passwords`. The author cannot write to that table — they submit a
"candidate" and the server promotes it.

## Tables and shapes

| Table (`?table=`) | Purpose | Synced |
|---|---|---|
| `origins` | venue metadata, `moderation_mode`, `owner_cert` | yes |
| `review` | the review itself, `content_b64` encrypted with `review_password` | yes, by `origin_hash` |
| `review_public_passwords` | passwords of public reviews; append-only, LWW by `owner_timestamp`, `password_b64 = null` means revoked | yes |
| `review_list` | the author's `(review_hash, review_password)` list for contacts | yes, by `user_hash` or `origin_hash` |
| `review_post_right` | KEM envelope: the right to publish | yes |
| `review_revoke_right` | KEM envelope: the right to revoke | yes |
| `review_password_candidate` | the author's submission before the moderation decision | **no** (server-internal) |
| `review_post_right_candidate` | staging: the envelope before the author's signature | yes (to the author) |
| `review_revoke_right_candidate` | the same for the revoke right | yes (to the author) |

Hash prefixes (`lib/chat/data/types/consts.ex`): `ors_` (origin sign), `rv_`
(review id), `rvs_` (review sign), `rvps_` (password sign), `rvprs_` / `rvrrs_`
(post/revoke right sign), `rvls_` (review_list sign). All of them are
`prefix + hex(SHA3-512)`, like the dialog ones.

## Endpoints

There are no review-specific routes:

- **reading** — `GET /electric/v1/shapes?table=<table>&where=…`; the tables above
  pass `ElectricTableGuard` (which builds its whitelist from the shape registry
  at compile time);
- **writing** — `POST /electric/v1/ingest_each` with an ordinary mutation; the
  table comes from `syncMetadata.relation`, whose values match the shape names:
  `"review"`, `"review_list"`, `"review_public_passwords"`, `"origin"` and so on;
- **authentication** — the same challenge/PoP as everywhere else.

An example mutation from a backend test
(`test/chat_web/controllers/electric_controller_review_test.exs:296`):

```json
{
  "type": "insert",
  "modified": {
    "review_hash": "rv_…", "origin_hash": "u_…", "author_hash": "u_…",
    "content_b64": "…", "deleted_flag": false,
    "owner_timestamp": 1234567890, "sign_b64": "…", "sign_hash": "rvs_…"
  },
  "syncMetadata": { "relation": "review" }
}
```

## Three moderation modes

The mode is chosen by the origin's owner (`origins.moderation_mode`).

- **`none`** — the server promotes the password immediately and the review is
  public at once.
- **`post`** — the author first issues the revoke right, the server publishes,
  and the origin can hide it later.
- **`pre`** — the author issues both rights, the server keeps the password, and
  publication happens by the origin's action.

Promotion is a **two-phase handshake over ordinary ingest**, with no dedicated
routes. Phase 1 (`promote_candidate`) fires when candidates arrive and wraps the
password into a KEM envelope for the origin's `crypt_pkey`. Phase 2
(`complete_promotion`) fires once the author's client has read the envelope from
the shape, checked the wrapping and sent a signature; the server then moves the
signed candidates into the production tables.

A hard invariant the client will have to honour: in `post` and `pre` modes the
`owner_timestamp` of the null version (revoke) must be **strictly greater** than
that of the version carrying the password, or the revocation will not override
publication under LWW. The server checks this and rejects the promotion.

## Contacts see a review bypassing moderation

The author keeps a `review_list` — one row per review, where `review_password` is
encrypted with a single per-author `review_list_password`. That
`review_list_password` is handed to contacts through a dialog and stored in User
Storage for multi-device. **There is no contact entity in the data** — the
contact list is entirely client-side, and the server sees only `review_list`
rows.

So that contacts do not become a way around moderation, `review_list` requires
proof that the pipeline was followed; the server checks it on insert and on
update:

| Mode | `review_password_sign_hash` | `post_right_sign_hash` | `revoke_right_sign_hash` |
|---|---|---|---|
| `none` | required | null | null |
| `post` | required | null | required |
| `pre` | null until approval, then filled | required | required |

## Ready references — the sandboxes

The most valuable thing for client work: the backend hosts working LiveView
implementations of every role. These are not mockups; they call the same API and
have been exercised against a live server in all three modes.

| URL | Role |
|---|---|
| `/electric/origin_sandbox` | creating an origin, exporting and importing keys |
| `/electric/review_sandbox` | author: write a review, submit candidates, sign rights, build the `review_list` |
| `/electric/moderation_sandbox` | origin: import identity, the queue, approve / reject / revoke |
| `/electric/contacts_reader` | reader: collect keys from dialogs, read contacts' reviews |
| `/electric/origin_reviews` | public browsing of decrypted reviews |
| `/electric/origins`, `/electric/reviews`, `/electric/review_lists`, `/electric/review_public_passwords`, `/electric/review_post_rights`, `/electric/review_revoke_rights` | row browsers |

## Backend defects and gaps the client should know about

From the spec's "Known gaps" and phases 3/5:

- **The owner / origin split is not enforced.** Changing `moderation_mode` and
  soft-deleting an origin are authorised by the **origin identity's** signature,
  so a delegated moderator can do both. The requirement that dangerous
  operations be signed by the owner is deferred.
- **A stale update over HTTP returns 500 instead of 4xx** — the changeset is
  marked `:ignore` and `Ecto.Multi.update` will not take it. This affects every
  ingest table, not just reviews.
- **Equal `owner_timestamp` values diverge between the node and its peers** —
  accepted locally, rejected by peers. `owner_timestamp` is in seconds, so two
  clicks within one second hit it. Exactly the problem we solved with
  `nextOwnerTimestamp`.
- **Password candidates are not signature-checked on ingest** — a badly signed
  candidate is stored and returns `{:ok, :pending}`; it never reaches the
  production table, but it is never removed either.
- **There is no garbage collection** for `review_password_candidate` or for
  unsigned right candidates. The function `delete_stale_candidates/1` exists but
  nothing calls it.
- **Comments are not designed** — deliberately deferred.
- **Origin metadata** — the table holds only `name`; no address, no category, no
  geo search. An open question in the spec.
- **Origin discovery** — only "show everything".
- **The review version chain** — `parent_sign_hash` is stored and update works,
  but nothing validates the chain and no client writes edits.

## What is reused from our code

**The data layer, unchanged.** `src/lib/data/` knows nothing specific about
dialogs: `sendMutationsAndAwaitShape`, the barrier, the outbox and the
transient/permanent classification work with any `relation`. Adding reviews means
new collections in `collections.ts` following the same two patterns:

- `origins` — a global shape over the whole table, like `user_cards`;
- `review`, `review_list`, the rights and the candidates — shapes filtered by
  `where origin_hash = '…'`, like the dialog ones by `dialog_hash`. They need
  their own `assertOriginHash` (the format is the same `^u_[0-9a-f]{128}$`, since
  an origin is a `user_hash`) and an LRU registry of warm origins modelled on
  `getDialogCollections`.

**The KEM wrapper — same code, different salt.** The rights envelope derives its
AES key exactly as our dialog keys do; only the domain string differs:

| | salt | info |
|---|---|---|
| dialog key (we have it) | `buckitup/dialog-wrap/v1` | `wrap` |
| rights envelope (needed) | `buckitup/review-right/v1` | `wrap` |

So `DialogCrypto.wrapSenderMsgKey` / `unwrapSenderMsgKey` should be parameterised
by the salt rather than rewritten. On the server the salt lives in
`Chat.Data.ReviewRightEnvelope`, one place for everyone who wraps and unwraps; a
divergence here means a guaranteed undecryptable envelope.

**`nextOwnerTimestamp` is mandatory.** The backend has a recorded defect: equal
`owner_timestamp` values pass locally but are rejected by peers, and second-level
granularity makes two clicks in one second ordinary. Our `max(now, prev + 1)`
formula closes it. Separately: in `post` and `pre` modes the revoke version's
timestamp must be strictly greater than that of the version with the password.

## What has to be written from scratch

**The review crypto.** `review_password` is a random AES-256 key per review, and
the content is encrypted with it. The plaintext shape is
`[rating, placeholder, content]`, where `placeholder` is filled with a random
string (20–200 characters) for a review without text, so that the ciphertext size
cannot distinguish "rating only" from "rating with text". That is a privacy
requirement, not cosmetics.

**A background participant in the handshake.** Promotion is two-phase, and the
second phase is an action of the *author's client* rather than of the user: the
server puts an unsigned right candidate into the shape, and the client has to
read it, verify the KEM wrapping and send a signature. By then the user may have
closed the review screen. So a watcher living outside the screen is needed —
essentially the pattern we already use to drain the outbox on login and on
`online`.

**`review_list_password`** — one per author, kept in User Storage (a write-once
slot) and distributed to contacts as a dialog message of a special type. It needs
a client-side contact list, which we have and the backend sandboxes do not, which
is why that part is stubbed there with a pick from a user directory.

**Screens.** An origin directory, origin creation, a review composer with a
rating, a venue's review feed, a moderation queue for the origin identity, and
reading contacts' reviews. Plus a "write to the venue" entry point — which opens
an ordinary dialog and needs nothing new.

## The order I would suggest

1. **Reading public reviews** — the `origins` + `review` +
   `review_public_passwords` collections, decryption, the feed. No writing, no
   moderation; verifiable against the already-working `/electric/origin_reviews`.
2. **Writing a review in `none` mode** — the shortest write path: the review plus
   a password candidate, the server publishes by itself, no handshake.
3. **The `post` and `pre` modes** — the two-phase handshake and the background
   watcher.
4. **Moderation** — the queue for the origin identity.
5. **Contacts** — `review_list`, distributing `review_list_password`, reading
   other people's.

The first two items give a working feature without the hardest part.

## Questions that run into product

1. **Origin metadata** — the table holds only `name`. No address, no category, no
   coordinates. Any meaningful venue screen will need the table extended, which
   is backend work.
2. **Discovery** — currently only "show all origins". Search and filtering are
   backend work too.
3. **Comments** — not designed, deliberately deferred. If they are in scope, the
   place to start is the design, not the UI.

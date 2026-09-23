# What the backend can already do and the interface cannot

A document for the designer: the messenger features the protocol and the server
already support but the client does not have. For each one — what the user sees,
what the server provides, and which decisions the drawing needs.

Source: `Buckitup-chat/chat`, `docs/pq/**`. Reviews are in a separate
document — [reviews-frontend-context.md](reviews-frontend-context.md).

**What the client has today:** text messages, editing your own message, emoji
reactions, read confirmation on a button, the contact and dialog lists, a
profile with an avatar, account creation and recovery. Everything below is
missing.

**Three degrees of readiness** are marked on every item:

- **[ready]** — the server supports it fully, only the interface is missing;
- **[foundation]** — the primitives exist, but part of the logic has to be
  designed;
- **[needs backend]** — requires server work, too early to draw.

---

# 1. Message content types

Today a message can only be text. The protocol describes a single envelope with
any kind of content inside, and the server knows nothing about that kind — it
sees an encrypted blob. Which means a new content type requires no server change
at all.

## 1.1 Composed message [ready]

One message can hold several elements in a row — text, then a picture, then more
text. In Telegram this is the caption under a photo; here the model is wider: an
arbitrary sequence.

**For the designer.** What a bubble with several elements looks like. Where the
caption sits relative to the media. What happens with long text and a wide
picture. How a composed message appears in the dialog-list preview.

## 1.2 Quoting and replying [foundation]

The protocol reserves the content type `{"quote": …}` for replies. The field
format is not fixed yet, but the mechanism is an ordinary element inside a
composed message — a reply is "quote + my text" in one bubble.

**For the designer.** How a quote looks inside the bubble (a bar on the left,
the author's name, shortened text). What tapping the quote does — jump to the
original with a highlight. What to show when the original is deleted or has not
arrived yet. How quoting a picture or a file looks rather than text. Input: how
a message is chosen to reply to (swipe, context menu).

## 1.3 Images [ready]

Two variants, chosen by the sender according to size:

- **small** (under 500 KB) — the bytes live inside the message itself, arrive
  with it and render instantly;
- **large** — kept as separate encrypted chunks, the message carries only a
  reference and a key.

In both cases the message carries the **aspect ratio** and a **thumbhash** — a
tiny fingerprint that draws a blurred preview before the file itself arrives.
Exactly the blur Telegram shows under a download.

**For the designer.** What the space for a picture looks like before it loads: a
blurred preview in the right proportions with a progress indicator over it. The
maximum size of a picture bubble. Opening it full screen. What to show when the
picture is unavailable (see §2.4).

## 1.4 Video with progressive playback [ready]

Video starts playing after the first chunk is decrypted rather than after the
whole file arrives, and supports **seeking to an arbitrary point** — the browser
requests the range it needs and the client decrypts it on the fly. As with
pictures, there is an aspect ratio and a thumbhash for the preview frame.

What there is not and will not be: adaptive quality, server-side transcoding,
live broadcasts — the server fundamentally cannot look inside the file.

**For the designer.** The video preview in the feed: thumbhash, duration, a play
button. The player — embedded in the bubble or full screen. The seek bar and how
the already-downloaded part is shown on it. The "buffering" state.

## 1.5 Files [ready]

Two variants again — small inside the message, large separately. The message
carries the name, size, MIME type and creation date of the file.

**For the designer.** A file bubble: an icon by type, name, size, state. The
actions — download, open, share. How a file currently uploading looks, and one
that did not finish.

## 1.6 Several attachments in one message [foundation]

A composed message allows attaching several files at once. The protocol has no
notion of an "album" — that is purely an interface construct.

**For the designer.** A grid of several images in one bubble (2, 3, 4+ pictures,
as in Telegram). The carousel when opened full screen: paging, a "3 of 7"
counter, a caption under the frame. A mixed set — pictures and documents
together. A limit on the count.

---

# 2. Working with files

The biggest gap: the client today can neither send nor receive files, although
the protocol is worked out in detail.

## 2.1 Upload with progress [ready]

A large file is cut into 4 MB chunks, each encrypted and sent separately. So the
progress is known exactly — not "please wait" but a count of chunks sent out of
the total.

**For the designer.** The progress indicator in the message bubble. Cancelling
an upload. What to show when several files are sent at once — a combined
progress or one per file. What happens when the user leaves the dialog screen
mid-upload.

## 2.2 Resuming after an interruption [ready]

An interrupted upload resumes: the client asks the server which chunks it
already has and sends the rest. The file does not start over — even after a tab
reload or losing the network halfway.

**For the designer.** What a paused upload looks like. Whether it resumes
automatically when the network returns or on a button. What to show after an app
restart when there are unfinished uploads. The message that unfinished uploads
are deleted after 48 hours.

## 2.3 Downloading [ready]

Symmetrical: the file is assembled from chunks, each verified by hash. The
progress is just as exact.

**For the designer.** Download progress in the bubble. The difference between
"downloading" and "already on the device". Viewing without downloading (pictures,
video) against explicit saving (documents).

## 2.4 File availability state [ready] — the important difference from Telegram

A node may hold **part** of a file's chunks. That is not an error but the normal
state of a network without internet: the file travels from node to node
gradually. The server gives an honest counter of "so many of so many chunks
present".

The possible states:

- **available** — every chunk is there, it can be opened;
- **partially available** — some chunks are there and more are coming; the share
  is known;
- **known but unavailable** — the message and metadata arrived, the file did
  not;
- **deleted** — the author deleted it, only the mark remains.

**For the designer.** This is the key screen for an offline-first product. How to
show "the file is coming, but not now" without alarming the user. The
completeness indicator. The difference between "not downloaded because there is
no network" and "the author deleted it". The option to request a priority fetch.

---

# 3. History and edits

## 3.1 Message revision history [ready]

Every edit is kept: old versions live in a separate append-only table and the new
version references the previous one. The full chain of edits is available and
cryptographically attested — so it is possible to show not just "edited" but what
exactly was there before.

**For the designer.** The "edited" mark on the bubble. How to open the revision
history. What that history looks like — a list of versions with dates, or a
comparison. Whether to show the history of other people's messages (the protocol
allows it). Reactions bind to a specific version: how to explain that a reaction
on the old version did not carry over.

## 3.2 Deleting a message [foundation]

Deletion is a mark and empty content, not a row disappearing. The other side sees
that a message existed and was deleted.

**For the designer.** What a deleted message looks like in the feed. The
difference between "deleted for me" and "deleted for everyone" — the protocol
currently knows only the second. What happens to reactions and quotes pointing at
a deleted message.

## 3.3 Reactions [partly there]

They work, but bind to a message version: after an edit a reaction on the old
version is not shown, and a new reaction "moves" to the current one.

**For the designer.** The look of the reaction group under a bubble: emoji, a
counter, your own highlighted. Who reacted — a list on tap. Choosing an emoji.
How to explain the behaviour around edits.

## 3.4 Read confirmation [partly there]

It is sent only on an explicit action and is **irreversible** — it cannot be
taken back. That is a deliberate product decision, not a technical limitation. It
binds to a specific version: an edit calls for a new confirmation.

**For the designer.** How to explain the irreversibility before the tap. What a
confirmed message looks like to the author and to the reader. The difference from
Telegram's familiar ticks — here it is a conscious act, not automation.

---

# 4. Message order and divergence

A peculiarity of the product: nodes can work without internet and sync later.
That produces states an ordinary messenger does not have.

## 4.1 Simultaneous sends (divergence) [foundation]

Two people wrote at once without seeing each other's messages. The protocol
records this explicitly: the messages share an ancestor and neither references
the other. The spec says outright that showing divergence is the interface's job.

**For the designer.** Whether to show divergence at all or quietly order by time.
If shown — how: a separator, a mark, a branch. What "convergence" looks like when
the next message sees both branches.

## 4.2 A message arrived before its predecessor [foundation]

During catch-up sync a message can arrive before the one it references. Such a
message cannot be shown as an ordinary one — its context is not loaded yet.

**For the designer.** The "waiting for context" state. Show it greyed in the
feed, hide it until the context loads, or set it apart. What to do if the context
never arrives.

## 4.3 Send states [foundation]

Sending passes through several distinguishable states: saved locally → sending →
accepted by the server → delivered to the peer. Plus errors: temporary (we retry)
and final (it will never be accepted).

Deleting adds a fifth state: a retraction the peer's device has confirmed.
Its mark is a tombstone rather than the delivered double check, because what
arrived was the deletion and not the message.

**For the designer.** The marks for each state. What the user sees after a reload
with unsent messages. What a finally rejected message looks like and what action
it offers. An "N messages unsent" indicator in the header.

---

# 5. Dialogs and contacts

## 5.1 Contacts' avatars [needs backend]

Your own avatar exists, other people's do not: theirs is encrypted with the
owner's personal key and there is nothing to decrypt it with. It needs a product
decision and server work.

**For the designer.** For now — what the placeholder instead of an avatar looks
like (generated today). Worth designing for both outcomes.

## 5.2 Group chats [needs backend]

The room specification is not written. The client has room screens, but there is
no protocol behind them. Drawing is premature.

## 5.3 Features that need no server [foundation]

All of this can be done on the client, because messages are decrypted locally
anyway and personal settings live in user storage:

- **message search** — local, over the decrypted text;
- **drafts** — keeping what was typed but not sent;
- **pinned dialogs and messages**;
- **forwarding** — technically sending the same content into another dialog;
- **favourites / notes to self**;
- **notification settings**.

**For the designer.** Priority: which of these belong in the first version.
Search — a separate screen or a field in the header. Forwarding — choosing the
recipient, marking the source.

---

# 6. What the protocol does not give — do not draw it

So that no work is wasted:

- **a "typing…" indicator and an "online" status** — explicitly outside the
  protocol's scope; the product does not assume a permanent connection;
- **adaptive video quality, transcoding, live broadcasts** — the server cannot
  look inside an encrypted file;
- **mentions with a notification** — there is no mechanism;
- **group rooms** — the specification is not written;
- **"delete for me only"** — the protocol knows only deletion for everyone;
- **branching reply threads** — the version chain is linear, and a discussion
  tree would need a different structure.

---

# 7. Proposed order of work

By return per unit of effort:

1. **Files and pictures in full** (§1.3, §1.5, §2) — the most visible gap; a
   messenger without attachments looks unfinished. Availability states belong
   here too — the thing that sets this product apart.
2. **Composed messages and quoting** (§1.1, §1.2) — a basic expectation of a
   conversation.
3. **Send states and offline** (§4.3) — mostly working under the hood already,
   the display is what is missing.
4. **Video** (§1.4) — a substantial piece in its own right.
5. **Revision history** (§3.1) — a rare scenario, but one that distinguishes the
   product.
6. **Divergence and waiting for context** (§4.1, §4.2) — needed once real nodes
   without internet appear.

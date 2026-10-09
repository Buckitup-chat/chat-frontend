# Creating a community backup — screens for the designer

Phase 7.2 of [backup-recovery-plan.md](backup-recovery-plan.md). This document
describes what the owner does, what the screens must say and which decisions the
drawing needs. Engineering details stay in the plan and the chat repo's specs
(`docs/pq/reqs/pq_recovery_shares`, `pq_recovery_services`). The drawing does
not have to show them.

## What a community backup is, in one paragraph

The account's keys are sealed and split in two. The **friends' half** is cut
into pieces, and one piece goes to each **guardian**, a contact who agreed to
help. The **node half** goes to a few independent servers called **nodes**. To
get back in, the owner asks enough guardians to confirm on a call that it is
really them. After a waiting period the account opens again. During that
waiting period the owner, from any device still in their hands, can stop an
attempt that is not theirs. Neither half alone opens anything, and no single
guardian or node can open anything.

The user does not need any of the words "Shamir", "stealth", "contract" or
"relayer". On screen these are **guardians**, **pieces**, **nodes**, **waiting
period** and **network fee**.

## Where it starts

The **Security & Recovery** page (`Page_Backup_Dashboard.vue`) has a disabled
"Blockchain Recovery — Coming Soon" card. That card becomes **Community
backup**. It has three states:

| State | Card says | Main action |
|---|---|---|
| No backup | What it is, in two lines; how many guardians have agreed so far | **Create backup** (disabled until 2 have agreed, with the reason shown) |
| Backup in progress (a run was interrupted) | "Your backup was not finished" | **Continue** |
| Backup exists | The health line: "3 of 4 guardians hold a piece · 2 needed" | **Manage** (the roster, phase 7.4) |

**For the designer.** What the card looks like in each state. The health line
is the most important number in the whole feature ("is my backup real"), so it
must be readable at a glance, with a warning style when the count of holders
drops toward the number needed.

## Before the screen: guardians must agree first

A contact becomes a guardian candidate only after accepting an invitation in
their chat. That flow already exists: the 🛡 button in a chat with a contact
confirmed in person sends the invitation, and the contact sees a card with
Accept / Decline. The backup screen lists only contacts who accepted. It also
shows the others, so the owner understands why they are missing.

| Contact's state | Shown as | Can be picked |
|---|---|---|
| Accepted | Name, avatar, "agreed" | Yes |
| Invited, no answer yet | "waiting for answer" + **Remind** (opens the chat) | No |
| Declined or withdrew | "declined" | No |
| Confirmed contact, never invited | "not asked" + **Ask** (sends the invitation) | No |
| Not confirmed in person | Hidden from this list; a footnote explains that only contacts confirmed in person can be guardians | No |

**For the designer.** The empty state when nobody has agreed yet, which will be
most users the first time. It should lead into inviting rather than show an
empty list.

## Screen 1 — Simple

The owner picks guardians. Everything else has a sensible default, shown as a
short summary that can be expanded.

| Setting | Default | What the summary says |
|---|---|---|
| Guardians | — (the owner picks; at least 2, 3 or more recommended) | "4 guardians" |
| Pieces needed to recover | A majority of the guardians, at least 2 | "any 3 of them can help you back in" |
| Spare pieces | 2 | "2 spare pieces kept for later" |
| Nodes | One per operator, up to 5, a majority needed | "3 of 5 nodes needed" |
| Waiting period before access returns | 3 days | "you have 3 days to stop an attempt that is not yours" |
| Time to finish once the wait is over | 7 days | (shown only in Advanced) |
| Network fee | Paid by BuckitUp's service | "free" |

Rules the screen enforces, each with a plain message:

- **Exactly 2 guardians** is allowed, with a warning: "If you lose either of
  them, the backup cannot be used." The owner confirms it.
- **One guardian** is not possible; the button stays disabled with the
  reason.
- **Fewer than 3 node operators available**: the screen says how many more are
  needed and offers **Add node**, with two sources: a contact's BuckitUp
  device, or a URL typed in. It cannot continue until the count is reached.

**For the designer.** The guardian picker (multi-select with avatars, and the
running "any N of M" sentence as the main feedback). How the defaults summary
collapses and expands. The two-guardian warning.

## Screen 2 — Advanced

Reached from "Change settings" on screen 1. Every row of the table above
becomes editable, within these bounds:

| Setting | Bounds | Message when out of bounds |
|---|---|---|
| Pieces needed | 2 … number of guardians | — (the stepper stops) |
| Approvals needed | at least the pieces needed, at most the guardians | "Approvals cannot be fewer than pieces needed: an honest recovery could never collect enough pieces." |
| Spare pieces | 0 … a few | — |
| Waiting period | 10 minutes … 365 days | — |
| Time to finish | 1 hour … 30 days | — |
| Nodes | Add or remove; node count needed is at least 2 and at most the number of nodes | see "Nodes" below |
| Network fee | BuckitUp's service · another service (URL) · pay yourself | see "Fees" below |

"Approvals needed" is a separate number from "pieces needed" only in Advanced.
In Simple mode the two are the same.

### Nodes

A node is shown with its operator (an account name, or "BuckitUp"), its address
and its status (online, or offline since when). Rules, each refusing with a
message:

- **One operator cannot hold enough nodes to recover alone**, including
  BuckitUp: "These nodes belong to too few people: N of them are run by ….".
- **A node run by one of the chosen guardians is not allowed**: "Ivan is a
  guardian and also runs this node. One person would hold both halves."
- **A node must have a stable https address.** Local network addresses (a
  device at home reachable only over Wi-Fi) are refused, because the backup has
  to work for years and from anywhere.
- A node whose operator has not signed it yet is shown as "not ready" and
  cannot be picked.

**For the designer.** The node list and the **Add node** flow (from a contact's
device / by URL), including what is shown while a typed URL is being checked
and why it was refused.

### Fees

- **BuckitUp's service (default):** nothing to show but "free".
- **Another service:** a URL field.
- **Pay yourself:** shows the owner's own network address and its balance, with
  a copy button. The estimated fee is shown **before** anything is published.
  If the balance is too low, the button is disabled and the address is shown to
  top up.
- A large backup (more than 32 pieces, or above the service's fee limit) cannot
  use the free service. The screen says so and switches to "Pay yourself".

## Screen 3 — Alerts (required, or skipped explicitly)

A backup without alerts is dangerous. Anyone who collects enough guardians
could try to get in, and the owner would not know to stop them. So the owner
must either set up at least one alert channel or explicitly skip it. The flow
cannot finish silently.

- Channels: **in the app** (always on), **Telegram** (the app shows a line to
  send to the bot), **webhook** (URL, for email or SMS gateways).
- **Skip** asks once more: "Without alerts you may not learn about an attempt in
  time to stop it." A skipped backup shows a permanent warning on its card and
  in the roster.

**For the designer.** The channel picker and the Telegram connection steps.
Phase 7.4 builds the channels; 7.2 needs this screen as the last step of setup.

## Screen 4 — Progress

After **Create**, the work runs in steps. It can take minutes, because the
network has to confirm the registration. The owner can close the app; the run
continues from the same step next time, and the card shows **Continue**.

| Step | What the user sees | Can fail with |
|---|---|---|
| 1. Preparing | "Sealing your keys and cutting the pieces" | — (local) |
| 2. Saving the sealed copy | spinner | no connection → retries |
| 3. Registering on the network | "Waiting for confirmation…" with an estimate | the service refused; balance too low (if paying yourself) |
| 4. Handing the node half to nodes | one row per node: ✓ or "retrying" | a node is offline |
| 5. Sending pieces to guardians | one row per guardian: sent → delivered → **stored** | a guardian's chat is waiting for keys |
| 6. Done | the health line | — |

Rules that shape the drawing:

- **Steps 1–2 can be cancelled; from step 3 on, the backup exists.** A failure
  after that point does not undo it. The screen offers retry, and if a node
  stays offline it offers to finish without that node, as long as enough nodes
  remain.
- **Stored** comes from the guardian's app (phase 7.3) and may arrive hours
  later. The progress screen does not wait for it. The run is done when every
  piece has been **sent**, and the roster keeps tracking stored.
- If the same account starts a backup on another device, the second device
  shows the first one's progress rather than starting over.

**For the designer.** The step list, the per-row states, and what the screen
looks like when the owner comes back to an interrupted run.

## Done → the roster

The finished state lands on the roster (phase 7.4). The roster shows:
- each guardian and whether they hold their piece;
- the health line;
- spare pieces left;
- the alert channels.

Phase 7.4 designs the roster in full. For 7.2 it is enough to have the summary
at the top.

## Texts the screens must get right

- What a guardian can and cannot do: "A guardian cannot open your account alone
  — they hold one piece of N. They help only when you ask them on a call."
- The waiting period: "If someone else starts a recovery, you have 3 days to
  stop it from any of your devices."
- Losing guardians: "If fewer than N guardians keep their piece, the backup stops
  working. You will see it here."

## Do not draw

- Network addresses of guardians. They are private by design: each guardian
  gets a fresh address per backup, and nothing should hint at it.
- The sealed copy's location, or the keys and pieces themselves.
- A "restore" button on this screen. Recovery starts from the login page
  ("Recover with friends", phase 7.5), because a person who needs it is not
  logged in.

## Readiness

| Part | State |
|---|---|
| Invitations (who agreed) | built (7.1) |
| Node discovery and checks | built (node client, 7.0) |
| Network registration through BuckitUp's service or own fee | built (7.0) |
| Sending and storing pieces | 7.2 / 7.3 |
| Alert channels | 7.4 |

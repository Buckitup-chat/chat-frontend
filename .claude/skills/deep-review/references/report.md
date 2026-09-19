# Report format

Write to a file and deliver the file. These reports get forwarded, re-read, and
worked through over days; chat scrollback does not survive that.

The report's job is to be **actionable and trusted**. Trust comes from showing
what was filtered out and what was not checked — a report that only lists
problems reads as a machine that always finds problems.

---

## Structure

### Header

Repo, branch, exact commit, range, file and line counts, date. Someone reading
this in a week must be able to reproduce the exact scope.

### Method — three or four lines

How many agents, on which axes, that they had no shared context, that a
second adversarial pass tried to disprove each finding, and how many claims that
pass removed. Then, immediately, the **honest limitation**: if the tests could
not be run, say so here, not in a footnote. Everything downstream is read
differently once the reader knows.

### Summary table

One row per finding: number, one-line title, severity, status. Statuses that
carry information:

| Status | Meaning |
|---|---|
| доказано исполнением | settled by running code, not argument |
| подтверждено | traced end to end in the source |
| частично | mechanism real, claimed severity or scenario wrong |

Sorted by severity. A reader who stops here should know what to do next.

### Findings

Most severe first. Each one:

- **A title that states the defect**, not the area. "`scannedTo` advances past
  rows that failed to decrypt" — not "issue in the alert scan".
- `file:line`, and the code quoted. Four lines, not forty.
- **The failure scenario as a story**: who does what, in what state, and what
  they see. This is the part that gets a fix prioritised.
- **Why the tests are green**, when they are. Naming the mock that hides a
  defect is often worth more than the defect.
- **The minimal fix.** If it is one line, say it is one line.

Where something was proven by execution, quote the output verbatim:

```
0 leaves   root changed -> YES
1 leaf     root changed -> no
2 leaves   root changed -> YES
```

A reader who sees that does not have to follow the argument.

### Refuted

The claims that did not survive verification, and why. Keep this section even
when it is one item.

It is the only evidence that the other findings were filtered. A reviewer who
never refutes anything is a reviewer who is not checking.

### Test quality

When the tests are weak, separately from the code findings: which test asserts
nothing and what line would have to break for it to fail; which mock encodes a
false assumption; which branches nothing exercises, named.

### Recommendation

Merge / do not merge, and **the shortest path to mergeable**. Order the blocking
items and say which are one-liners. Distinguish "must fix before merge" from
"file in the backlog" — a report where everything is urgent gets triaged as a
whole and ignored as a whole.

Say plainly what is good. If the hard part is right and the problems are in the
wiring around it, that changes how the team reads the rest.

### What this review does not cover

- What could not be run, and why.
- What was out of scope (other commits, the backend, anything unreadable from
  here).
- What was judged by reasoning rather than measurement.

This section is what makes the rest credible. Write it every time.

---

## Write for a reader with no context

The report is a standalone technical document, not a reply. Someone who has never
seen the conversation that produced it must be able to act on it.

This is the rule most often broken, because the review is usually produced inside
a dialogue and the dialogue leaks into the file. It must not.

- **Never answer the conversation in the document.** No "as discussed", no "the
  scope question you raised", no explanation of why a particular axis was chosen,
  no narration of the review's own process beyond the three-line method note.
- **No preamble.** Open with the header and the summary table. Do not introduce,
  frame, or set up.
- **Every sentence carries a fact a reader needs.** Cut anything that exists to
  connect, soften, or restate. If a paragraph does not add a file, a line, a
  scenario, a number or a decision, delete it.
- **State the finding, not the journey to it.** "`scannedTo` advances before the
  decrypt and survives the `continue`" — not "tracing this revealed that...".
- **No meta-commentary on the round.** Not "this is the best round so far", not
  "the trend is good". A verdict on the code, not on the process.
- Findings are about code, not about whoever wrote it. "The carrier row is
  counted in the comparison but was not counted when the root was computed" —
  never "the author forgot".
- Uncertainty goes inside the finding it qualifies, not into a blanket
  disclaimer. "Reachable by a misbehaving peer plus a backend that accepts a
  mismatched column, not by the server alone."

Length follows content. Three findings means a short file. A long report is
justified only by having many distinct, concrete findings — never by explanation.

Conversational material — why a scope was chosen, what surprised you, what the
routine itself got wrong — belongs in the chat reply, not in the file.

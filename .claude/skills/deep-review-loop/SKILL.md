---
name: deep-review-loop
description: Drive a branch to zero confirmed critical/high defects by alternating deep review and fixes, review-of-fixes each round, with explicit stop conditions. Run on request for a feature branch or release candidate. Requires the deep-review skill.
argument-hint: "<branch> [--base main] [--max-rounds 5] [--budget-usd 60]"
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Agent, Skill, TaskCreate, TaskUpdate
---

# deep-review-loop

Alternate review and fixes until no confirmed critical or high defect remains.

Each round's fixes introduce new defects — that is the normal case, not a sign of
carelessness. The loop exists because one review-and-fix pass is not convergence;
it is one step of it. It also has to terminate, so the stop conditions below are
not optional.

Defaults: `--max-rounds 5`, `--base main`. State the budget before starting.

---

## Gate 0 — CI must be green before the first review

Check the project's CI status on this branch before anything else.

If it is red, fix that first and commit, whatever the failure is. A pipeline that
runs `lint → test → build` in order and dies at step one has not run the tests
at all, so nothing downstream can be trusted and no "verified locally" claim in
any commit message has been confirmed. This costs minutes and is the precondition
for everything the loop does afterwards.

If CI cannot be consulted, run the checks locally instead. Do not start the loop
on an unverified baseline.

---

## The round

### 1. Review

Round 1: invoke `deep-review` on the full range (`<base>...<branch>`).

Round 2+: invoke `deep-review` in its **review-of-fixes** mode on the previous
round's fix commits only. Re-reviewing the whole branch re-derives what is
already known and misses what the fixes broke.

### 2. Triage

From the report, split findings:

- **Blocking** — confirmed (not partial, not refuted) severity critical or high.
  These are what the loop is for.
- **Everything else** — collect into a backlog file; do not fix in the loop.

A finding the review's own adversarial pass refuted is not fixed, not argued
with, and not carried forward.

### 3. Fix

Fix blocking findings only. Per fix:

- The smallest change that closes it. Refactoring adjacent code is how a fix
  round becomes a defect round.
- A regression test that **fails without the fix**. Verify by actually reverting
  the fix and watching the test go red — then restore it. An asserted-but-unchecked
  "this test covers it" is the single most common way a defect survives a round.
- If the test needs a mock, the mock must honour the real contract (a write is
  readable after it lands; a key the production code can actually derive). A mock
  that does not is how a green suite hides the defect it was written for.

**Fixes that change a committed value** — a hash domain, a serialisation, a
persisted shape, a wire format — must change the corresponding version label in
the same commit, and pin the new bytes in a golden vector. Bytes and label live
in different lines, and updating only one is a defect class this loop has
produced more than once.

### 4. Verify

Run lint, tests and build. All green, no new warnings in touched files.

Then check reachability of each fix: find the production entry point and trace to
the effect. Correct code wired to nothing is the recurring failure mode here; it
reads as done and a regression test written against a mock will confirm it.

### 5. Commit

One commit per round, or one per finding — either, consistently.

**The commit message must not claim more than was verified.** If a fix has no
test, say so. If a rationale describes a scenario the code cannot reach, drop the
rationale. The next reviewer reads the message as a map of what was checked, and
a wrong map costs more than a missing one.

### 6. Loop

Return to step 1 with the new tip.

---

## Exit

**Success** — a round produces no confirmed critical or high finding. Report:
rounds spent, findings closed per round, the backlog file, and what remains
unverifiable (checks that could not run, code owned by another repo).

**Stop and escalate to a human** on any of these, immediately, without starting
another round:

- A finding reported fixed in an earlier round **reappears**. Either the fix was
  not reachable or the diagnosis was wrong; another round will not discover which.
- A round **closes fewer high findings than it opens**. The fixes are costing
  more than they buy, and the design is the problem, not the code.
- A fix requires a **protocol, format or dependency change**, or touches auth,
  crypto or a persisted shape in a way that invalidates existing data. Prepare
  the change, do not apply it.
- `--max-rounds` reached, or the budget is spent.
- A blocking finding has **no minimal fix** — the correct repair is a redesign.

Escalation is a normal outcome, not a failure. Report where it stopped, what is
still open, and what the decision is that a person needs to make.

---

## Recurring defect patterns

Check these explicitly each round. Every one has cost a full round in practice.

| Pattern | What to check |
|---|---|
| Correct code that never runs | Find the production entry point; trace to the effect. A watcher whose dependency never invalidates, a writer nothing calls. |
| Bytes changed, label did not | Any change to a hash, encoding or persisted shape — did the version constant move with it, and is there a vector pinning the bytes? |
| Test that proves nothing | Name the single production line whose reversion turns it red. If you cannot, it asserts nothing. |
| Mock that lies | Does the fake honour the real contract, or does it make the failure impossible to express? |
| Fix on one of two paths | Grep every call site of every changed symbol. |
| Commit message ahead of the code | Does each claim in the message correspond to code you can point at? |
| Half-covered derivation | A value computed by two functions in two files — pinning one and leaving the other closes half the class. |

## Cost

A full round on the strongest model runs 600k–900k subagent tokens for the review
alone, plus fixes. Five rounds is real money. Announce the estimate before the
first round and stop at the budget rather than past it.

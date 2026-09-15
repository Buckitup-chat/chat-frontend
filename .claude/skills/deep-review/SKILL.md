---
name: deep-review
description: Deep code review of a branch or diff by parallel context-free subagents, each on its own axis, followed by an adversarial pass that tries to disprove every finding. Use for a feature branch, a PR, or a release candidate — anywhere a wrong "looks fine" is expensive. Not for a quick look at a small diff.
argument-hint: "[branch or commit range] [--base main]"
allowed-tools: Read, Grep, Glob, Bash, Agent, Write, TaskCreate, TaskUpdate, AskUserQuestion
---

# Deep review

A normal review reads a diff and reports what it noticed. This one does three
things a single pass cannot:

- **Fans out** across axes into subagents that never saw this conversation, so no
  agent inherits another's framing or the author's explanation of intent.
- **Fans in adversarially** — a different agent is paid to disprove each finding,
  because a lone reviewing model reliably produces confident inventions.
- **Settles what it can by execution** rather than argument.

Only what survives all three reaches the human.

Read `references/axes.md` for the axis catalogue and prompt template, and
`references/report.md` for the output format, before step 3.

---

## Step 0 — Resolve the scope. Do not skip this.

This step has caught more real problems than any other, because the range the
human names is often not the range they mean.

```bash
git fetch --quiet origin
git merge-base <base> <branch>                      # where it actually diverged
git log --oneline <base>..<branch> | head -50
git rev-list --count <base>..<branch>
git diff --stat <base>...<branch> | tail -5         # THREE dots
```

Two dots and three dots are different questions. `a..b` is "in b, not in a"; the
diff you want is `a...b`, against the merge base — otherwise work merged into the
base since the branch forked shows up inverted in the diff.

Then judge the shape of it:

- **Does the commit count match what you were told?** "Five commits" against a
  branch that is 115 commits ahead of `main` means the feature sits on a stack of
  unmerged work. Reviewing all of it answers a question nobody asked, at ten times
  the cost and a tenth of the depth.
- **If the range looks wrong, stop and ask** which range is meant, with the real
  numbers in front of the user. In an unattended run, pick the narrowest range
  that matches the stated description, and say so at the top of the report.
- Find the true feature base — often the parent of the first feature commit, not
  the base branch:

```bash
git branch -r --contains <first-feature-commit>^    # which branches already hold the stack
```

Check out the reviewed tip so the agents read the code as it will land:

```bash
git checkout --quiet <tip>
git diff <true-base> <tip> > /tmp/review.diff
```

Also read whatever the repo says about itself — `CLAUDE.md`, `README`, `docs/`,
`package.json` scripts, the CI config. Agents need to know the project's own
conventions to judge a deviation from them.

## Step 1 — Task list

Create tasks for: scope, fan-out, verification, report. The user watches progress
here, and a long review is otherwise opaque.

## Step 2 — Run the project's own checks, or read them as a spec

Run whatever the repo runs on itself — typically lint, tests, build. A red suite
reframes everything downstream, and it is the cheapest finding available.

**If they cannot run** — no network, no lockfile, a blocked package registry —
do not fake it and do not skip the step. Do two things instead:

1. **Check CI.** The project already runs these checks somewhere. Look at the
   workflow file for what runs and in what order, and look at the last runs on
   this branch. A branch whose CI has been red for several commits means the
   tests behind the failing step have not run at all, and every "verified
   locally" claim in those commit messages is unconfirmed. That is a finding in
   its own right, usually a high one, and it costs one page fetch.
2. **Read the linter config as a specification** and check the new code against
   it by hand. Which rules are errors, which are demoted to warnings, what the
   project says about new code. Then grep the diff for the error-level rules that
   are mechanical to check — a forbidden construct, a banned import, a naming
   rule. This catches what the tooling would have caught.

Note in the report's limitations section exactly which checks did not run and
why. Every claim about tests then rests on reading, and the reader is entitled
to know that.

## Step 3 — Fan out

Launch every axis agent **in a single message**, as parallel `Agent` calls with
`subagent_type: review-axis`. Sequential launches waste wall-clock for nothing.

Four axes is the working default. Pick from `references/axes.md` by what the diff
actually touches: no crypto in the diff, no crypto axis. More than six axes buys
overlap, not coverage.

Model per axis: the agent definition pins `opus`; override to `model: "sonnet"`
in the Agent call for the cheaper axes — tests-of-tests and performance — and
keep opus for correctness, integration, security and every verifier. Roughly
halves the cost of a round for a small loss of depth exactly where depth
matters least. `references/axes.md` marks the sonnet-eligible axes.

Each prompt must carry, in full, because the agent knows nothing else:

- the absolute repo path and the checked-out commit;
- the diff range **and the command to regenerate it**;
- the specific files and line counts its axis owns;
- the axis, spelled out as concrete questions rather than a one-word label;
- the evidence standard (`file:line` + concrete failure scenario + minimal fix,
  drop what cannot be made concrete);
- permission to read the whole repo, and the instruction to judge only the diff;
- an explicit "if your axis is clean, say so plainly".

Name real files and real symbols in each prompt. A prompt that says "review the
store" produces a review of nothing in particular.

## Step 4 — Verify adversarially

Collect every claim. Group them into two or three disjoint sets and launch
`review-verifier` agents in parallel, one per set.

Give each verifier the claim **restated in full** — its mechanism and its claimed
consequence — not a pointer to it, and not the reviewer's prose. Instruct it to
disprove, and tell it that refuting is a success.

Weight the verification by risk, not by how confident the claim sounded:

- A claim three agents found independently is probably real, but its *severity*
  is often wrong — verify the blast radius, not the existence.
- A claim one agent found alone is where inventions live.
- A claim that a fix is present is not a claim that the fix runs. Verify
  reachability separately: find the production entry point and trace to the effect.

## Step 5 — Settle by execution

For anything that can be decided by running code, run it. In past reviews this
turned three arguable claims into proven ones and killed a fourth:

- Reimplement a hash pre-image and search for a collision.
- Recompute a commitment under the old and new code and diff the results.
- Run a regex against the values the code actually generates.
- Reproduce a framework behaviour (reactivity, proxying, sorting) in a few lines.

Keep these scripts in the scratchpad and quote their **output** in the report. A
reader who sees `IDENTICAL PREIMAGE -> true` does not need to follow the argument.

## Step 6 — Check whether the tests test

Read the new tests as an adversary, not as documentation:

- Would this test still pass if the implementation were gutted? Say which line
  would have to be deleted for it to fail — if you cannot name one, it asserts
  nothing.
- Does a mock encode an assumption the real dependency does not honour — a write
  that never becomes readable, a key the production code cannot derive, a plain
  reactive object standing in for something that is not reactive at all?
- Which branches of the new code does nothing exercise? Name the function and the
  branch, not a percentage.

A green suite over hollow tests is worth reporting on its own. It is also what
lets a defect survive several rounds of fixes.

## Step 7 — Report

Write the file per `references/report.md`. Deliver it as a file, not as chat
scrollback — these get forwarded and re-read.

Include the refuted claims. They tell the reader the report was filtered, and they
are the only evidence that the confirmed findings mean anything.

---

## Reviewing a round of fixes

Re-running the same review after fixes is the wrong move: it re-derives what is
already known and misses what the fixes broke. Do this instead.

1. **Verify each fix is reachable**, not merely present. Correct code that never
   executes is the most expensive failure mode here, because it reads as done and
   a regression test written against a mock will confirm it. Find the production
   entry point and trace to the effect.
2. **Hunt regressions in the fix commit itself**, as a separate agent with a
   separate prompt. Fixes made under time pressure are where regressions live,
   and a fix that touches a primitive used app-wide deserves its own axis.
3. **Re-run the executable proofs** from the previous round. That is what a
   proof is for.
4. **Check the new regression tests against the same standard** as step 6. "The
   fix carries a test" is a claim to verify, not a fact to accept.
5. Report each old finding as closed / partial / not closed, and list new defects
   separately. Severity of a new defect introduced by a fix is not discounted for
   being new.

Watch especially for a fix that changes a value while leaving the machinery that
is supposed to detect the change untouched — a bumped hash domain with an
unbumped version label, a new field with no migration. It looks like two lines in
one commit and only one of them landed.

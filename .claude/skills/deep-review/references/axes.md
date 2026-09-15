# Axis catalogue and prompt template

Axes exist to stop agents from covering the same ground. Pick by what the diff
actually touches. Four is the working default; beyond six you buy overlap.

Each axis below gives the questions to paste into the agent prompt. Replace the
generic nouns with the real files and symbols from this diff — a prompt that says
"review the store" produces a review of nothing in particular.

---

## Correctness and logic

The default first axis. Owns the largest changed file.

- State machine and data-flow errors: wrong transitions, states that cannot be
  left, half-updated state after a failure.
- Race conditions, ordering assumptions, reentrancy, stale closures, async
  interleaving, un-awaited work whose result is used.
- Off-by-one, boundary and empty-collection cases; null/undefined paths.
- Incorrect merge/dedup/sort logic; map and set key collisions.
- Unbounded growth: caches that never evict, listeners never removed,
  subscriptions leaked.
- Error handling that swallows a failure or reports success over one.
- Anything where the new code contradicts an invariant the surrounding code
  relies on — read the comments asserting invariants and check they still hold.

## Integration

**The axis nobody reading the diff alone can cover.** Instruct it to go outside
the diff aggressively. Usually the highest-yield axis on a mature codebase.

- For every changed signature, return shape or semantic, grep the whole repo for
  every call site. One forgotten caller using the old contract is the single
  most common real defect.
- Contract drift: does the new code assume a field, shape or ordering the
  producer does not guarantee? Check schemas, API docs, the server's types.
- Duplication and divergence: does this reimplement a rule that already exists
  elsewhere — diffing, ordering, dedup, encoding, time handling? Two
  implementations that can disagree is a defect; name both.
- Convention breaks with consequences: error handling, reactivity, persistence
  or lifecycle done differently here than everywhere else, where the difference
  changes behaviour.
- Lifecycle: are subscriptions, watchers and timers this change creates torn
  down? Compare against how sibling features do it.
- Could this break something merged earlier in the same branch?

## Security and cryptography

Only when the diff touches auth, signatures, encryption, tokens, or trust
boundaries. Otherwise drop it — a security axis with nothing to review invents.

- Canonicalisation: is every signed or hashed pre-image injective? Can two
  different logical values serialise identically? Delimiter-joined
  concatenation of attacker-controlled strings is the classic failure — test it
  by execution, not by reading.
- Coverage: is every security-relevant field actually inside the signature, or
  can an uncovered field be mutated freely?
- Verification that fails open: a `try/catch` swallowing a verification error,
  optional chaining yielding undefined-as-valid, a default that means trusted, a
  result computed correctly and then applied to the wrong object.
- Replay, rollback and equivocation across sessions, devices and peers.
- Encoding: padding, hex/binary, Unicode normalisation — mismatches that either
  break verification or let two encodings of one value diverge.
- Domain separation between distinct signing contexts.
- Trust boundary: server or peer data treated as trusted; unvalidated input
  reaching a primitive.
- Key handling: logged, persisted unsealed, or reused across contexts.

State plainly what is sound and why. "The primitives are right, the defects are
in the layer around them" is a genuinely useful conclusion.

## Tests and UI

Two halves; weight them equally.

**Tests** — read them as an adversary:

- What does each new test actually assert, versus appear to assert? Flag tests
  that assert on mocks they configured, that assert a call happened rather than
  that the outcome is right, or that would pass against a gutted implementation.
- Over-mocking: is the unit under test mocked away? Does a mock encode an
  assumption the real dependency does not honour — a write that never becomes
  readable, a key production cannot derive, a plain reactive object standing in
  for something not reactive at all?
- Name the specific uncovered branches that matter: the function, the branch,
  and why it matters. Never a percentage.
- Compare against the repo's own existing test conventions. If this feature's
  tests are weaker than the project's bar, say where.

**UI and reactivity** (adapt to the framework):

- Reactivity lost or faked: destructured reactive state, mutated props, computed
  with side effects, watchers with wrong flush timing or no cleanup, list keys
  that collide or are index-based over a reordering list.
- Lifecycle: listeners, timers and subscriptions created on mount and not
  cleaned; state that survives a context switch when it should reset.
- User-visible errors: stale data after switching context, unhandled
  loading/error/empty states, an action that silently no-ops, a modal with no
  working exit.

## Performance and resources

Add when the diff touches loops over collections that grow, network per item, or
anything on a timer.

- Work proportional to something unbounded (all users, all rows, all files)
  where it should be proportional to what is actually needed.
- Repeated network or disk I/O where one call would do; caching that does not
  cache because the entry is torn down before reuse.
- Anything on an interval — what does it cost at 100× current scale, and does it
  run while the user is looking at something else?

Distinguish a scalability defect from a correctness defect and say which it is.

## Migration and compatibility

Add whenever the diff changes a persisted shape, a wire format, a hash domain,
or a version constant.

- What happens to data already on disk or already replicated, written by the
  previous version? Trace one concrete old record through the new code.
- If a format changed, did the version marker change with it — and is the
  version actually checked on every path that consumes the value?
- Is there a migration, and what does the absence of one look like to a user?
- Can two versions coexist across devices, tabs, or a staged rollout?

---

## Prompt template

```
You are performing an independent code review. You have no prior context —
form your judgement only from what you read.

REPO: <absolute path>, HEAD checked out at <tip sha>.
<one or two lines: what this project is, its stack>

UNDER REVIEW: <what the change is>, range <base>..<tip>.
Regenerate the diff any time with:
  cd <path> && git diff <base> <tip>

Touched by your axis: <real file list with line counts>

YOUR AXIS: <name>. Concretely:
<the bulleted questions from above, edited to name real symbols>

You may and should read ANY file in the repository for context — callers,
existing patterns, related modules, the git history of touched files. But you
judge ONLY the lines this diff introduced or modified.

RULES:
- Trace the actual code. Do not speculate about what a function "probably"
  does — open it.
- Every finding MUST include file path, line number, and a CONCRETE failure
  scenario: given state X, step Y happens, result is Z. A finding you cannot
  make concrete is not a finding — drop it.
- No style, naming or "consider extracting" commentary. Defects only.
- Where a claim can be settled by running code, run it and quote the output.
- Rank by severity. Four real defects beat fifteen maybes.
- If you find nothing serious on your axis, say so plainly. A short honest
  report beats a padded one.

OUTPUT: markdown findings, most severe first. Per finding: one-line title,
`file:line`, severity (critical/high/medium/low), the failure scenario, the
minimal fix. End with a short list of what you checked and found clean.
```

# Phase 4B.3 — Controlled Implementation + Independent Verification

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

Phase 4B.1 built the doorway. Phase 4B.2 decided what an untrusted agent may
carry through it. Phase 4B.3 closes the loop: a human approves, an agent makes a
bounded change, the repository is inspected without asking the agent anything,
and a human reads the result before anything is accepted.

> **The orchestrator's account of what happened is derived from the repository,
> never from the agent.**

> **`verified` does not mean the task was accomplished. It means we looked
> ourselves, and what we found was inside what a human authorised.**

---

## 1. The loop

```
human approval  ── the ONLY thing that mints a grant
    │
    ▼
grant           ── one-shot, scoped, capability-bounded, expiring
    │
    ▼
implement       ── Claude Code (4B.1) through the tool bridge (4B.2)
    │              inside the bounded session (4A)
    ▼
verify          ── runs after EVERY attempt, without exception
    │              Phase 3 inspection of the real repository
    ▼
VerificationOutcome  ── four compartments that may disagree
    │
    ▼
review          ── deterministic findings; no model call
    │
    ▼
human review gate ── the only path to APPROVED
```

Nothing in that chain is new machinery for its own sake. The grant, the session,
the boundary, the bridge and the inspector are all previous phases, unchanged.
What 4B.3 adds is the join: a single evidence object that carries all four
accounts of one attempt, and a review gate that reads it.

---

## 2. The four compartments

`src/domain/verification.ts`. The tempting shape is `success: true`. It is wrong,
because the four things below can and do disagree — and the disagreement is the
most valuable thing this system produces.

| Compartment | Source | Trusted? | What it can and cannot tell you |
| --- | --- | --- | --- |
| **process** | the operating system | yes | The program started and returned N. A fact about a *program*, never about a repository. |
| **claim** | the agent | **no** | Narrative. An agent that says "all tests passed" has asserted something, not established it. |
| **observation** | git, via Phase 3 inspection | yes | What actually changed, established without asking the agent. |
| **verdict** | derived | — | The conclusion, from **observation only**. |

`exitCode: 0` alongside `claimsSuccess: true` alongside an empty attributable
list is a perfectly coherent outcome, and it means the agent did nothing and said
otherwise. Collapsing these into one boolean would erase exactly that.

### The verdict rule

Derived in `src/verification/outcome.ts`, in this order, from the observation and
nothing else:

1. inspection failed → `blocked` — we could not look, so *nothing* is established
2. a sensitive file changed → `sensitive_change`
3. git was used without authorisation → `git_mutation`
4. a change landed outside the approved scope → `scope_drift`
5. otherwise → `verified`

Order is precedence, not exclusivity. Every condition that holds is recorded in
the observation and raised as a finding; the verdict names the one a human should
read first. A run that commits a credential reports **both**.

The exit code and the agent's claim are recorded *beside* the verdict and
contribute nothing to it.

`blocked` is deliberately distinct from `failed`: "we looked and it was bad" and
"we could not look" are different facts, and only the second means a human is
reading a report with a hole in it.

### Git mutation is detected independently of the working tree

`git.mutate` is not a capability any Phase 4B grant carries, so **any** observed
git mutation is unauthorised and blocking.

It is detected from HEAD, the checked-out ref and the commit list — deliberately
not from the changed-file listing, because those two answers come apart in the
case that matters most:

```
agent: write file -> git add -> git commit -> exit 0
result: git status is CLEAN
```

Every dirty-file signal reports nothing there. The attempt looks identical to one
that did nothing at all. HEAD does not go quiet like that, so that is what the
observation is built on.

Two consequences worth stating plainly:

- **An in-scope file committed is still blocking.** Scope and capability are
  different questions. The human approved *paths*; nobody approved *using git*.
- **The agent’s account cannot suppress it.** A crash, a non-zero exit, or an
  explicit claim of failure changes nothing — the commit is an independently
  observed fact.

Nothing is reverted. No `git reset`, no cleanup. Detection only.

### Disagreements

Populated wherever the two accounts differ, and each one is surfaced as a finding
at the review gate:

- a file claimed as changed that the repository shows no change to
- a file that changed and the agent did not mention
- success claimed with no attributable repository change at all
- success claimed while the agent's own process exited non-zero

---

## 3. Verification runs after every attempt

Success, refusal, crash, cancellation, and the case where the agent went around
the bridge entirely. There is no path through the graph that reaches the review
gate without a `VerificationOutcome`.

Two cases were easy to get wrong and are handled explicitly:

- **A crashed or cancelled agent still gets verified.** "The agent failed" is not
  evidence that the repository is untouched — it is the case where partial work
  is *most* likely, and `partialChangesPossible` stays set to say so.
- **No inspector configured produces `blocked`, not silence.** Returning early
  with no outcome would make an unverified attempt indistinguishable, to
  everything downstream, from one that was verified and found clean.

An agent that crashes makes **no claim at all** — its report is discarded rather
than partially believed, so `claimsSuccess` is false because nothing asserted it.

---

## 4. What the human sees at the gate

`src/cli/render.ts` puts the orchestrator's verdict first and the agent's claim
beside it, labelled as a claim. The ordering is not cosmetic: a reader who sees
"the agent says it worked" before seeing what the repository shows has already
been anchored.

```
  verification:
    VERDICT: SCOPE_DRIFT
    agent claimed success: true (a claim, not evidence)
    agent process: completed, exit 0 (a fact about a program, not about the repository)
    DISAGREEMENTS (2) between the agent account and the repository:
      - agent claimed "src/invented.ts" changed; the repository shows no change to it
      - "docs/smuggled.md" changed but the agent did not mention it
    project checks: NOT EXECUTED - any claim that tests pass is unverified
```

### Sensitive attribution covers every change shape

Sensitive detection runs over the **attributed change set**, not the final dirty
listing. The union covers files that changed, were introduced, modified, removed,
restored, renamed (both paths), or carried into a commit during the run.

The shape that made this necessary is the committed one:

| Shape | Still in `git status` afterwards? |
| --- | --- |
| modified in place | yes — was already covered |
| deleted (tracked file) | yes, as ` D path` — was already covered |
| renamed (tracked file) | yes, as delete + add — was already covered |
| **committed** | **no — the tree is clean, and this escaped** |

Paths only. No sensitive content is read, hashed, diffed or recorded at any point.

### The review verdict

`pass` means something narrow: the two accounts agree, and everything observed
was inside what a human authorised. Anything else — a blocking verdict, or any
disagreement at all — yields `changes_requested`.

This withholds a **recommendation**; it decides nothing. `pass` and
`changes_requested` arrive at the same human gate, and neither can approve.

---

## 5. What this phase does NOT do

Stated plainly, because each of these is a thing a reader might otherwise assume:

- **No rollback.** Nothing is reverted, ever. A file written outside the approved
  scope is reported and **left exactly where it is**; an unauthorised commit is
  reported and **left in history** — no reset, no revert, no cleanup. Tests
  assert both.
- **No OS-level containment.** A direct bypass — writing to disk or running
  `git` outside the bridge — is **detected, not prevented**. Saying otherwise
  would be claiming a sandbox this phase does not have.
- **No automatic retry.** A failed attempt stops and waits for a human.
- **No commit, merge, push, or GitHub write.** No deployment.
- **No project checks are executed.** Running one means executing a command
  string, which is the arbitrary process execution the capability model refuses.
  They are reported as *unavailable*, never as passing because an agent said so.
- **No autonomous approval and no autonomous grant creation.** The
  `REVIEW → APPROVED` transition remains human-only and machine-unreachable;
  `machineTransition` throws, and a test asserts it.
- **`verified` is not "the task is done".** It is a statement about scope and
  authorisation, not about whether the change is correct or complete. Only a
  human can say that, which is why review is next.

---

## 6. Tests

`tests/controlledImplementation.test.ts` drives the real workflow end to end;
nothing is stubbed except the agent. The agent is hostile in almost every case,
because an honest agent proves the happy path and nothing else.

| Scenario | Asserted |
| --- | --- |
| honest agent, in scope | `verified`, no disagreements, review `pass`, still stops at the gate |
| lies about which files it changed | both directions named; the invented file appears nowhere in the evidence |
| claims success having done nothing | contradicted by the absence of any attributable change |
| asks the bridge for something out of scope | refused, denial counted and journalled, repository still clean |
| **goes around the bridge and writes directly** | not prevented — caught as `scope_drift`, and the file is left in place |
| touches `.env` | `sensitive_change`; the filename is reported, the contents are not |
| crashes mid-run | makes no claim; still verified; `partialChangesPossible` stays set |
| cancels itself after writing | recorded as cancelled, partial write attributed, still verified |
| every attempt shape (6 variants) | an outcome always exists — "we did not verify" is unreachable |
| replays a spent grant | `GrantDenied`; the second write never lands |

`tests/gitAndSensitiveMutation.test.ts` covers the correction:

| Scenario | Asserted |
| --- | --- |
| agent commits its own work | `git_mutation`; blocker names the commit SHA |
| commits, then claims failure / crashes | mutation still reported; the claim cannot suppress it |
| **commits leaving a clean working tree** | still detected — the essential case |
| commits a file fully inside scope | still blocking, on capability grounds |
| runs git directly, around the bridge | not prevented; bridge served zero mutations; detected |
| sensitive file modified / deleted / renamed | detected; contents never captured |
| **sensitive change committed** | sensitive change **and** unauthorised mutation both reported |
| clean in-scope run | still `verified`, still review `pass` — no regression |

Each fix was mutation-tested: disabling the `git_mutation` derivation fails 6 of
these, reverting sensitive detection to the dirty listing fails the committed
case, and removing `--no-renames` fails the committed-rename case. A test that
passes either way proves nothing, so this was checked rather than assumed.
| reaches for authority it lacks (10 targets) | none of it is present |

The "goes around the bridge" case deserves emphasis: it is not contrived. Phase
4B.1 is explicit that the child process has **no OS-level sandbox** — a real
coding agent can write wherever the launching user can, without asking the bridge
at all. The write boundary is therefore not the last line of defence. Independent
inspection is, and this is the test that proves what that line does.

---

## 7. Known limitations

1. **No OS sandbox** — carried over from 4B.1 and load-bearing here. Containment
   of the *agent* is not claimed; detection of what it did is.
2. **Sensitive-file policy is name-based** — carried over from Phase 3. It will
   not notice a credential pasted into an ordinary source file that is in scope.
3. **Attribution needs a baseline.** Where none is available, changes cannot be
   attributed to this run, and the evidence says so rather than guessing.
4. **Rename detection had to be turned off for attribution.** `git diff
   --name-only` detects renames by default and then prints only the *new* path,
   so `deploy.pem → deploy-old.pem` reported `deploy-old.pem` alone and the
   original credential path was lost. Attribution now passes `--no-renames`,
   which lists a rename as a delete plus an add — both paths. Found by the
   correction’s own test, not by inspection.
5. **A dishonest agent whose changes are all in scope still yields `verified`.**
   That is correct — the verdict describes the repository, not the agent's
   honesty — but it means the disagreement list, not the verdict, is what
   catches a liar whose edits were legal. The review verdict drops to
   `changes_requested` for exactly this reason.
6. **`usedTools` is inferred from orchestrator-counted writes and deletes.** An
   agent that only read files shows `usedTools: false`, which understates its
   activity. It is a hint for a human, not an input to any decision.
7. **Checks remain unexecuted**, so no verdict here says anything about whether
   the code works. Changing that requires a real decision about process
   execution, not a quiet widening of the capability model.

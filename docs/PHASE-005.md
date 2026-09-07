# Task 005 — Controlled Verification Execution

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

Every phase up to here could establish what *changed*. None could establish
whether the result *works*. Task 005 lets the orchestrator run a bounded,
explicitly authorised set of project checks itself, and answer:

> Did the resulting software pass the checks we were authorised to run?

> **Verification execution is controlled process execution, not a security
> sandbox.**

> **An unrun check is not a passing check. Nothing here ever infers success from
> absence.**

---

## 1. Where it sits

```
IMPLEMENT
    ↓
repository inspection          ← what the AGENT did
    ↓
attribution / security verification
    ↓
CONTROLLED CHECKS              ← Task 005
    ↓
post-check repository inspection  ← what the CHECKS did
    ↓
final verification evidence
    ↓
REVIEW  →  HUMAN APPROVAL
```

The checks run *between two independent inspections*. That is the whole design:
a verification command is executable code, so what it did to the repository is
established by looking, not by assuming it was "only a test".

---

## 2. A check is an executable and an argv array

`src/domain/verificationCheck.ts`

```ts
{ id, name, executable, args, cwd, timeoutMs, enabled }
```

**Never** `{ command: "npm test" }`. A command string has to become an argv array
before anything can run it, and there are exactly two ways to do that: hand it to
a shell — the arbitrary execution this system exists to refuse — or write a
parser, whose bugs are then security bugs.

The schema is `.strict()`, so a definition carrying `command` is **rejected**
rather than ignored. The unsafe shape cannot sit in a config file quietly doing
nothing.

`executable` must be an **absolute path**. A bare name would be resolved through
`PATH`, making whatever happens to be earliest on `PATH` the verification tool.

The legacy `project.checks` field (string commands) still exists, is still never
executed, and was deliberately **not** auto-upgraded — silently converting it
would have turned every existing project config into live process execution the
moment this shipped.

---

## 3. Authorisation, and why the agent cannot reach it

### A separate capability

`verification.execute` is distinct from `process.execute`, which remains
**unimplemented**. The difference is *who chooses what runs*:

| | who supplies the program and arguments |
| --- | --- |
| `process.execute` | the caller, at call time |
| `verification.execute` | configuration captured before the untrusted run |

Granting one does not grant the other, and no code path widens one into the
other.

### The policy is captured before the agent exists

`src/verification/checkPolicy.ts`

The attack this stops is short:

1. agent rewrites the project's check definitions
2. orchestrator loads them
3. orchestrator executes the agent's chosen program, as trusted verification

The fix is not to make one file unwritable — a boundary that depends on a single
filename is a boundary waiting to be walked around. Instead the policy is read
and **SHA-256 fingerprinted at the `inspect` node**, before planning, approval or
implementation. Immediately before execution the policy is re-captured and the
fingerprints compared.

A mismatch runs **neither** version — not the stale captured one, not the
untrusted new one — and raises a blocker. A test performs the rewrite mid-run and
asserts the injected program never executes.

The fingerprint is order-independent, so reformatting or reordering a config file
is not treated as tampering.

---

## 4. How execution is bounded

| Control | Mechanism |
| --- | --- |
| **No shell** | `shell: false` with an argv array. No string is ever parsed. |
| **Working directory** | Resolved through the same `FsBoundary` as everything else — `realpath`, so `..`, absolute paths and junction escapes are rejected at use. |
| **Environment** | Built, not inherited. Reuses `BASE_ENV_PASSTHROUGH` from the Claude Code boundary rather than defining a second list — two policies would eventually disagree, and the disagreement would be the vulnerability. No allowlist parameter exists here at all. |
| **Timeout** | Per-check, clamped to a hard ceiling, further clamped by the remaining phase budget. |
| **Cancellation** | `AbortSignal`, wired to the run's existing cancellation. |
| **Output** | Bounded per stream; bytes counted, tail retained, truncation flagged. |
| **Ceilings** | `CHECK_CEILINGS` — not configurable; editing that file is the only way past. |

Shell metacharacters reach the program as literal argv. A test passes
`; touch <file>` and `&& node -e ...` as arguments and asserts the file is never
created.

Retained output is a bounded **tail** with control characters stripped — check
output is project-controlled text landing in a terminal report, and ANSI escapes
could otherwise rewrite what a reviewer sees.

---

## 5. Seven outcomes, not two

```
passed  failed  timed_out  cancelled  error  blocked  not_run
```

Collapsing these would let an infrastructure problem read as a code problem, or —
far worse — let "we never ran it" read as "it was fine".

- `passed` requires **exit 0 from a real process**. It is the only status that
  means the check passed.
- `error` is a process that could not start. `timed_out` is a deadline.
  `cancelled` is the run stopping. None of them says anything about the code.
- `blocked` is a refusal before launch — not authorised, invalid definition, over
  a ceiling, working-directory escape.
- `not_run` is never a pass.

`summariseChecks` returns `allPassed: false` for an empty run. That guard is
deliberate: `results.every(passed)` is `true` for an empty list, which is exactly
how "no checks configured" becomes "all checks passed".

A definition refused at capture still appears in the report as `blocked`. A check
that silently vanishes is indistinguishable from one that passed.

---

## 6. Independent evidence, not an agent claim

The check run is a **process** observation and sits in the process compartment,
beside the exit code — never in the repository compartment. An agent saying "all
tests passed" contributes nothing to it.

Both directions of disagreement are recorded:

- agent claims success, an executed check did not pass
- agent claims failure, every executed check passed

A failing check that ran withholds a `pass` recommendation at review. An **unrun**
check does not — that is a gap in evidence rather than a defect found, so it is
reported as a warning. Either way the human gate is untouched, and
`REVIEW → APPROVED` remains machine-unreachable.

---

## 7. The checks are watched too

After execution the repository is inspected again and attributed against a
snapshot taken *after the agent and before the first check*. Anything found there
belongs to a **check**, not to the agent.

Tested, each against a check that really does it:

| A check that… | Result |
| --- | --- |
| modifies an in-scope file | detected, listed, blocker |
| creates an out-of-scope file | `scope_drift` |
| deletes a file | detected |
| renames a file | both paths detected |
| writes `.env` | `sensitive_change`, contents never captured |
| commits, leaving a clean tree | `git_mutation` |
| commits a credential | `sensitive_change` **and** `git_mutation` |
| behaves | clean `verified`, review `pass` |

Checks are **skipped entirely when the repository cannot be inspected.** Running
code we would then be unable to observe is strictly worse than not running it —
we would have executed something and have no idea what it did.

Nothing is reverted. No reset, no cleanup, no rollback.

---

## 8. What Task 005 does NOT add

- **No arbitrary shell.** No `shell: true` anywhere, no command strings.
- **No arbitrary process execution.** `process.execute` remains unimplemented.
  Only predefined checks from trusted configuration run.
- **No agent-chosen executables or arguments.**
- **No network capability.** See the limitation below — this is not enforced at
  the OS level.
- **No credentials.** The child environment is built, not inherited.
- **No git mutation, no GitHub writes, no deployment.**
- **No OS sandboxing.** A check runs with the orchestrator user's privileges.
- **No rollback, no autonomous approval, no autonomous retry.**

---

## 9. Known limitations

These are real. None of them is solved by this phase.

1. **Not a sandbox.** A check can do anything the orchestrator user can do. What
   is controlled is *what gets launched*; what is provided afterwards is
   *detection*. Containment is not claimed.
2. **Network is not actually blocked.** The environment is non-interactive and no
   credentials are passed, but a check that opens a socket will succeed. Real
   denial needs OS-level controls this phase does not implement. Setting an
   environment variable is not network isolation, and claiming otherwise would be
   worse than the gap.
3. **Descendant processes may survive.** Carried over from 4B.1: killing the
   launched process on timeout or cancellation does not guarantee its children
   die. Cross-platform process-tree termination is not implemented. A check that
   spawns a long-running child can leave that child running.
4. **No CPU or memory isolation.** A check can consume as much of either as the
   machine allows. Only wall-clock time is bounded.
5. **Restart semantics are coarse.** The workflow refuses to replay a spent
   decision, so a completed check phase cannot be re-entered by replay — a test
   asserts the counter stays at one. But a crash *during* the check phase leaves
   the node incomplete, and resuming re-runs the whole phase, re-executing checks
   that had already run. Making individual check results durable mid-phase would
   need a redesign of the node boundary, which is out of scope here.
6. **A malformed check in `project.json` makes the project unreadable.**
   `getProject` re-parses the whole record, so a hand-edited invalid definition
   throws rather than being reported as one blocked check. This fails *closed* —
   nothing executes — but it is a crash rather than a clean report.
7. **The policy guard is capture-and-compare, not a lock.** It detects that the
   definitions changed; it does not prevent the write. That is sufficient here
   because detection blocks execution, but it is detection.
8. **Output excerpts are bounded and lossy** by design. A failure whose cause is
   in the middle of a very long log may not appear in the retained tail.

# Task 014 — End-to-End Autonomous Development Loop

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

> **Bounded autonomous workflow iteration under mandatory human authorization.**
>
> **The orchestrator may run the process autonomously.
> The model may propose the work.
> The evidence may inform the next proposal.
> The machine may repeat bounded iterations.
> But authority remains explicitly human.**

This document uses two phrases that must not be confused:

- **Autonomous orchestration** — the graph goes from one node to the next, and
  round again, without a person driving each transition. Task 014 adds this.
- **Autonomous authority** — the system approving, granting, widening,
  completing or exempting anything on its own. Task 014 adds none of this, and
  every mutation in §15 that tries to is caught.

The system is **not** "fully autonomous". Two human gates are mandatory on
every iteration, and nothing here can pass either one.

---

## 1. Objective

Connect the already-approved pieces — plan, plan approval, controlled
implementation, independent verification, deterministic review, review
approval, and the learning pipeline of Tasks 009–013 — into one bounded,
explicit loop, so a development task can go through several
implement/verify/review iterations without the human driving every internal
transition, while every authority boundary stays exactly where it was.

## 2. Autonomous-loop definition

One **run** performs one or more **iterations**. An iteration is:

```
inspect → plan → HUMAN PLAN APPROVAL → implement → verify → review
        → HUMAN REVIEW APPROVAL → learn → next_iteration
```

`next_iteration` is the only node with an edge back into the graph. It takes
that edge — to `inspect`, never further — only when all three hold:

1. the human asked for changes at the review gate (`feedback` or `edit`);
2. verification observed **no safety condition** (§7);
3. the iteration counter is below the run's bound (§6).

Otherwise it stops, records why in a closed vocabulary, and hands over to
`update_state`. Whether it continues or stops, the decision is a pure
function over trusted state (`decideNextIteration` in
`src/domain/iteration.ts`) with **no input a model or agent could write**: a
test greps its parameter list for `complete`, `approved`, `verified`, `claim`,
`proposal` and `model` and finds none.

Iteration is automated. Approval is not. A new iteration's plan meets the plan
gate exactly as the first one did — `plan → approve_plan` is an unconditional
edge — and its review meets the review gate.

## 3. State-machine changes

Two nodes and two phases were added; no gate moved.

| Change | Where |
| --- | --- |
| `learn` node — writes one experience record per iteration (§11) | `src/graph/nodes/index.ts` |
| `next_iteration` node — the loop decision (§2) | `src/graph/nodes/index.ts` |
| `approve_review → learn → next_iteration` replaces `approve_review → update_state` | `src/graph/workflow.ts` |
| conditional edge `next_iteration → inspect` (`new_iteration`) / `→ update_state` (`stop`) | `src/graph/workflow.ts` |
| `WorkflowPhase` gains `learn`, `next_iteration`; `RunStatus` gains `incomplete` | `src/domain/workflow.ts` |
| `WORKFLOW_EDGES` — the topology as data | `src/graph/workflow.ts` |

The full edge list is exported as `WORKFLOW_EDGES` and a test compares it to
the **compiled** graph's edges, so the diagram in `workflow.ts` cannot drift
from what runs. The only edges into `implement` and out of `plan` are
`approve_plan → implement` and `plan → approve_plan`. There is no edge from
`next_iteration` to `implement`, `verify`, `review` or `approve_review`.

The loop is in `workflow.ts`, where it can be read. Mutation 16 moves it
inside a node (running implement/verify/review inline) and mutation 17 points
the loop edge at `implement`; both are caught.

## 4. Iteration identity

```
Run   run_<uuid>
  Iteration 1   run_<uuid>_it1
    plan approval   apr_run_<uuid>_i1_plan_<revision>     digest of the plan
    grant           grn_run_<uuid>_i1_<revision>
    review approval apr_run_<uuid>_i1_review_<revision>   digest of the reviewed state
  Iteration 2   run_<uuid>_it2
    plan approval   apr_run_<uuid>_i2_plan_0 ...
```

Every id is **derived**, never random, because a LangGraph node replays from
the top on resume (`approvalIdFor`, `grantIdFor`, `iterationIdFor`). The
iteration is now part of every approval and grant id. `revisions` — plan
revisions after feedback — resets to 0 when an iteration starts, so
`(run, iteration, gate, revision)` is unique and legible.

State carries `iteration`, `iterationId`, `iterationLimit`, `stop` and
`iterations: IterationRecord[]` — an index keyed by iteration id and upserted
by **patch** (identity plus only the fields a node established; a parsed record
would null out earlier fields). Each record holds the plan approval id and
digest, the plan decision kind, the grant id, the verification and review
verdicts, the review approval id and digest, the review decision kind, the
completion assessment, the safety conditions, what `learn` recorded, and the
loop decision. Identifiers, digests, verdicts, kinds, counts — no plan text,
no findings text, no model or agent words. `FORBIDDEN_ITERATION_KEYS` pins the
shape against authority words and a test asserts each is rejected.

The run record (`WorkflowRun`) carries `iteration`, `iterationLimit` and
`stopReason`, so the loop is visible from the project store without opening
the checkpoint. The CLI prints `iteration N of M`.

## 5. Approval binding

An approval is bound to **a gate in a run and iteration** (the id) and to
**the thing at that gate** (the digest). Three mechanisms, in the order they
fire:

1. **The runner** refuses a decision whose `approvalId` is not the run's
   current `pendingApprovalId` — before the graph is even resumed. Iteration
   1's plan decision replayed against iteration 2's plan gate is refused with
   `waiting on approval …_i2_plan_0, but the decision answers …_i1_plan_0`
   (Scenario C).
2. **The gate node** re-checks the decision's id against the request it made.
3. **The implement node** refuses a grant whose `approvalId` is not
   `approvalIdFor(run, "plan", revision, iteration)` for the *current*
   iteration, before the grant is claimed. A grant from any other plan
   approval — an earlier iteration's, typically — implements nothing. This is
   structural, ahead of the store's one-shot claim.

`ApprovalRequest` gained `iteration` and `subjectDigest`. `planDigest` is a
SHA-256 over the plan's canonical bytes (sorted scope), recorded as the digest
of what was **approved** — the edited plan when the human edited.
`reviewDigest` covers the review verdict and findings, the verification
verdict, the observed head commit and changed files, and the observed diff, so
a later repository state is a different review. There is no reusable
"approved" boolean anywhere in state.

Scope is not inherited: iteration 2's grant carries exactly the scope the
human approved for plan B (Scenario C, third test; mutation 18).

## 6. Loop bounds

`ITERATION_LIMITS` in `src/domain/iteration.ts`: default 3, ceiling 10.
`IterationLimit` is `z.number().int().min(1).max(10)` — `int()` rejects
`Infinity` and `NaN`. The runner option `maxIterations` (CLI
`--max-iterations`) is validated at construction and **throws** on an invalid
value; a bad bound is an operator error to surface, not to round down.

The bound enters state once, at `start`, into the `iterationLimit` channel
whose reducer is `(prev, next) => prev ?? next` — it keeps the first value and
ignores every later write. So:

- no node can raise it;
- a model cannot reach it: proposals are strict-schema validated (unknown keys
  such as `maxIterations` reject the whole response) and rebuilt field by
  field, and no field of a `Plan` is a limit (Scenario I; mutation 5 relaxes
  the schema, forwards the value *and* rewrites the reducer, and is caught);
- a resuming runner with a different configured bound does not change the
  run's (Scenario H; mutation 19).

It is visible in state, in the run record, in every approval payload, in the
`iteration_started` event, and in the CLI. Exhaustion is fail-closed (§7).

## 7. Stop conditions

`StopReason` is a closed enum. Precedence in `decideNextIteration` —
**safety first, then the human, then the bound:**

| Safety | Review decision | Iteration | Result | Run status / outcome |
| --- | --- | --- | --- | --- |
| **any condition** | **any (approve included)** | any | stop `safety_stop` | `incomplete` / `incomplete:safety_stop` |
| none | (none recorded) | — | stop `safety_stop` | `incomplete` |
| none | approve | any | stop `human_approved` | `completed` / `approved` |
| none | reject | any | stop `human_rejected` | `rejected` / `rejected_at_review` |
| none | feedback / edit | < limit | **continue** | — |
| none | feedback / edit | = limit | stop `iteration_limit_reached` | `incomplete` / `incomplete:iteration_limit_reached` |

> **Corrected after independent review.** The first version checked the
> human's decision before the safety conditions, so an unauthorised git
> mutation followed by a review approval ended `completed` / `approved`. The
> review found it; the ordering is now safety first, and a mutation that
> restores the old ordering (§15, #21) is caught.
>
> **Verification-observed safety conditions are terminal safety boundaries. A
> human review approval cannot convert a safety-stop condition into a
> completed run.**
>
> This does not remove human authority. The human still controls the review
> decision: it is requested, recorded in `decisions`, carried on the iteration
> record and in the loop decision's `decidedBy`, and written into the
> experience record's sources. What an approval can no longer do is turn an
> iteration whose safety boundary was crossed into a successful run — the run
> ends `incomplete`, and a human starts a new one on a repository they have
> looked at. The review gate says so before the decision is made
> (`approvalCanComplete: false`, rendered as a SAFETY line in the CLI).
>
> **Safety is not review quality.** A failed check, a claim the repository
> contradicts, a disagreement — those are findings about the *work*; they are
> listed as blockers to completion and the human may approve over them
> (tested: a false claim approved ends `completed`). Only the six
> `SafetyCondition` values, derived from what verification observed about the
> *control environment*, are terminal.

Rejection at the plan gate stops with `human_rejected` / `rejected_at_plan`,
as before.

`SafetyCondition` (derived only from the trusted verification outcome):
`unauthorised_git_mutation`, `check_policy_changed`,
`check_integrity_blocked`, `checks_changed_repository`, `scope_drift`,
`inspection_unavailable`. A condition is a fact about the environment the
work ran in, and no decision at the review gate can make it not have
happened. `inspection_unavailable` means the orchestrator refuses to
complete or iterate blind: **a project without an inspectable repository can
never reach `completed`** - the orchestrator observed nothing, so it can
vouch for nothing. Decided with the Director when the correction surfaced it:
three Phase 2 fixtures were bare directories and used to reach `completed` on
approval; they now have repositories, and the bare-directory case is pinned
by its own test (`NO REPOSITORY, NO COMPLETION`). To be completed, a project
must be inspectable.

`incomplete` is a third terminal status: nothing was approved and no human
said no. It is never converted into `completed`; the CLI prints
`INCOMPLETE: nothing was approved`.

Verification failure is **not** a stop condition and **not** approval. A
blocking verdict withholds `pass` from the deterministic review, lists
blockers in the completion assessment the human sees, and — if the human asks
for changes and no safety condition was observed — leads to another planning
iteration through the plan gate (Scenario E, second test).

## 8. Restart semantics

Unchanged mechanism, extended state. Every gate is a LangGraph `interrupt()`
on a SQLite checkpoint; a run resumes in any process that shares the
checkpoint and the run file. What Task 014 adds survives because it lives in
channels: `iteration`, `iterationId`, `iterationLimit` (first-value-wins),
`iterations`, `stop`, and the per-iteration channels.

Proven two ways: every step of every in-process scenario opens a **new runner
on a new checkpointer connection** (Scenario H additionally closes all
connections between steps and re-reads the run file from disk), and the
separate-process suite drives a two-iteration run to `incomplete` across five
OS processes with `--max-iterations 2`, asserting the iteration, the bound and
the `_i2_plan_0` / `_i2_review_0` pending ids from the run file at each stop.
Mutation 13 (resume resets the counter) and 19 (resume imposes the resuming
runner's bound) are caught.

## 9. Idempotency

| Replay / retry | What happens |
| --- | --- |
| Gate node replays on resume | Ids are derived; the same request is rebuilt and the decision matches. Unchanged. |
| `implement` re-executes after a crash mid-node | The grant's claim marker is exclusive (`open wx`); the second execution finds it consumed and attempts nothing — the agent is not invoked and the repository is untouched (idempotency test). |
| `implement` handed a grant from another iteration | Refused before the claim (§5). |
| `learn` re-executes | Writes a record whose content-derived id includes `createdAt`; a duplicate is possible and harmless downstream (Task 011 counts records; §17). |
| `next_iteration` re-executes | Pure over state; `stop` is first-value-wins. |
| A stopped run is resumed | Refused: not `awaiting_approval`. |

LangGraph replay is **not** relied on for external side effects; the grant
claim and the write boundary are.

## 10. Failure semantics

None of the following reaches `approved`; each was tested:

- implementation failure (agent throws) — run reaches the review gate with
  `implementationRun.status = failed`, completion blockers say so, human
  decides;
- verification failure — review withholds `pass`; no approval; iteration only
  through the plan gate;
- review failure — same;
- tool denial — recorded as a denial; verification proceeds on what actually
  landed;
- approval rejection — `rejected`, stop `human_rejected`;
- interruption — the run stays `awaiting_approval` with its pending id;
- iteration exhaustion — `incomplete`;
- safety condition — `incomplete`.

`machineTransition` still has no path to `APPROVED` from any status; a test
asserts `IN_PROGRESS → APPROVED`, `IMPLEMENTED → APPROVED` and
`REVIEW → APPROVED` all throw.

Completion is **observational**: `assessCompletion` reads the verification
outcome, the review report, the scope evidence and the orchestrator's own
implementation-run status, and lists what still blocks completion. It has no
input for what the agent claimed; a test hands it a verification outcome whose
claim says "all done" over a `failed` verdict and gets an inconsistent
assessment. The assessment informs the human at the review gate and is
recorded; nothing reads it to approve.

## 11. Learning interaction

`learn` is the first **producer** of experience. After the human's review
decision, it writes one `EpisodicExperience` per iteration through
`experience/outcomeRecorder.ts`, built from:

- the human-approved plan (summary, step descriptions as patterns);
- the verification verdict and observed counts;
- the check run;
- the review verdict, the blocking findings, and the decision kind;
- `sources` derived from which trusted facts exist — `REPOSITORY_OBSERVATION`,
  `VERIFICATION_RESULT`, `PROCESS_OBSERVATION`, `REVIEW_FINDING`,
  `HUMAN_DECISION`. **Never `AGENT_CLAIM`**, and not one word of the agent's
  account: `claimedSummary` and `claimedFiles` have no field and are not read.

A pattern is recorded as successful only when the human approved and nothing
trusted contradicts it; as failed when verification blocked, the review
withheld `pass`, or the human rejected. A human requesting changes on a clean
iteration records neither — the work was not wrong, it was not enough.

The write's outcome is reported (state, iteration record,
`experience_recorded` event) and **decides nothing**: `next_iteration` does not
read it, so an unwritable store yields a run that iterates exactly as one with
a full store. The record reaches the next run's reasoning through Tasks
010–013 as digests and counts, at ranks 20 and 15. Scenario J seeds an
ESTABLISHED strategy and shows it reaching the model's context while the plan
gate, the grant scope, the capabilities, the risk and the bound are untouched;
mutation 9 lets an established posture skip the plan gate and is caught.

`docs/PHASE-009.md`'s statement that nothing writes experience is now
historical; the foundation-import guard was narrowed to add the recorder, with
the reason recorded in the test.

**Found by the existing guards, and fixed structurally rather than by
loosening them.** The recorder's first version imported the `Plan` and
`HumanDecisionKind` *types* from the approval domain. Two guards - one on
import specifiers, one on the whole file - forbid any module under
`src/experience` from reaching the approval, grant or capability domains, and
both fired. The types were harmless; the dependency was the wrong shape. The
recorder now takes plain inputs (a plan's summary and step text; one of four
decision words; a blocker count) that the `learn` node projects the real
objects onto, so the learning layer still has no handle on an approval, a
decision, a grant or a scope. The exact-file-list guard was extended with the
recorder and the reason.

## 12. Security boundaries

Preserved, and re-tested through the loop:

- **Plan gate** — mandatory, unconditional edge, per iteration (mutation 1).
- **Review gate** — mandatory, per iteration (mutation 2).
- **No reusable approval** — ids carry the iteration; digests name the subject
  (mutations 3, 4).
- **Grants** — one human decision, one grant, one attempt; cleared at the start
  of every iteration; bound to the iteration's plan approval (mutation 10).
- **Capabilities** — the same five as before; `git.mutate`, `process.execute`
  and `network.access` are refused at issue time in every iteration
  (Scenario K).
- **Scope** — from the approved plan only (mutation 18).
- **Model** — strict schema, field-by-field rebuild, risk computed by trusted
  code; `maxIterations`, `complete`, `approved`, `skipVerification`,
  `capabilities`, `scope` and `grant` in a response reject it (Scenario I;
  mutations 5, 6).
- **Verification and review** — the agent's claim is quarantined; substituting
  it for either is caught (mutations 7, 8).
- **Learning** — reasoning-only (mutation 9); the producer writes no agent
  text (mutation 20).
- **HIGH-risk actions** — git used by the agent is observed as unauthorised,
  blocks the review, and stops the loop (Scenario K).
- **No new capability path** — no new tool, adapter, shell, network or
  process access. `dev-agent tools` still reports the three HIGH capabilities
  NOT IMPLEMENTED.

## 13. Self-modification prohibition

> Target-project autonomy ≠ orchestrator self-modification.

`src/security/selfBoundary.ts` derives the orchestrator's installation root
from its own module location (correct under `src/` and `dist/`, not
configurable) and refuses a project whose working directory **is**, **is
inside**, or **encloses** it. Checked at `WorkflowRunner.start` — before a run
exists, so there is nothing to resume — and again in the `implement` node, in
case the project record was re-pointed between the gate and the resume.
Scenario L covers all three relations at start, the re-pointing case at
implement (the orchestrator's `task.ts` is hashed before and after), and an
agent inside a legitimate project trying to reach the orchestrator's sources
through the session by relative and absolute path (denied; file unchanged).
Mutation 11 disables the boundary and is caught.

**Proven on the real tree, unintentionally.** During the first mutation pass,
mutation 11 let the re-pointing scenario's agent write `src/a.ts` into the
orchestrator's own installation - the file was found by `git status` before
committing, its content matched the fake agent's, and nothing tracked was
touched. It was removed; the scenario now writes a probe path nothing else
uses and deletes it in `finally`, so the mutation is still caught (re-run: 2
failures) without leaving debris. That a disabled boundary produced a real
write into the control plane is the strongest evidence in this task that the
boundary is load-bearing.

If the orchestrator is ever to develop itself, that needs a separately
designed authority model, and the first step of that design is deleting this
refusal on purpose.

## 14. Observability

| Where | What |
| --- | --- |
| state `iterations[]` | per-iteration index (§4) |
| state `stop` | reason, detail, who decided |
| run record | `iteration`, `iterationLimit`, `stopReason`, `status: incomplete` |
| approval payload `iteration` | iteration, id, limit, revision; at the review gate also `anotherIterationPossible`, `safetyConditions`, `completion.blockers` |
| events | `iteration_started {iteration, iterationId, limit}`, `iteration_ended {decision, detail}`, `experience_recorded {recorded, experienceId, reason}`, plus `node_started/completed` for `learn` and `next_iteration` |
| CLI | `iteration N of M`, `stopped <reason>`, blockers at the gate, the INCOMPLETE line |

Events carry ids, counts and closed vocabularies — no plan text, no findings
text, no model output. There is no second logging path. Nothing raw from a
model is trusted state.

## 15. Mutation testing

Twenty mutations, each **typechecked before its tests run** (one that does not
compile proves nothing and is not counted), verdict CAUGHT only when vitest
exits non-zero *and* reports failures, source diffed against backups after
each and at the end. Run against `tests/autonomousLoop.test.ts`.

| # | Mutation | Result |
| --- | --- | --- |
| 1 | plan gate removed (synthetic approval instead of `interrupt`) | caught |
| 2 | review gate removed | caught |
| 3 | an earlier plan approval answers a later plan gate | caught |
| 4 | an earlier review decision answers a later review gate | caught |
| 5 | model-controlled iteration count: schema relaxed + plan forwards `maxIterations` + channel accepts later writes | caught |
| 6 | model-controlled completion: schema relaxed + `complete: true` ends the run approved + `plan` edge made conditional | caught |
| 7 | verification substitution: agent's claim of success becomes `verified` | caught |
| 8 | review substitution: agent's claim of success becomes `pass` | caught |
| 9 | learning authority: an established strategy skips the plan gate | caught |
| 10 | grant persistence: grant not cleared at new iteration and reused by approve_plan | caught |
| 11 | self-modification: the boundary never refuses | caught |
| 12 | infinite loop: the bound is not consulted | caught |
| 13 | restart reset: resume resets the iteration counter | caught |
| 14 | failure to success (loop): a non-pass review stops as `human_approved` | caught |
| 15 | failure to success (review): the review always passes | caught |
| 16 | hidden loop: next iteration's implement/verify/review run inside `next_iteration`, around the gates | caught |
| 17 | hidden loop (topology): the loop edge targets `implement` | caught |
| 18 | scope inheritance: a new grant inherits every earlier grant's scope | caught |
| 19 | restart re-limits: a resuming runner imposes its own bound | caught |
| 20 | learning leaks the agent's account and `AGENT_CLAIM` into the record | caught |
| 21 | **correction:** the vulnerable ordering restored — approval checked before safety | caught |
| 22 | **correction:** safety gates everything except approval | caught |

Exact failing counts are in the completion report. Mutation 15's first
version did not compile (a type-narrowing artefact in the mutation text, not
in the product), was not counted, was rewritten and re-run, and is caught.
The recorder's boundary fix (§11) changed two mutated files after the first
pass, so the whole set was re-run on the final tree; the numbers reported are
from that pass.

## 16. End-to-end tests

`tests/autonomousLoop.test.ts` (38 tests) and two cases added to
`tests/restart.test.ts` (separate OS processes; requires `npm run build`).

| Scenario | Test |
| --- | --- |
| A | one successful iteration → `approved`; the learn record's sources |
| B | feedback → iteration 2 at the plan gate with its own approval and grant → `approved` at iteration 2; two records |
| C | old plan decision refused by the runner; implement refuses a foreign grant; scope not inherited |
| D | `maxIterations: 2` → `incomplete:iteration_limit_reached`; limit 1; invalid bounds refused |
| E | out-of-scope side effect → blockers, safety stop on feedback **and on approve**; false claim → changes requested, iteration 2 via plan gate |
| F | plan rejected → nothing implemented |
| G | review rejected → no approval, no iteration, failed patterns recorded |
| H | fresh runners and closed connections between iterations; run file read from disk; a different resuming bound does not win |
| I | hostile response with `approved/complete/skipVerification/maxIterations/capabilities/scope/grant` → schema refused, zero-scope plan, bound unchanged; `/` and `../` refused; `complete: true` alone does nothing |
| J | ESTABLISHED strategy reaches the model; gates, grant, scope, capabilities, risk, bound unchanged |
| K | agent commits with git → unauthorised, blocker, safety stop; **unauthorised git + human APPROVE → `incomplete:safety_stop`, decision recorded, no later edge, not resumable**; a non-safety finding approved → `completed`; `git.mutate` unmintable |
| L | start refused for is / inside / encloses; implement refused after re-pointing; session cannot reach orchestrator sources |
| — | topology equals the compiled graph; idempotent implement; task-status table; loop decision precedence; observational completion; digests; iteration record; producer writes no agent text |

## 17. Known limitations

1. **Runs are not bound to `Task` records.** `WorkflowRun.taskId` is still
   never set and `onFinalise` still writes no task status; the PLANNED → …
   → APPROVED table is enforced in `domain/task.ts` and tested, but the
   workflow does not drive it. Deliberately not added here — it is its own
   reviewable change.
2. **`taskType` for learning is the `understand` stub's label**
   (`development_request` for every run), so every record is in one cohort.
   Real intent classification is a later task; until then the learning cohort
   is coarse.
3. **The learn step can write a duplicate record if the node replays after a
   crash between the write and the checkpoint.** Harmless downstream (Task 011
   counts records; two identical iterations are two attempts), but noted.
4. **Safety conditions come from verification, and verification observes the
   repository.** An agent process is still not OS-sandboxed (Phase 4B.1); a
   side effect outside the repository is not observed and therefore not a
   safety condition. Unchanged from before, and unchanged in scope.
5. **The human's review approval is authoritative over review findings, not
   over safety conditions.** Blockers that are findings about the work are
   shown, recorded, written into the experience record as failures, and the
   human may approve over them. The six safety conditions are terminal (§7).
6. **Grant lifetime (15 min default) spans one implement node, not an
   iteration.** A human who approves a plan and walks away for an hour comes
   back to an expired grant and a refused attempt — fail-closed, as before.
7. **No claim is made that iterating improves outcomes.** This task
   establishes the mechanism and its bound, not a result.

**Task 015: NOT STARTED.**

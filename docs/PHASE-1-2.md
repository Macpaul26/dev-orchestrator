# Phase 1+2 — Foundation + Durable Human-in-the-Loop

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

This phase exists to prove one assumption before the system is given any power
to modify software:

> A workflow suspended at a human approval survives the process dying, and a
> completely separate process can find it, resume it, and carry it forward.

That is proven by tests that spawn real OS processes, including one that
`SIGKILL`s itself. See [Restart proof](#restart-proof).

---

## What exists

| Area | State |
| --- | --- |
| Zod domain schemas | Real |
| Nine-node LangGraph workflow | Real |
| SQLite checkpointing | Real (`SqliteSaver`, on disk) |
| `interrupt()` / `Command({resume})` | Real |
| Four human decisions | Real (`approve` / `edit` / `reject` / `feedback`) |
| REVIEW ⇸ APPROVED invariant | Enforced in code, 7 tests |
| File-backed project store | Real |
| JSONL event history | Real |
| Path containment | Real, tested |
| Risk model | Policy real; no HIGH-risk tool registered |
| CLI | Real |
| Coding agent | **Interface only. No implementation.** |
| GitHub | **Interface only. No implementation.** |
| Model calls | **None.** No API key required. |

## What deliberately does not exist

No Claude Code execution, no Anthropic API calls, no GitHub reads or writes,
no commits, no merges, no deployment, no shell execution, no dashboard, no
database, no multi-agent anything, no LangSmith, and nothing project-specific
in `src/`.

`npm run tools` reports `write capabilities registered: false`, and a test
asserts it.

---

## Architecture

```
CLI ──▶ WorkflowRunner ──▶ StateGraph (9 nodes)
             │                   │
             │                   ├── interrupt() at approve_plan
             │                   └── interrupt() at approve_review
             │
             ├──▶ SqliteSaver        .orchestrator/checkpoints.sqlite   (machine)
             ├──▶ ProjectStore       projects/<id>/…                    (human)
             └──▶ EventLog           projects/<id>/history/<run>.jsonl  (audit)
```

### LangGraph vs LangChain

**LangGraph** is the entire workflow backbone: state, nodes, edges,
checkpointing, interrupt, resume.

**LangChain is not a dependency at all in this phase.** It was proposed only as
the model-provider abstraction, and no model is called yet, so nothing was
installed. There are no LangChain agents, chains or executors anywhere — every
edge in `src/graph/workflow.ts` is one we wrote.

---

## State model

```
PLANNED ──▶ IN_PROGRESS ──▶ IMPLEMENTED ──▶ REVIEW ──╳ (machine stops here)
                                                      │
                                             human decision
                                                      │
                                          ┌───────────┴───────────┐
                                       APPROVED               REJECTED
```

`src/domain/task.ts` holds the machine transition table. `REVIEW` maps to the
empty set, and `APPROVED` / `REJECTED` appear on no right-hand side, so no
sequence of machine transitions can reach them. `machineTransition()` throws
`InvariantViolation` if asked; `applyHumanDecision()` is the only function that
can produce a terminal status, and it requires a validated `HumanDecision`
carrying an `approvalId` and a `decidedBy`.

### Workflow graph

```
understand → inspect → plan → approve_plan ─┬─ approve/edit → implement → verify
                        ▲                   ├─ feedback ────→ plan (replan)
                        └───────────────────┘                     │
                                            └─ reject ─────→ update_state
                                                                  ▲
   review → approve_review ────────────────────────────────────┘
```

---

## Approval model

`approve_plan` and `approve_review` call LangGraph's `interrupt(request)`. The
runtime writes a checkpoint and unwinds; the process may then exit. Supplying
`new Command({ resume: decision })` makes that value the return value of the
`interrupt()` call, and the node continues.

Four decisions:

| Decision | Effect |
| --- | --- |
| `approve` | Proceed unchanged |
| `edit` | Proceed with the human's revised plan — `--scope` narrows `allowedScope` |
| `reject` | Short-circuit to `update_state`; run ends `rejected` |
| `feedback` | Loop back to `plan`, `revisions` increments, a new approval is raised |

### One trap worth knowing

**A node body re-executes from the top on resume, up to its `interrupt()` call.**
Everything before that point must be deterministic.

The first implementation minted approval ids with `crypto.randomUUID()`. On
resume the node replayed, generated a *different* id, and rejected the human's
decision as answering the wrong approval — every resume failed. Approval ids are
now derived from `(runId, gate, attempt)` and are stable across replays. See
`approvalIdFor()` in `src/domain/approval.ts`.

The replay is visible in the event history: `approval_requested` appears twice
per gate, once per execution of the node.

---

## Persistence — two stores, deliberately separate

### SQLite checkpoints — `.orchestrator/checkpoints.sqlite`

Machine state needed to resume a graph. Written by `SqliteSaver`, keyed by
`thread_id` (one thread per run). Disposable: deleting it loses in-flight runs
but no project history.

`closeCheckpointer()` exists because Windows keeps an open SQLite file locked,
so anything that deletes the directory must close the handle first.

### Project store — `projects/<id>/`

```
projects/<project-id>/
  project.json     identity, workingDir, declared check commands
  context.md       long-form context
  decisions.md     durable decisions
  status.md        human-readable snapshot
  decisions/       one JSON per decision
  tasks/           one JSON per task
  runs/            one JSON per workflow run
  history/         one JSONL per run
```

Human-readable, diffable, hand-editable, git-friendly. This is the durable
record. A database can replace it later behind the `ProjectStore` interface.

**The run record is what makes a suspended run *discoverable*; the checkpoint is
what makes it *resumable*.** Both are needed, and they are not the same thing.

---

## CLI

```bash
npm run build

node dist/cli/index.js project:create --id acme-api --name "Acme API" --dir /path/to/repo
node dist/cli/index.js start   --project acme-api --request "Reduce duplication in auth"
node dist/cli/index.js runs
node dist/cli/index.js resume  --run <runId> --decision approve --by you
node dist/cli/index.js resume  --run <runId> --decision edit --scope "src/auth/"
node dist/cli/index.js resume  --run <runId> --decision feedback --comment "narrow it"
node dist/cli/index.js history --run <runId>
node dist/cli/index.js tools
```

`ORCHESTRATOR_HOME` and `ORCHESTRATOR_PROJECTS` override storage locations —
used by the tests to isolate each case.

---

## Restart proof

`tests/restart.test.ts` spawns real `node` processes via `execFileSync`.

1. **Process 1** starts a run, suspends at the plan gate, **exits**.
2. **Process 2** runs `runs` and finds the suspended run.
3. **Process 3** resumes with a decision; the run advances to the review gate.
4. **Process 4** approves; the run completes.

Plus an ungraceful case: a child starts a run then `SIGKILL`s itself — no
signal handler, no flush, no `close()` — and a fresh process still resumes and
completes the run.

The manual demonstration recorded in the Phase 1+2 report shows resumes under
PIDs 43020 and 40452, both different from the starting process.

---

## Security posture

| Control | Status |
| --- | --- |
| Secrets in graph state / checkpoints / history | None. State is asserted JSON-serialisable project metadata only. |
| Hard-coded credentials | None. `.env.example` lists names only, all commented out. |
| Shell execution | None exists. |
| Filesystem access | `resolveWithin()` enforces containment; traversal and absolute escapes throw. Tested. |
| Write-capable tools | None registered. Asserted by test. |
| Model calls | None. No API key is read or required. |
| Newbreed repository | Untouched. Different directory, different git repository. |

The risk policy (`LOW` → none, `MEDIUM` → logged, `HIGH` → human approval) is
implemented, and `risk` is a static field on a tool definition — not a
parameter, not model-supplied. `ToolRegistry.register()` rejects a tool that
claims to be both `HIGH` risk and read-only.

---

## Known limitations

> **Several of these were resolved in Phase 3.** See [PHASE-3.md](PHASE-3.md);
> this section records the state at the end of Phase 1+2.

- Every node except the two approval gates is a deterministic stub.
  *(Phase 3: `inspect`, `verify` and `review` are real.)*
- `inspect` reads project-store metadata only. It does not read the repository.
  *(Phase 3: real read-only git and filesystem inspection.)*
- `verify` runs nothing. `project.checks` is modelled but never executed.
  *(Phase 3: `verify` inspects independently. Check execution is still disabled,
  now explicitly — see `verification/checks.ts`.)*
- `ImplementationReport.observed*` is always empty and
  `verifiedIndependently` is always `false` — correct for this phase, since no
  implementation happens and nothing has been observed.
  *(Phase 3: populated from git; the flag is true only when an observation
  actually succeeded.)*
- Path containment is lexical only, so a symlink could resolve outside the root.
  *(Phase 3: physical containment added; symlink and junction escapes rejected.)*
- `edit` from the CLI currently only rewrites `allowedScope`. A full editor
  round-trip is CLI polish.
- One `thread_id` per run; concurrent runs on one thread are not supported.
- `better-sqlite3` is a native module. It resolved from a prebuild here; a
  machine without one needs a toolchain. `node:sqlite` is a viable fallback if
  that ever becomes a problem.

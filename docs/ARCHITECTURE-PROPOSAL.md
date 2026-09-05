# AI Development Orchestrator — Architecture Proposal

**Status:** PROPOSAL — for review. Nothing has been built.
**Date:** 5 September 2026
**Author:** Implementation engineer (Claude Code)

---

## 0. Environment inspected

| Item | Finding |
| --- | --- |
| OS | Windows 11 (build 26200), MINGW64 / Git Bash available alongside PowerShell |
| Node | **v24.18.0** |
| Package manager | **npm 11.16.0** — pnpm, yarn, bun all absent |
| Git | 2.55.0.windows.3 |
| GitHub CLI | `gh` 2.98.0, **authenticated** as `Macpaul26`, token scopes `gist, read:org, repo, workflow` |
| Claude Code | **`@anthropic-ai/claude-code` v2.1.241** installed globally at `~/AppData/Roaming/npm/claude` |
| Anthropic API key | **`ANTHROPIC_API_KEY` is not set.** Only `CLAUDE_CODE_*` session vars are present |
| Existing project | `Macpaul26/newbreed-website` — clean, `main` at `e8a5b6e` |

Two consequences worth stating up front:

1. **npm is the package manager.** No lockfile-format debate; use npm workspaces if the repo ever splits.
2. **There is no standalone API credential yet.** The orchestrator's *reasoning* model needs one (`ANTHROPIC_API_KEY`, or an `ant auth login` profile). The *coding* half can run on the existing Claude Code subscription auth. See §8.

---

## 1. Architecture summary

Three layers, with a hard boundary between the two that reason and the one that writes code.

```
            ┌─────────────────────────────────────────────┐
   CLI ───▶ │  ORCHESTRATOR  (LangGraph StateGraph)       │
            │  understand → inspect → plan → [APPROVE]    │
            │  → implement → verify → review → [APPROVE]  │
            │  → update state → complete                  │
            └───────┬──────────────────────┬──────────────┘
                    │                      │
        typed, risk-classified tools       │ approved brief only
                    │                      ▼
            ┌───────▼────────┐   ┌─────────────────────────┐
            │  TOOL LAYER    │   │  CODING AGENT           │
            │  fs · git ·    │   │  @anthropic-ai/         │
            │  github · verify│  │  claude-agent-sdk       │
            └───────┬────────┘   └────────────┬────────────┘
                    │                         │
            ┌───────▼─────────────────────────▼────────────┐
            │  PROJECT  (durable, on disk, per project)     │
            │  context · decisions · tasks · history        │
            └──────────────────────────────────────────────┘
```

**The single most important design decision:** the orchestrator never trusts the coding agent's completion report. After every implementation run it independently inspects git state and runs project-declared verification commands. "Claude said it's done" is an input to review, never a conclusion.

### LangChain vs LangGraph — explicit division

These are frequently conflated. In this system they do different jobs and the boundary is deliberate:

| | Responsibility | Packages |
| --- | --- | --- |
| **LangGraph** | The entire workflow: state machine, node transitions, checkpointing, interrupt/resume. This is the backbone. | `@langchain/langgraph`, `@langchain/langgraph-checkpoint-sqlite` |
| **LangChain** | **Model provider abstraction only.** Chat model binding and message types, so a provider swap is a constructor change. | `@langchain/core`, `@langchain/anthropic` |

**We do not use LangChain agents, chains, executors, or its tool-calling loop.** Those hide control flow, and control flow is precisely what must be explicit and inspectable here. Every step is a named graph node we wrote.

---

## 2. Verified package versions

Checked against the npm registry on 5 September 2026 — not recalled:

| Package | Version | Role |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | **0.3.261** | Programmatic Claude Code |
| `@langchain/langgraph` | **1.4.14** | Workflow engine (1.x — stable) |
| `@langchain/langgraph-checkpoint-sqlite` | **1.0.4** | Durable workflow checkpoints |
| `@langchain/core` | 1.2.9 | Message/model interfaces |
| `@langchain/anthropic` | 1.5.9 | Anthropic chat model binding |
| `@octokit/rest` | 22.0.1 | GitHub REST (typed) |
| `zod` | **4.5.4** | Schema validation |
| `commander` | 15.0.0 | CLI argument parsing |
| `@clack/prompts` | 1.7.0 | Approval prompts |
| `pino` | 10.3.1 | Structured event logging |

> **`@anthropic-ai/claude-agent-sdk` is the correct package — not the API Tool Runner.** They are easy to confuse. The Tool Runner (`client.beta.messages.tool_runner` in `@anthropic-ai/sdk`) loops over tools *you* define with no filesystem access. The Agent SDK is Claude Code as a library: built-in Read/Write/Edit/Bash/Glob/Grep, permissions, hooks, sessions. We need the latter for implementation and the plain SDK (via LangChain) for reasoning.

---

## 3. Proposed directory structure

```
dev-orchestrator/
├── package.json
├── tsconfig.json
├── .env.example                  # names only, never values
├── docs/
│   └── ARCHITECTURE-PROPOSAL.md
├── src/
│   ├── cli/
│   │   ├── index.ts              # commander entry, REPL loop
│   │   ├── render.ts             # event stream → terminal
│   │   └── approval.ts           # approve / edit / reject prompts
│   ├── graph/
│   │   ├── graph.ts              # StateGraph wiring
│   │   ├── state.ts              # channel definitions + reducers
│   │   └── nodes/
│   │       ├── understand.ts     ├── implement.ts
│   │       ├── inspect.ts        ├── verify.ts
│   │       ├── plan.ts           ├── review.ts
│   │       ├── approvePlan.ts    ├── approveReview.ts
│   │       └── updateState.ts
│   ├── domain/                   # Zod schemas — the state model
│   │   ├── project.ts   task.ts   decision.ts   requirement.ts
│   │   ├── milestone.ts workflowRun.ts approval.ts
│   │   ├── reports.ts            # ImplementationReport, ReviewReport
│   │   └── risk.ts               # RiskLevel + policy
│   ├── tools/
│   │   ├── registry.ts           # tool defs + static risk metadata
│   │   ├── fs/                   # scoped read/search within project dir
│   │   ├── git/                  # status, diff, log, branch (read-first)
│   │   ├── github/
│   │   │   ├── read.ts           # repo, file, search, commit, PR, issue
│   │   │   └── write.ts          # separate module, HIGH risk, gated
│   │   └── verify/               # run project-declared check commands
│   ├── coding/
│   │   ├── claudeCode.ts         # Agent SDK adapter
│   │   ├── permissions.ts        # canUseTool gate
│   │   └── brief.ts              # approved plan → implementation brief
│   ├── models/
│   │   └── provider.ts           # getReasoningModel() — the swap point
│   ├── store/
│   │   ├── projectStore.ts       # durable project truth (JSON on disk)
│   │   └── checkpointer.ts       # SqliteSaver factory
│   ├── events/
│   │   ├── types.ts  bus.ts  sink.ts
│   └── config/
│       └── env.ts                # zod-validated environment
└── projects/
    └── <project-id>/
        ├── project.json          # identity, repo, working dir, checks
        ├── context.md            # long-form project context
        ├── decisions.md          # durable decisions (human-authored)
        ├── status.md             # human-readable snapshot
        ├── tasks/<task-id>.json
        └── history/<run-id>.jsonl
```

**`projects/` is data, not code.** Nothing Newbreed-specific ever enters `src/`. A project adapter is a directory, not a class.

---

## 4. State model

All schemas are Zod, giving runtime validation and inferred TypeScript types from one definition.

### Task lifecycle — the critical invariant

```ts
export const TaskStatus = z.enum([
  "PLANNED", "IN_PROGRESS", "IMPLEMENTED", "REVIEW", "APPROVED", "REJECTED",
]);
```

**`IMPLEMENTED` must never become `APPROVED` automatically.** This is enforced in code, not convention:

```ts
const AUTOMATIC: Record<Status, Status[]> = {
  PLANNED:     ["IN_PROGRESS"],
  IN_PROGRESS: ["IMPLEMENTED"],
  IMPLEMENTED: ["REVIEW"],
  REVIEW:      [],            // ← terminal for the machine
  APPROVED:    [], REJECTED: [],
};

// APPROVED and REJECTED are reachable ONLY via a HumanDecision carrying an
// approvalId. There is no code path from the graph into APPROVED.
```

### Core entities

| Schema | Key fields |
| --- | --- |
| **Project** | `id`, `name`, `repo {owner, name, defaultBranch}`, `workingDir`, `checks[]`, `constraints[]`, `contextFiles[]` |
| **Task** | `id`, `projectId`, `title`, `brief`, `status`, `milestoneId?`, `runIds[]`, `createdAt`, `updatedAt` |
| **Decision** | `id`, `code` (e.g. `D011`), `statement`, `rationale`, `supersedes?`, `decidedBy`, `decidedAt` |
| **Requirement** | `id`, `text`, `source`, `acceptanceCriteria[]` |
| **Milestone** | `id`, `name`, `taskIds[]`, `targetDate?` |
| **WorkflowRun** | `id`, `projectId`, `taskId?`, `threadId` (LangGraph), `phase`, `startedAt`, `endedAt?`, `outcome` |
| **ApprovalRequest** | `id`, `runId`, `kind` (`plan`\|`review`\|`tool`), `risk`, `summary`, `payload`, `createdAt`, `resolution?` |
| **ImplementationReport** | `claimedSummary` (what Claude said), `sessionId`, `turns`, `toolCalls[]`, **`observedDiff`**, **`observedFiles[]`**, **`observedCommits[]`** |
| **ReviewReport** | `verdict` (`pass`\|`changes_requested`\|`fail`), `findings[]`, `checkResults[]`, `scopeDrift[]` |

`ImplementationReport` deliberately separates **claimed** from **observed** fields. Anything prefixed `claimed` came from the model and is untrusted; anything prefixed `observed` came from git or a process exit code.

### Two persistence stores — different lifetimes

| Store | Contents | Backend | Survives |
| --- | --- | --- | --- |
| **Workflow checkpoints** | In-flight graph state, interrupt payloads | `SqliteSaver` (`.orchestrator/checkpoints.sqlite`) | Process restart mid-run |
| **Project store** | Projects, tasks, decisions, history | JSON + Markdown files under `projects/` | Everything; git-friendly, human-editable |

Keeping them separate matters: workflow checkpoints are disposable machine state; the project store is the durable record and should be diffable and hand-editable. A database can replace either later behind the `projectStore` interface without touching graph code.

---

## 5. Approval model

### Mechanism

LangGraph's `interrupt()` + `Command({ resume })`, verified against current docs:

```ts
import { interrupt, Command } from "@langchain/langgraph";

// inside a node
const decision = interrupt({ kind: "plan", risk, summary, payload: plan });

// caller resumes
await graph.invoke(new Command({ resume: decision }), config);
```

A **checkpointer is mandatory** for `interrupt()` to work. `SqliteSaver` gives durability across process death, which `MemorySaver` does not — so approval can be answered tomorrow, not just this session.

Each run has a `thread_id`; resumption is `{ configurable: { thread_id } }`.

### The four human decisions

| Decision | Effect |
| --- | --- |
| **approve** | Resume with the payload unchanged |
| **edit** | Resume with a *modified* payload (the plan is data, so the human can rewrite scope before it executes) |
| **reject** | Resume with a rejection; the graph routes to a terminal node and records the reason |
| **feedback** | Resume with commentary; the graph loops back to `plan` |

`edit` is why the plan must be structured data rather than prose — a human editing "which files may be touched" is the cheapest safety control in the system.

### Where approval is mandatory

Two fixed gates plus one dynamic:

1. **Plan approval** — before any implementation begins.
2. **Review approval** — before a task can reach `APPROVED`.
3. **Tool approval** — any tool classified `HIGH` interrupts, wherever it occurs, including *inside* a Claude Code run via `canUseTool` (§7).

Read-only inspection and running tests never interrupt.

---

## 6. Tool model and risk classification

```ts
export const RiskLevel = z.enum(["LOW", "MEDIUM", "HIGH"]);

export interface ToolDef<I, O> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  risk: RiskLevel;          // ← static, declared at definition
  readOnly: boolean;
  run(input: I, ctx: ToolContext): Promise<O>;
}
```

**Risk is a static property of the tool, never inferred by the model at call time.** The model cannot argue its way into a lower tier, and reviewing the risk policy means reading one file.

| Risk | Tools | Gate |
| --- | --- | --- |
| **LOW** | `fs.read`, `fs.search`, `git.status`, `git.diff`, `git.log`, `github.*` (read), `project.read`, `verify.run` | None |
| **MEDIUM** | `task.create`, `task.update`, `git.branch.create`, `plan.generate` | Logged; batched confirm |
| **HIGH** | any file write, delete, `git.commit`, `git.push`, `github` writes, decision changes, merge, deploy, config change | **Always `interrupt()`** |

Note `verify.run` is LOW **only because its commands come from `project.json`, not from the model.** See §8.

The registry is a plain map, so adding a tier or a tool is a data change.

---

## 7. Claude Code integration

`@anthropic-ai/claude-agent-sdk` — API confirmed against current docs.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const abort = new AbortController();

const run = query({
  prompt: brief,                       // the APPROVED plan, rendered
  options: {
    cwd: project.workingDir,           // scope: agent cannot see other projects
    model: "claude-opus-5",
    permissionMode: "default",         // NEVER "bypassPermissions"
    allowedTools: ["Read", "Grep", "Glob", "Edit", "Write"],
    disallowedTools: [
      "Bash(rm *)", "Bash(git push *)", "Bash(git reset --hard *)",
      "Bash(curl *)", "WebFetch",
    ],
    canUseTool: orchestratorGate,      // ← the enforcement point
    maxTurns: 60,
    abortController: abort,
    sessionId,                         // persisted BEFORE the run starts
  },
});

for await (const message of run) { events.emit(toEvent(message)); }
```

### `canUseTool` is the security seam

```ts
type CanUseTool = (request: {
  toolName: string; args: unknown; call: { id: string; index: number };
}) => Promise<{ allowed: boolean; reason?: string }>;
```

This callback fires whenever permission evaluation falls through to a prompt. It is where the orchestrator's own risk policy applies *inside* the coding agent — the same classification that governs orchestrator tools also governs Claude Code's tools. A `HIGH` action that was not in the approved plan can be refused, or escalated to a human, without the coding agent being able to bypass it.

### Not trusting the completion report

After the stream ends, `verify` runs independently:

1. `git status --porcelain` → files actually changed
2. `git diff --stat` and full diff → what actually changed
3. **Scope check**: observed files ∖ plan-declared files = **scope drift**, surfaced to the human
4. Run each command in `project.checks[]` and capture exit codes
5. Assemble `ImplementationReport` with `claimed*` and `observed*` side by side

Claude's summary is recorded as `claimedSummary` and shown to the reviewer clearly labelled as a claim.

### Resumability

`sessionId` is generated and **persisted to the WorkflowRun before the run starts**, so a crash mid-implementation is recoverable via `resume: sessionId`. Persisting it afterwards would lose exactly the case it exists for.

`listSessions()` / `getSessionMessages()` allow after-the-fact forensics on what the coding agent actually did.

---

## 8. Security model

| Boundary | Control |
| --- | --- |
| **Secrets** | Read from env / local config via a Zod-validated `config/env.ts`. Never interpolated into prompts, never written to graph state, never in the checkpoint DB, never logged. `.env` gitignored; `.env.example` holds names only. |
| **Filesystem** | Every fs tool resolves paths and asserts containment within `project.workingDir`. Claude Code is scoped by `cwd`. No absolute-path escapes, no `..` traversal. |
| **Shell** | No general shell tool is exposed to the reasoning model. Verification runs a **fixed allowlist from `project.json`**, not model-supplied strings. |
| **GitHub** | Read tools and write tools live in separate modules. Reads are LOW; every write is HIGH and interrupts. Prefer the existing `gh` auth or a fine-grained PAT; never request more scope than the project needs. |
| **Prompt injection** | **Repository content is untrusted input.** The orchestrator reads `docs/*.md`, issues, PR descriptions and diffs — all attacker-influenceable in principle. Repo content is passed as clearly delimited *data*, never as instructions; and because risk is static and approval is enforced by code paths, injected text cannot escalate privilege even if it persuades the model. |
| **Production** | Out of V1 entirely. No deploy tool, no production credentials, no CI trigger. |
| **Destructive defaults** | `permissionMode: "bypassPermissions"` is never used. Destructive bash patterns are on `disallowedTools`. |

The layered claim is simple: **even a fully compromised model cannot perform a HIGH action, because HIGH actions are gated by a code path that does not consult the model.**

---

## 9. Model abstraction

```ts
// src/models/provider.ts
export function getReasoningModel(cfg: ModelConfig): BaseChatModel {
  switch (cfg.provider) {
    case "anthropic": return new ChatAnthropic({ model: cfg.model, ... });
    case "openai":    return new ChatOpenAI({ model: cfg.model, ... });
  }
}
```

Nodes depend on `BaseChatModel` from `@langchain/core`, never on a concrete class. That is the entire provider boundary — and the only reason LangChain is a dependency at all.

**V1 primary reasoning model: `claude-opus-5`** with adaptive thinking and `effort` tuned per node — `low` for classification-ish nodes (understand), `high` for plan and review. The orchestrator's judgement quality is the whole product; this is not the place to economise. Effort is the tuning lever if cost becomes an issue.

**Claude Code remains the implementation specialist**, configured separately.

---

## 10. CLI design

`commander` for arguments, `@clack/prompts` for approval, a thin renderer over the event bus.

```
$ dev-agent

  Project: newbreed  (Macpaul26/newbreed-website @ main e8a5b6e)
  ? What would you like to do?  › The homepage feels repetitive.

  UNDERSTANDING     intent: refine · scope: homepage
  INSPECTION        read 6 files · docs/DECISIONS.md · src/components/home/
  PROPOSED PLAN     4 steps · touches 5 files
  RISKS             HIGH — modifies source in src/components/home/

  ? Approval required  › approve · edit · reject · feedback

  IMPLEMENTATION    claude code · session 4f2a… · 23 turns
  VERIFYING         ✓ typecheck  ✓ lint  ✓ tests  ✓ build
  REVIEW            verdict: pass · 0 scope drift

  ? Final approval  › approve · request changes
```

Every line is rendered from a structured event, so `--json` gives the same run as machine-readable output. Terminal text is a view, never the source of record.

`dev-agent resume <runId>` re-enters an interrupted run from its checkpoint.

---

## 11. Observability

A typed event union emitted to an in-process bus, with two sinks: the terminal renderer and a JSONL file at `projects/<id>/history/<runId>.jsonl`.

```ts
type OrchestratorEvent =
  | { type: "run.started";      runId; projectId; request }
  | { type: "node.entered";     node }
  | { type: "tool.called";      tool; risk; input }
  | { type: "tool.result";      tool; ok; durationMs }
  | { type: "approval.requested"; approvalId; kind; risk }
  | { type: "approval.resolved";  approvalId; decision; editedPayload? }
  | { type: "coding.started";   sessionId; cwd }
  | { type: "coding.message";   kind; summary }
  | { type: "verify.result";    check; exitCode; durationMs }
  | { type: "review.completed"; verdict; findings }
  | { type: "run.completed";    outcome };
```

This satisfies §13 of the brief directly: request, inspection, plan, approval, tool calls, coding activity, tests, review, final state — all structured. LangSmith can subscribe to the same bus later; it is not a dependency.

---

## 12. V1 scope — explicitly bounded

**In:**

- One CLI binary; local only
- Multi-project via `projects/` directories; Newbreed as first adapter
- The full nine-node graph with SQLite checkpointing and durable resume
- Plan approval and review approval interrupts, with approve/edit/reject/feedback
- LOW/MEDIUM/HIGH risk classification enforced on both orchestrator tools and Claude Code's tools
- Read-only tools: fs (scoped), git, GitHub via Octokit
- Verification via project-declared check commands
- Claude Code implementation with bounded turns, cancellation, session persistence
- Independent git-state inspection and scope-drift detection
- JSONL event history

**Out (deliberately):**

- Web dashboard · database · multi-agent orchestration · autonomous deployment
- GitHub write operations (PR creation, merge) — reads only in V1
- Parallel or background runs · cost tracking/budgets · LangSmith
- Any modification to the Newbreed repository

### Implementation phases

| Phase | Deliverable | Proves |
| --- | --- | --- |
| **1** | Skeleton: config, env validation, domain schemas, project store, `projects/newbreed` loaded read-only | The state model holds real data |
| **2** | Graph walking skeleton: all nodes stubbed, SQLite checkpointing, one `interrupt()`, `resume` working | **Durable human-in-the-loop** — the riskiest assumption |
| **3** | Read-only tool layer + registry + risk policy; `inspect` node genuinely reads the repo | Inspection without any write capability |
| **4** | Claude Code adapter behind a `--dry-run` that renders the brief but does not execute | Brief construction is reviewable before it can act |
| **5** | Live implementation with `canUseTool` gate, bounded turns, cancellation | The coding boundary |
| **6** | Verify + review: independent git inspection, check execution, scope drift | **The don't-trust-the-report guarantee** |
| **7** | CLI polish, event sinks, `resume` UX | Usable daily |

Phase 2 first because durable interrupt/resume is the assumption most likely to be wrong, and everything else depends on it.

---

## 13. Risks and trade-offs

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Agent SDK is 0.3.x (pre-1.0)** | High | Confine all SDK usage to `coding/claudeCode.ts`. Pin exactly. Expect churn. |
| **Claude Code runs are not checkpointable mid-flight** | High | LangGraph can checkpoint *around* the run but not *inside* it. Persist `sessionId` before starting; recover with `resume`. Accept that a crash mid-implementation costs that run. |
| **Two model bills** | Medium | Opus 5 orchestration + Claude Code implementation. Tune `effort` per node; cheap models for the understand node if needed. Measure before optimising. |
| **Nondeterministic planning** | Medium | Mitigated by design, not by prompting: the human approves and can *edit* the plan; scope drift is detected mechanically afterwards. |
| **Prompt injection from repo content** | Medium | Untrusted-data framing plus code-enforced risk gates (§8). |
| **Windows path handling** | Low | MINGW vs Win32 path separators. Normalise once in the fs layer; test containment on Windows specifically. |
| **Over-engineering** | Medium | V1 scope above is a contract. No dashboard, no DB, no multi-agent. |
| **`ANTHROPIC_API_KEY` absent** | Blocking for Phase 1 | Needs a key or `ant auth login` before the reasoning model can run. |

---

## 14. Unresolved questions

1. **API credential** — the orchestrator's reasoning model needs its own `ANTHROPIC_API_KEY` (or `ant auth login` profile). Claude Code's subscription auth does not cover direct API calls. Which do you want to use?
2. **Repository placement** — should `dev-orchestrator` become its own GitHub repository, and should it be private?
3. **Does the orchestrator commit?** Two options: (a) it stops at a verified working tree and the human commits; (b) it commits on a branch after review approval. (a) is safer for V1; (b) is more useful. My recommendation is (a) for V1, (b) behind a project flag afterwards.
4. **Newbreed adapter timing** — build the adapter now (read-only, no writes) or after Phase 6?
5. **Cost ceiling** — is there a per-run budget I should design toward now rather than retrofit?

---

## 15. Recommended next task

**Phase 1 + 2 together: skeleton plus a durably-resumable walking graph.**

Concretely: project scaffold, Zod domain schemas, file-backed project store, a nine-node `StateGraph` with every node stubbed, `SqliteSaver` checkpointing, a single real `interrupt()` at plan approval, and a CLI that can be `Ctrl-C`'d mid-approval and resumed in a *new process* with `dev-agent resume <runId>`.

No model calls, no Claude Code, no file writes. It proves the one assumption everything else rests on — that human-in-the-loop survives a process restart — before any capability that can modify a repository exists.

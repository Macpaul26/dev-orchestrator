# dev-orchestrator

A general-purpose AI Development Orchestrator.

The orchestrator coordinates software development work across projects: it
loads project context, plans, **asks a human before anything consequential**,
delegates implementation, and then independently checks what actually changed.

It is not tied to any one project. A project is a configuration directory under
`projects/`, never a class in the core.

## Guiding principle

> The coding agent's report is never authoritative.

The orchestrator inspects git state for itself. "The agent says it is done" is
evidence for review, never proof of completion. `ImplementationReport` keeps
`claimed*` and `observed*` fields separate, and there is no code path that
writes a claim into an observation.

The corollary, and the reason repository inspection came before any
implementation capability:

> **Observe independently first. Act later.**

## Current status

**Phase 3 is implemented: secure, read-only repository intelligence.**

Real: the workflow, checkpointing, approval interrupts, project store, the
filesystem security boundary, read-only git inspection, independent
claimed-vs-observed verification, and deterministic scope-drift detection.

Not real, deliberately: there is no coding agent, no model call, no GitHub
access, no shell execution, no check execution, and **no way for this system to
modify a repository**.

```
$ node dist/cli/index.js tools
write capabilities registered: false
shell execution available: false
check execution enabled: false
```

Tests assert each of those.

| Document | Covers |
| --- | --- |
| [docs/PHASE-3.md](docs/PHASE-3.md) | Repository inspection, the security boundary, symlink handling, sensitive-file policy, scope semantics, evidence provenance |
| [docs/PHASE-1-2.md](docs/PHASE-1-2.md) | The workflow, durable resume, the approval invariant |
| [docs/ARCHITECTURE-PROPOSAL.md](docs/ARCHITECTURE-PROPOSAL.md) | The overall design |

## Quick start

```bash
npm install
npm run build

# workingDir is the security boundary. Nothing outside it can be read.
node dist/cli/index.js project:create --id my-app --name "My App" --dir /path/to/repo

# One read-only inspection pass.
node dist/cli/index.js inspect --project my-app

node dist/cli/index.js start --project my-app --request "Describe the change"
node dist/cli/index.js runs
node dist/cli/index.js resume --run <runId> --decision approve
```

## Security posture

| Control | State |
| --- | --- |
| Path containment | Lexical **and** physical - symlinks and Windows junctions resolved before the check |
| Repository writes | None. No write method exists on any interface. |
| Git | Read-only allowlist; every mutating subcommand rejected |
| Repository-controlled git config | `--no-ext-diff` / `--no-textconv` forced onto every diff, plus pinned `-c` overrides — a hostile repo cannot make inspection run its programs |
| Shell | None. `spawnSync` with `shell: false` and an argv array; `git` is the only executable. |
| Secrets in the child environment | None. The environment is built, not inherited. |
| Secrets in state / checkpoints / history | Sensitive files are reported by name; contents are never captured. |
| Write-capable tools | None registered. Asserted by test. |
| Model calls | None. No API key is read or required. |

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile to `dist/` |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint |
| `npm test` | Vitest, including real cross-process restart tests |
| `npm run dev` | Run the CLI from source via tsx |

`npm test` requires `npm run build` first — the restart tests spawn the built
CLI as separate OS processes.

## Requirements

Node >= 22 (developed on 24.18.0). No API keys are needed for this phase.

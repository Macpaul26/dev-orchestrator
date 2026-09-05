# dev-orchestrator

A general-purpose AI Development Orchestrator.

The orchestrator coordinates software development work across projects: it
loads project context, plans, **asks a human before anything consequential**,
delegates implementation, and then independently checks what actually changed.

It is not tied to any one project. A project is a configuration directory under
`projects/`, never a class in the core.

## Guiding principle

> The coding agent's report is never authoritative.

When implementation is eventually delegated, the orchestrator inspects git state
and runs project-declared checks itself. "The agent says it is done" is evidence
for review, never proof of completion. `ImplementationReport` keeps `claimed*`
and `observed*` fields separate so the two can never be quietly conflated.

## Current status

**Phase 1+2 is implemented: the foundation and durable human-in-the-loop.**

The workflow, state model, checkpointing, approval interrupts and project store
are real. Implementation capability is not: there is no coding agent, no model
call, no GitHub access, and no way for this system to modify a repository.

See [docs/PHASE-1-2.md](docs/PHASE-1-2.md) for what exists and what does not,
and [docs/ARCHITECTURE-PROPOSAL.md](docs/ARCHITECTURE-PROPOSAL.md) for the
overall design.

## Quick start

```bash
npm install
npm run build

node dist/cli/index.js project:create --id my-app --name "My App" --dir /path/to/repo
node dist/cli/index.js start --project my-app --request "Describe the change"
node dist/cli/index.js runs
node dist/cli/index.js resume --run <runId> --decision approve
```

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

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

**Phase 4B.2 is implemented: the controlled tool bridge.**

Claude Code can now act on a repository — but only through four typed,
grant-bound operations (`read_file`, `list_directory`, `write_file`,
`delete_file`) that run through the Phase 4A session. It never receives a raw
filesystem API, and the request protocol has no field for a grant, project,
session, scope or budget, so authority is not something it can name.

**Task 007 is implemented: the controlled reasoning context.**

The context a reasoning model receives is now assembled in one place, with every
record carrying its PROVENANCE - human decision, human constraint, trusted
project fact, repository observation, task description, or untrusted agent claim
- and an authority rank the orchestrator compares itself rather than asking the
model to. Bounded, deterministically ordered, deduplicated within provenance but
never across it.

A human decision or constraint is never silently dropped: if it will not fit,
assembly FAILS. Non-critical material may be dropped and the drop is stated in
the prompt. A credential-shaped value is refused rather than redacted, and no
file contents are sent at all. See [docs/PHASE-007.md](docs/PHASE-007.md).

**Task 006 is implemented: the controlled reasoning boundary.**

The orchestrator can now use a language model to propose a plan - objectives,
requirements, scope, verification expectations, risks and open questions -
instead of the deterministic stub it used before.

The model is **UNTRUSTED and proposes only**. It has no tool, no filesystem, no
shell, no network and no grant. Its output is size-bounded, strictly
schema-validated (a response carrying `approved` or `capabilities` is rejected
in full), and then rebuilt field by field by trusted code that computes risk
itself and re-checks every proposed path against the real scope rules. A model
failure yields a zero-scope plan. The human plan gate is unchanged.

**Prompt injection is not solved by prompting**, and the documentation does not
claim it is - the controls are the schema, the rebuild and the human gate. See
[docs/PHASE-006.md](docs/PHASE-006.md).

Unconfigured is the default: without `ANTHROPIC_API_KEY` the workflow uses the
deterministic plan that authorises no scope.

**Task 005 is implemented: controlled verification execution.**

The orchestrator now runs a bounded, explicitly authorised set of project checks
itself, so it can establish whether the resulting software passes them rather
than taking an agent's word for it. Checks are `{ executable, args }` from
trusted configuration - never a command string, never chosen by an agent - and
the policy is fingerprinted BEFORE the untrusted run, so an agent that rewrites
the check definitions gets execution blocked rather than executed.

`shell: false`, an argv array, a built environment carrying no credentials, a
bounded working directory, a hard timeout and bounded output. The repository is
re-inspected afterwards, because a verification command is executable code.

**This is controlled process execution, not a sandbox**, and an unrun check is
never a passing check. See [docs/PHASE-005.md](docs/PHASE-005.md), including the
limitations: network is not actually blocked, and descendant processes may
survive termination.

**Phase 4B.1 is implemented: the controlled Claude Code process boundary.**

Claude Code can now be launched as an untrusted implementation agent behind a
controlled adapter — fixed executable from trusted configuration, no shell, a
built environment carrying no credentials, and a bounded working directory. It
receives **no repository tools**; that bridge is 4B.2. Its output is a claim, and
repository state is still established by independent inspection.

**This is not a sandbox.** The child is an ordinary OS process with the launching
user's privileges. See [docs/PHASE-4B1.md](docs/PHASE-4B1.md) for what that means.

**Phase 4A is implemented: the controlled-hands foundation.**

Real: the workflow, checkpointing, approval interrupts, project store, the
filesystem security boundary, read-only git inspection, independent
claimed-vs-observed verification, deterministic scope-drift detection, and -
new in this phase - **bounded repository writes that require a human-approved,
expiring, scope-bound grant**, an orchestrator-written activity journal, a
project-level implementation lock, and durable implementation lifecycle state.

Not real, deliberately: no GitHub access, no arbitrary shell or process
execution, no git mutation, no autonomous approval. A reasoning model may now be
configured, but it only ever produces a proposal for a human to read. Writing
requires a grant that only a human approval can produce; there is no global
"implementation enabled" switch anywhere.

```
$ node dist/cli/index.js tools
write capabilities registered: false
shell execution available: false
process execution available: false
git mutation available: false
network access available: false
legacy string-command checks executable: false
```

Tests assert each of those.

| Document | Covers |
| --- | --- |
| [docs/PHASE-007.md](docs/PHASE-007.md) | The controlled reasoning context: provenance, authority precedence, bounds and fail-closed truncation, deterministic ordering, deduplication, and sensitive-data refusal |
| [docs/PHASE-006.md](docs/PHASE-006.md) | The reasoning boundary: why model output is never authority, the strict schema and trusted rebuild, the prompt-injection posture, credential handling, and fail-closed behaviour |
| [docs/PHASE-005.md](docs/PHASE-005.md) | Controlled verification execution: predefined checks, the trusted policy fingerprint, process bounding, the seven outcomes, post-check inspection, and what is detected rather than prevented |
| [docs/PHASE-4B3.md](docs/PHASE-4B3.md) | The complete controlled implementation loop: the four-compartment evidence model, git-mutation and sensitive-change detection, and the human review gate |
| [docs/PHASE-4B2.md](docs/PHASE-4B2.md) | The controlled tool bridge: the four-operation protocol, per-invocation authorisation, path and budget enforcement, protocol hardening, and the hostile-agent tests |
| [docs/PHASE-4B1.md](docs/PHASE-4B1.md) | The Claude Code adapter, the process boundary, environment isolation, output provenance, cancellation — and precisely what the boundary does *not* protect |
| [docs/PHASE-4A.md](docs/PHASE-4A.md) | The capability model, implementation grants, the write boundary, the activity journal, cancellation, process death, concurrency, and why Claude Code is not integrated yet |
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
| Write-capable tools | Only from a human-approved grant, bound to one run and one scope. None otherwise; asserted by test. |
| Capability escalation | The session uses native `#` private fields; the grant is deep-frozen. No cast reaches the unchecked writer, the grant, or the journal. |
| Concurrent mutation | Project-level lock, atomically acquired. A stale lock fails closed and needs a human. |
| Agent tool access | Four typed operations through the Phase 4A session. No raw `fs`, no shell, no git, no network. Authority fields are unrepresentable in the protocol. |
| Agent process | Untrusted. Fixed executable, `shell: false`, built environment with no credentials, bounded cwd, terminable. Spawning stays confined to two enumerated adapters. |
| Rollback | **None, and none claimed.** Every non-clean terminal state keeps `partialChangesPossible`, and verification always runs. |
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

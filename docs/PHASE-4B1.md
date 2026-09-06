# Phase 4B.1 — Claude Code Adapter + Process Boundary

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

Phase 4A built hands the orchestrator controls. Phase 4B.1 builds the doorway
through which a real coding agent will eventually reach them — and proves the
doorway holds before anything is allowed through it.

> **Claude Code is an untrusted implementation agent. Its claims are not
> observations. Repository state and verification results are established
> independently by the orchestrator.**

---

## What this phase delivers

The adapter, the process boundary, and lifecycle/cancellation integration.

**It does not give Claude Code any repository tools.** The child receives a
description of what it is authorised to do and no mechanism for doing it. The
controlled bridge to the Phase 4A session is 4B.2. The boundary is proven first.

---

## 1. Architecture

```
HUMAN ── approval ──▶ GRANT (Phase 4A: one-shot, scoped, expiring)
                          │
                   ControlledImplementationRunner
                          │  lock · claim · session · journal · lifecycle
                          ▼
                   ClaudeCodeAgent          adapters/claude-code/agent.ts
                          │  turns a bounded session into a bounded process
                          ▼
                   launchAgentProcess       adapters/claude-code/processBoundary.ts
                          │  argv · no shell · built env · fixed cwd
                          ▼
                     CLAUDE CODE            untrusted OS process
```

The adapter is deliberately separate from the runner. The runner owns
authorisation and lifecycle; the adapter owns *how a process is started and what
is believed afterwards*. Neither knows the other's internals.

`ClaudeCodeAgent` implements Phase 4A's existing `ImplementationAgent`. The
Phase 1+2 `CodingAgent` placeholder — which predated the lifecycle and was
referenced nowhere — has been replaced rather than left as a second, competing
notion of what an agent is.

## 2. Process invocation

| Control | Implementation |
| --- | --- |
| No shell | `spawn(exe, argv, { shell: false })`. No command string is ever built. |
| Executable | Trusted configuration only. Absolute path, re-validated at every launch. |
| Arguments | Fixed `baseArgs` from configuration. The request contributes none. |
| Request payload | JSON on **stdin**, not argv — data that never needs quoting. |
| Working directory | One authorised path (§4). |
| Lifetime | Bounded by `timeoutMs`, observable, terminable. |
| Exit | Captured from the OS: pid, exit code, signal, duration. |

There is **no PATH lookup and no default executable.** A bare name would let
whatever happens to be earliest on `PATH` become the implementation agent. Absent
configuration the adapter refuses to launch, which is why the orchestrator's
default posture is unchanged: no agent is connected unless somebody connected one.

`ImplementationRequest` has no executable, command, or argv field. A test passes
`executable`, `command`, `argv` and `baseArgs` in a request and asserts the
configured agent ran and the smuggled one did not.

## 3. Environment isolation

The child's environment is **built, never inherited**:

- a fixed base passthrough (`PATH`, `SystemRoot`, `TEMP`, `HOME`, `LANG`, …) —
  what a program needs merely to start, and nothing that authenticates anybody
- plus exact names an operator explicitly allowlisted — **empty by default**
- plus `CI=1`, `TERM=dumb`, `NO_COLOR=1`, `GIT_TERMINAL_PROMPT=0`

A **denylist overrides the allowlist**: cloud and forge prefixes (`AWS_`,
`AZURE_`, `GOOGLE_`, `GH_`, `GITHUB_`), model-provider prefixes (`ANTHROPIC_`,
`OPENAI_`), any name containing a `KEY` / `TOKEN` / `SECRET` / `PASSWORD` /
`CREDENTIAL` / `AUTH` / `SESSION` / `COOKIE` segment, `DATABASE_URL`, `DB_*`, and
`ORCHESTRATOR_*`.

> The first version of that denylist omitted `KEY`, so every `*_API_KEY` — the
> single most common shape of the thing it exists to stop — passed straight
> through. The test caught it. Matching is on whole underscore-delimited
> segments, so `KEYBOARD_LAYOUT` and `MONKEY_MODE` are unaffected.

### Consequence: no credential reaches the agent in this phase

Real Claude Code needs credentials to authenticate, and this phase does not hand
any over. That is the **fail-closed** position the brief calls for, not an
oversight: 4B.1 delivers the boundary, not an authenticated session. Wiring real
authentication means editing `config.ts` — a reviewable change with its own
decision — rather than setting an environment variable.

## 4. Working-directory boundary

The **runner** sets the working directory to the project's own `workingDir` and
discards whatever a caller put in the request. "Which directory does the agent
get?" is not a question a caller can answer.

The launch additionally refuses a directory that **contains** the orchestrator's
project store or home. A project pointed at a parent of the store would hand the
agent its own grants and audit trail as ordinary files — a configuration mistake
that is invisible until it matters.

No second filesystem-security implementation was added; the authorised path is
the same one Phase 4A's `FsBoundary` was built around.

## 5. Output provenance

| Source | Trust | Where it goes |
| --- | --- | --- |
| stdout / stderr / structured report | **Claim** | `AgentReport` only |
| pid, exit code, signal, duration | Observation *about the process* | `AgentProcessResult` |
| What actually changed | Observation *about the repository* | Phase 3 inspection |

The middle row is the subtle one. `exitCode: 0` is a fact the kernel reported —
but it is a fact about a program returning, **not** about a repository. The
adapter never lets it become one: a zero exit does not set `claimsSuccess` on the
agent's behalf, and a non-zero exit does not clear a success the agent asserted.
Those are separate assertions from separate sources.

Agent summaries are prefixed `AGENT-REPORTED (untrusted, not verified):` so
anything reading the record later — a human, or a model in a later phase — is
told whose words these are before it reads them.

### Output is not retained by default

Durable records carry byte counts, a hash, and a truncation flag — enough to see
that the agent was verbose, silent, or identical across runs, without reproducing
a single byte. `retainOutputExcerpt` is **off by default**, because agent output
is attacker-influenced text that may carry secrets the agent read, and in later
phases it becomes model context, where retained text is an injection surface.

Capture is bounded (`maxOutputBytes`, default 256 KB); beyond that, bytes are
counted and discarded, so a hostile agent cannot exhaust memory by printing.

## 6. Cancellation

Phase 4A's `CancellationToken` was cooperative — enough for an in-process agent,
which cannot write without asking. A child process keeps running whether or not
anyone polls a boolean, so the token gained **listeners** (additive; existing
behaviour unchanged) and the adapter subscribes one that sends a signal.

```
cancel() → agent_termination_requested → SIGTERM
         → wait gracefulTerminationMs
         → SIGKILL if still alive        → agent_terminated (forciblyKilled)
         → observe the ACTUAL exit       → run status `cancelled`
```

A cancelled run keeps Phase 4A's semantics exactly: partial changes possible,
**no rollback claimed**, grant consumed, **verification still mandatory**, and no
replacement grant. Tested.

## 7. Failure and process states

`started · running · completed · failed · cancelled · interrupted · launch_failed`

`cancelled` requires that *we* asked. A process that died on a signal nobody sent
is `interrupted` — a distinct fact, because something outside the orchestrator
killed it and the repository may be mid-edit. Launch failures are classified
separately (`not_configured`, `executable_missing`, `working_dir_unsafe`, …) and
record that **nothing started**.

## 8. Activity events

`agent_launch_attempted` · `agent_started` · `agent_exited` ·
`agent_launch_failed` · `agent_termination_requested` · `agent_terminated`

Metadata only: pid, exit code, signal, duration, byte counts, and the executable
**basename** — never the configured path, never stdout, never the environment.
The agent cannot write, suppress, or delete any of them.

## 9. Capabilities are unchanged

```
$ npm run tools
git.mutate        NOT IMPLEMENTED
process.execute   NOT IMPLEMENTED
network.access    NOT IMPLEMENTED

write capabilities registered: false
shell / process / git mutation / network execution available: false
```

**Launching the specifically configured adapter is not `process.execute`.** One
is an orchestrator-controlled integration with a fixed executable, fixed
arguments, a built environment and a bounded directory. The other would be
permission to run arbitrary programs. Turning on the latter because the former
exists would be exactly the collapse this capability model was built to prevent.

Process spawning remains confined to **two enumerated adapters** — read-only git,
and this boundary. The Phase 3 test that asserted one site now asserts those two:
updated, not removed, and still an exact list.

---

## What this boundary does NOT protect — read this part

**It is not a sandbox.** There is no OS-level containment: no container, no
seccomp, no job object, no separate user.

Once running, the child is an ordinary process with the launching user's
privileges. It can:

- **read and write files anywhere that user can**, including outside the working
  directory — the cwd is where it *starts*, not a jail
- **open network sockets**
- **start processes of its own**, including a shell
- **outlive its parent's expectations** in ways signals alone cannot prevent

`shell: false` governs how *we* start it. It says nothing about what it does
next. Claude Code in particular runs tools internally, so "no shell was used to
launch it" must not be read as "it cannot reach a shell".

**This is exactly why nothing it says is believed.** The containment that matters
in this architecture is not the process boundary — it is that repository state is
established afterwards by independent inspection, and that the human approval
gate is downstream of that. A test demonstrates the honest version: the fake
agent writes a file directly, denies doing so, and Phase 3 attribution reports it
anyway.

Real OS-level sandboxing is not in this phase and is not claimed by it.

## Known limitations

1. **No OS-level sandbox** — as above. The single most important caveat here.
2. **No credentials reach the agent**, so a real Claude Code session cannot
   authenticate under the default configuration. Deliberate (§3).
3. **Windows has no signals.** `child.kill("SIGTERM")` calls `TerminateProcess`,
   so the child's handler never runs and the first attempt is already forcible —
   no escalation is observed because none is needed. Correspondingly, a death
   nobody requested reports as an ordinary non-zero exit and classifies as
   `failed` rather than `interrupted`, because the platform provides no signal to
   distinguish them. The tests assert the invariant that holds everywhere and the
   platform-specific detail separately, rather than asserting information the OS
   does not provide.
4. **No process-group termination.** Killing the agent does not kill grandchildren
   it started. Doing that properly needs a job object on Windows and a process
   group on POSIX; neither is in this phase.
5. **The agent gets no repository tools**, so it cannot do useful work yet. That
   is the phase boundary, not an omission — see 4B.2.
6. **`timeoutMs` bounds one run**, but a wedged child that ignores termination on
   a platform without reliable signals is bounded only by that timeout.

# Phase 4B.2 — Controlled Tool Bridge

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

Phase 4B.1 built the doorway. Phase 4B.2 is what an untrusted agent may carry
through it.

> **Claude Code never receives a raw filesystem API.**

> **The controlled tool bridge is not a general-purpose shell or filesystem API.**

---

## 1. Architecture

```
Claude Code (untrusted OS process)
    │  JSON line on fd 3
    ▼
processBoundary  ── bounded framing, serialised, size-capped
    │
    ▼
ToolBridge       ── protocol validation; holds ONE trusted session
    │
    ▼
ImplementationSession (Phase 4A, unchanged)
    ├── grant validity, per invocation
    ├── store-backed authority re-check
    ├── capability
    ├── scope
    ├── sensitive-file policy
    ├── mutation budget
    ├── FsBoundary (lexical + physical)
    └── activity journal
    │
    ▼
bounded repository operation
    │
    ▼
Phase 3 independent verification
```

Nothing in the enforcement path is new. The bridge adds a protocol and reuses
Phase 3/4A wholesale — deliberately, because a second filesystem-security
implementation would eventually disagree with the first, and the disagreement
would be the vulnerability.

### The transport

Protocol travels on **fd 3**, not stdout. Sharing stdout would mean narrative and
protocol arrive on one stream and something has to tell them apart — a stray line
of prose could parse as a request, and protocol traffic would inflate the "agent
output" counters. Separate descriptors make that impossible rather than unlikely:

| Channel | Direction | Contents |
| --- | --- | --- |
| stdin | orchestrator → child | line 1 is the session payload, then tool responses |
| **fd 3** | child → orchestrator | tool requests, one JSON per line |
| stdout / stderr | child → orchestrator | untrusted narrative **only** |

**stdin stays open**, because it is how responses get back. A child therefore
reads it **line by line and must not read it to EOF** — the close does not come
until the run is over. That is the contract, and it cost two test failures and a
1900-second suite to pin down: the fixture read stdin to EOF, blocked forever,
and every affected test sat there until its timeout.

Responses deliberately do **not** go back out on fd 3, which was the obvious
alternative. Writing to the parent's end of a fourth pipe on Windows stops the
`ChildProcess` `exit` and `close` events firing at all — the child terminates,
the orchestrator never learns of it, and the run hangs until its timeout. That
was measured with an instrumented probe (child exited at 396 ms; neither event
had fired 15 seconds later), not assumed.

Requests are **serialised**. Handling them concurrently would let an agent
interleave operations against shared session state — the mutation counter, the
duplicate-id set — and make response order depend on timing. One at a time makes
the boundary deterministic.

## 2. Available operations

Four. That is the entire vocabulary.

| Tool | Capability | Bounds |
| --- | --- | --- |
| `read_file` | `repo.read` | in scope; sensitive withheld; 256 KB |
| `list_directory` | `repo.metadata.read` | 500 entries |
| `write_file` | `repo.file.write` | in scope; not sensitive; grant byte limit; budget |
| `delete_file` | `repo.file.delete` | in scope; not sensitive; budget; files only |

There is no `execute`, `command`, `shell`, `run`, `bash`, `spawn`, `eval`, `git_*`,
`fetch`, `http` or `deploy`. Not disabled elsewhere — **absent from the enum**, so
a request naming one fails schema validation before any authorisation code runs.

`write_file` takes `path` and `contents` and nothing else: no encoding, no mode,
no flags, no `followSymlinks`. Every one of those would be a knob an untrusted
caller could turn, and none is needed.

## 3. Authority is structurally unrepresentable

A `ToolRequest` has **no field** for `grantId`, `projectId`, `runId`, `sessionId`,
`allowedScope`, `capabilities`, `workingDir`, or a budget — and every schema is
`.strict()`, so sending one is a **parse error**, not an ignored key.

That is the design. If an agent could *name* a grant, the system would depend on
somebody remembering never to trust the name. Instead the bridge holds exactly
one session, fixed at construction by trusted code.

> The agent may ask *"read src/foo.ts"*. It cannot ask *"read src/foo.ts using
> grant X in project Y"*.

"Session confusion" is therefore not defended against with a check — it is not
expressible. Twelve forgery attempts are tested individually, plus forged fields
nested inside `arguments`.

## 4. Authorisation happens per invocation

Every request re-enters the session, which re-validates fingerprint, binding,
status and expiry before doing anything.

### A gap found and closed while building this

The session validated its **frozen in-memory** grant. That is what makes
fingerprint and expiry checks cheap and tamper-proof — but an in-memory copy
cannot notice that the record on disk was revoked, deleted, or claimed by a
different attempt. A grant invalidated mid-session kept working.

`StoredGrantAuthority` now re-checks the authoritative record on **every**
capability use: grant still present, fingerprint unchanged, not revoked, and the
claim in force is still *the claim that authorised this session*.

That last clause matters. A grant is consumed the instant its own attempt claims
it — *before* the agent runs — so denying on `consumed` would deny the very
attempt the claim authorised. The question is not "is it consumed?" but "is the
claim that authorised me still in force?". Claims now carry an id for exactly
that. Tested by consuming a grant underneath a live session.

## 5. Path enforcement

Every path goes through Phase 3's `FsBoundary` via the session. Rejected:
`../` traversal, nested traversal, absolute POSIX paths, Windows drive paths, UNC
paths, prefix collisions, paths outside the granted scope, symlink escapes,
junction escapes, dangling links, and paths resolving into the orchestrator's own
store.

`toolBridge.ts` contains **no `fs` import and no `child_process` import**, and a
test asserts it. The regression that guards against: replacing a handler with
`fs.readFile(path)` would bypass grant, capability, scope, sensitivity, budget
*and* the journal in one edit, and would not look obviously wrong.

## 6. Sensitive files

Reuses the Phase 3 policy unchanged. Contents are never returned, never written,
never deleted, and never journaled. A listing still reports that a sensitive file
*exists* — metadata is not disclosure — but `read_file` returns
`available: false` with a reason and `contents: null`.

Refusal messages are drawn from a fixed vocabulary and name a **category**, not
the path, the grant id, or the limit. The detailed reason goes to the activity
journal, which the agent cannot read.

## 7. Mutation budgets

The Phase 4A budget, unchanged and not duplicated. `mutationsUsed` and
`mutationsAllowed` are reported so an agent can pace itself; both are counted by
the orchestrator and neither can be changed by anything the agent sends.

Boundary conditions are tested exactly: *N* mutations allowed, *N+1* refused;
a file exactly at the byte ceiling accepted, one byte more refused; deletes
counted against the same budget.

## 8. Protocol hardening

| Limit | Value |
| --- | --- |
| One protocol line | 1 MB — **enforced by the framing layer** |
| Path | 4096 chars |
| `write_file` contents | 1 MB (the grant's limit is separate and lower) |
| Requests per session | 10,000 |
| `read_file` response | 256 KB |
| `list_directory` response | 500 entries |

`BoundedLineReader` throws once a pending fragment passes the limit rather than
growing the buffer — a child that writes gigabytes and never sends a newline
gets its run ended, not the orchestrator's memory. Tested with a 2 MB
unterminated line.

Malformed JSON, invalid shapes, unknown tools, wrong argument types, missing or
oversized request ids, and duplicate ids all produce structured refusals. The
bridge **never throws** for hostile input: an exception escaping there would take
down the orchestrator on input the agent fully controls. A valid request sent
*after* a stream of garbage still works — tested.

## 9. Cancellation and concurrency

Cancellation is checked **before** each handler, so it stops new work starting
rather than being noticed after. Once cancelled, every tool refuses with
`cancelled`. The Phase 4A semantics are unchanged: partial changes possible, **no
rollback claimed**, grant consumed, no replacement grant, verification still
mandatory.

Concurrency uses the existing project lock — no second locking mechanism. Session
confusion is prevented structurally (§3) rather than by comparing identifiers.

## 10. Activity

`bridge_request_completed` (requestId, tool, capability, repository-relative
path, ok, denial) and `bridge_request_rejected` (requestId, code), alongside the
session's own `tool_invoked` / `write_denied` records.

Never logged: file contents, arguments, raw protocol payloads, secrets,
environment, stdout/stderr, absolute host paths. The bridge's methods are native
`#` private, so a reachable `journal()` could not be used to forge or suppress
records — a test asserts the absence.

## 11. Agent claims are still claims

A `tool_completed` response means *the orchestrator performed an operation*. It
does not mean the task is done, correct, or complete. Phase 3 verification
remains authoritative and mandatory.

Tested end-to-end: a hostile child is refused a write to `protected.ts`, then
reports "Updated protected.ts and ran the full test suite; all 412 passed" and
claims two files it never touched. The claim is preserved as a claim; attribution
reports `src/real.ts` and nothing else; `protected.ts` is byte-identical.

## 12. Capabilities unchanged

```
git.mutate       NOT IMPLEMENTED
process.execute  NOT IMPLEMENTED
network.access   NOT IMPLEMENTED

write capabilities registered: false
shell / process / git mutation / network: false
```

Spawning remains confined to the two enumerated adapters.

---

## Known limitations

1. **Not a sandbox** — carried over from 4B.1 and still the most important
   caveat. The child is an ordinary OS process with the launching user's
   privileges. **It can read and write files directly, outside the bridge
   entirely.** The bridge constrains what the orchestrator will do *on the
   agent's behalf*; it does not confine the agent. This is exactly why nothing
   it reports is believed and why Phase 3 attribution is mandatory — and a test
   demonstrates the honest version, with the child writing a file directly and
   denying it.
2. **Reads are limited to the approved write scope.** `read_file` is scope-bound
   (Phase 4A behaviour, unchanged), so an agent cannot read a file it may not
   write. That is conservative and will be restrictive in practice — a real
   coding task usually needs to read more than it changes. Widening it is a
   deliberate future decision, not something to slip in.
3. **No chunked reads.** A file over 256 KB comes back truncated. Chunking would
   need an explicit design rather than a raised global limit.
4. **No rename or move.** A rename is `write_file` + `delete_file`, which costs
   two mutations and appears as two journal entries.
5. **No directory creation or removal** as separate operations. Parent
   directories are created implicitly by `write_file`, inside the boundary.
6. **Grants are tamper-evident, not signed** — carried over from Phase 4A.
7. **`filter.<name>.clean`** still unblocked — carried over from Phase 3.
8. **The sensitive-file policy is name-based** — carried over from Phase 3. It
   will not stop an agent reading a credential pasted into an ordinary source
   file that is inside its scope.
9. **Windows signal limitations** — carried over from 4B.1.
10. **A tool-using child must read stdin line by line.** Reading it to EOF
    deadlocks, because stdin is the response channel and does not close until
    the run ends. This is a protocol contract rather than a defect, but it is a
    sharp edge: a naive child that slurps its input will hang until the run's
    timeout rather than failing fast. Moving responses to fd 3 would remove the
    edge and is blocked by the Windows pipe behaviour described above.

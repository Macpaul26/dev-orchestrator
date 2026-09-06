# Phase 4A — Controlled Hands Foundation

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

Phase 3 gave the orchestrator trusted eyes. Phase 4A gives it **bounded,
human-granted hands**, and nothing else.

> Phase 3: **Observe independently first. Act later.**
> Phase 4A: **Act only through explicit, bounded, human-approved capabilities,
> then independently verify what actually happened.**

There is still **no coding agent**, no model API, no shell, no git mutation and
no network. This phase builds the substrate that can later host a coding agent
safely, and proves the boundary holds *before* anything unpredictable is
connected to it.

---

## 1. What capability exists

| Capability | State | Requires |
| --- | --- | --- |
| `repo.metadata.read` | Implemented | nothing — read-only |
| `repo.read` | Implemented | nothing — read-only |
| `repo.file.write` | Implemented | a human-approved grant, bound to one run and scope |
| `repo.file.delete` | Implemented | a human-approved grant, bound to one run and scope |
| `git.mutate` | **Declared, not implemented** | — |
| `process.execute` | **Declared, not implemented** | — |
| `network.access` | **Declared, not implemented** | — |

`dev-agent tools` prints this matrix.

Three states are kept apart deliberately (`src/domain/capability.ts`):

- **DECLARED** — the name exists in the enum
- **IMPLEMENTED** — there is code that can perform it
- **GRANTED** — a human authorised it, for one run, within a scope

A declared capability gives nothing. `git.mutate` cannot be put in a grant
(`issueGrant` throws) and cannot be exercised even if one is hand-edited to
contain it (`assertCapability` re-checks at use time).

## 2. What capability does not exist

No Claude Code, no Anthropic or OpenAI API, no MCP, no arbitrary shell, no
arbitrary process execution, no git commit/push/branch/reset, no GitHub writes,
no deployment, no credential management, no autonomous planning, no autonomous
approval, and nothing project-specific in `src/`.

```
$ dev-agent tools
write capabilities registered: false
  (a registry gains write tools only from a human-approved implementation
   grant bound to one run and one scope; this listing has none)
shell execution available: false
process execution available: false
git mutation available: false
network access available: false
coding agent connected: false
check execution enabled: false
```

---

## 3. How human authorisation works

```
PLAN → HUMAN APPROVAL → IMPLEMENTATION GRANT → CONTROLLED IMPLEMENTATION
     → INDEPENDENT VERIFICATION → REVIEW → HUMAN APPROVAL
```

A grant is minted in exactly one place: `approve_plan`, immediately after a
validated `HumanDecision` carrying an `approvalId` and a `decidedBy`. There is
**no global "implementation enabled" switch** anywhere in the system — no flag,
no environment variable, no default.

```
grantId       deterministic: grn_<runId>_<planRevision>
projectId     \
runId          |  binding - the grant is meaningless outside this context
approvalId    /
approvedBy    a person; only applyHumanDecision produces one
allowedScope  inherited from the plan the human approved, including their edits
capabilities  bounded repository read/write/delete only
notBefore     \
expiresAt      |  bounded validity - 15 min default, 60 min hard maximum
maxWrites      |  mutation budget    - hard maximum 1,000   (default 200)
maxWriteBytes /   per-file ceiling    - hard maximum 4 MB    (default 1 MB)
fingerprint   SHA-256 over all of the above
```

**Validation happens at capability use time, not once at the start.** Every
`writeFile` re-checks expiry, binding and integrity, so a long-running agent
cannot be validated while fresh and then write indefinitely.

### A grant is SINGLE-USE

> **An implementation grant is single-use. Once an implementation attempt has
> claimed the grant, it cannot be reused — including after failure, cancellation
> or process interruption.**

```
HUMAN APPROVAL → ACTIVE → [one implementation attempt claims it] → CONSUMED
                                                                      ↓
                                                            permanently unusable
```

`consumed` is terminal and irreversible, and it is reached by **claiming** the
grant, not by finishing successfully. A run that failed, was cancelled, or whose
process died has still spent its one authorisation. A second attempt is refused
with the structured reason `consumed`; no replacement grant is minted silently,
so continuing requires a new human approval.

#### The commit point

Consumption is committed by `ProjectStore.claimGrant()`, which creates
`grants/<grantId>.claim` with `open(..., "wx")` — an **exclusive create**, a
single atomic syscall on both POSIX and Windows. Exactly one caller can succeed;
every other gets `EEXIST` and is refused.

The status field in the grant JSON is updated immediately afterwards, but the
**marker is authoritative**, not the JSON. Those are two operations and a process
can die between them; if the JSON decided, that crash would leave a claimed grant
reading `active`. `getGrant()` therefore reports `consumed` whenever the marker
exists, so the durable one-shot property rests on one indivisible fact.

#### Where it happens, and why there

```
validate grant → acquire project lock → CLAIM GRANT → run agent → …
```

**Before the agent, deliberately.** Claiming afterwards would leave a window in
which a crashed run's grant still read `active`, letting a second process pick it
up and start writing over whatever the first had already done — with no baseline
describing the state it was starting from.

The cost is real and is accepted: **a crashed attempt burns a human approval**
and a new one is needed. That is the right direction to fail — a human
re-approves, rather than a machine silently re-entering a repository in an
unknown state.

**After the lock**, so ordinary lock contention does *not* burn a grant. The
claim is still atomic on its own and does not depend on the lock: a read-only
grant takes no lock and is single-use all the same. The grant's one-shot
lifecycle and the project lock are independent controls.

#### Concurrency

Two callers presenting the same active grant cannot both proceed. The exclusive
create decides, and there is exactly one winner; the loser is refused, not
queued. Tested directly (twelve simultaneous claims → one success) and
end-to-end (two concurrent runs → exactly one implementation, exactly one file
written).

#### What is not claimed

The project store is a directory of files, not a transactional database. What is
guaranteed is that the **claim** is atomic, and that a claimed grant never
becomes usable again. The subsequent status write and the activity record are
ordinary file writes; if one fails the grant remains consumed, which is the
conservative direction. No transactional guarantee is claimed across the store as
a whole.

### What "tamper-evident" honestly means

`fingerprint` is a hash, **not a signature** — there is no key, and the codebase
deliberately holds no secret. The real defence is that **the stored grant is
authoritative**: the runner re-reads the issued record and compares. An agent
that widens its own copy fails, *and so does one that recomputes the fingerprint
after widening* — internal consistency is not enough.

**Limitation:** a process that can already write to the orchestrator's project
store could rewrite both the grant and its fingerprint. Signing would need key
management this phase does not have.

### The mutation budget has a real ceiling

`maxWrites` and `maxWriteBytes` are bounded by `MAX_GRANT_WRITES` (1,000) and
`MAX_GRANT_WRITE_BYTES` (4 MB). A request above either is **clamped**, matching
how `resolveLimits` behaves elsewhere — clamping can only ever produce a narrower
grant, so a mistaken caller gets less authority than it asked for, never more.

The ceiling is enforced in the **Zod schema**, not only in `issueGrant`. Without
that, a hand-edited grant file could carry any number and the "ceiling" would be
decoration; with it, such a file fails to parse and cannot be smuggled in through
the store. `.int()` additionally rejects `Infinity`, `-Infinity`, `NaN` and
fractional values, so no floating-point value slips past the comparison. Defaults
are unchanged.

## 4. The agent cannot expand its permissions

An agent receives an `ImplementationSession` and a request. That is its entire
world: no filesystem handle, no project path, no environment, no shell, no git,
no network, and not the grant object.

The session's internals use **native `#` private fields, not TypeScript
`private`**. This distinction is load-bearing, and the first version of the class
got it wrong — the escalation test caught it. TypeScript's `private` disappears at
compile time, so `(session as any).writer` reached a `SafeWriteFs` that writes
with **no grant, capability or scope check**: a complete scope bypass. `#` fields
are enforced by the language and cannot be reached by any cast, `Object.keys`, or
property access. The grant is additionally deep-frozen.

Every escalation route is tested: mutate capabilities, mutate scope, mutate the
counters, reach the grant, reach the writer, reach the journal, reach a shell, a
process, git, the network, or a filesystem handle. All fail closed.

## 5. How scope is enforced

Grant checks reuse `classifyScope` — the *same* function that computes scope
drift after the fact. Two implementations would eventually disagree, and the
disagreement would be the vulnerability.

An **empty `allowedScope` authorises nothing**, so a plan that declared no scope
produces a grant that can write nothing.

### A defect found and fixed during this phase

Scope matching is prefix-based, and a traversal string could satisfy a prefix and
then climb straight back out:

```
"src/../../etc/passwd".startsWith("src/")   ->  true
```

That path was reported **in scope**. The filesystem boundary rejected it
independently, so it was not exploitable end to end — but a scope layer that says
"authorised" about a traversal string is wrong on its own terms. `containsTraversal`
now makes any path with a `..` segment match no pattern at all. Phase 3's drift
detection is unaffected in practice (git never reports such paths) and its tests
still pass.

## 6. How writes are bounded

`SafeWriteFs` reuses `FsBoundary` — there is **no second path-security
implementation**. Traversal, absolute paths, Windows drive and UNC escapes,
prefix collisions, symlinks, junctions, intermediate links and dangling links are
all rejected, lexically *and* after physical resolution. All of it is re-tested
against the write path, because a containment bug there overwrites a file rather
than leaking one.

The whole mutable surface is `writeFile` and `deleteFile`. No move, chmod, chown,
symlink, rmdir, or anything taking a command.

**Sensitive files cannot be written or deleted at all** in this phase. The
substrate has no business creating or replacing a `.env` or a private key, and
refusing outright is the only version of that rule with no bypass. Committed
templates (`.env.example`) remain writable.

### Atomic writes

1. resolve and prove containment — immediately before mutating
2. write a temporary file **in the target's own directory**, `wx` (exclusive)
3. `fsync`, close
4. `rename` over the target

The temporary stays inside the project boundary: putting it in the system temp
directory would place repository content outside every guarantee this class makes
and could outlive a crash. Temporaries are removed on every path.

Where Windows refuses to rename over a file another process holds open, the
replacement falls back to delete-then-rename and reports `atomic: false` rather
than letting the caller assume otherwise.

### TOCTOU — stated honestly

**This is not TOCTOU-proof.** What it does:

- validates immediately before mutating, not once per session
- operates on the **physically resolved** path, so a symlink swapped in at the
  original path afterwards is not followed
- creates temporaries with `wx`, so it can never clobber or follow something that
  appeared underneath it
- fails explicitly rather than degrading to an unsafe write

**What remains:** a directory component can in principle be replaced between
`resolve()` and `rename()`. Closing that needs `openat`-style directory-relative
syscalls, which Node does not expose; Windows additionally has no `O_NOFOLLOW`.
Not solved here, and not claimed to be.

## 7. How activity is recorded

Phase 3 gave two kinds of knowledge — **state** and **attribution** — both
reconstructions after the fact. Neither can say what was *attempted*: a denied
write leaves no trace in the repository, and a successful one looks identical to
a human's edit.

The **activity journal** is the third kind: what the orchestrator did and
refused, recorded as it happened, in `projects/<id>/activity/<run>.jsonl`.

Grant consumption is part of it: `grant_consumed` records the claim (grant id,
timestamp, claiming pid and host — metadata only), and `grant_reuse_denied`
records every refused reuse attempt with its structured reason. Both are written
by the orchestrator at the moment of the decision; an agent has no way to forge,
suppress, or delete either.

It is written **by the orchestrator, from inside the capability check** — never
by the agent. An agent cannot append to it, suppress an entry, or describe its own
behaviour in it. It is deliberately a separate file from the workflow history: a
run makes a handful of workflow events and can make hundreds of activity records,
and conflating them would bury the approval trail under write traffic.

### No content, ever

Records carry **metadata only**: path, capability, byte count, outcome category,
timestamps, run and correlation ids. No file contents, no diffs, no environment,
no command output, no error buffers.

- `contentHash` identifies a payload without disclosing it
- for a **sensitive** path even the hash is omitted — a digest of a low-entropy
  secret can be attacked by guessing
- an agent's exception **message** is never recorded, only its type; a message
  could carry a path, a buffer or an environment value

Tested by writing a known secret and asserting it appears nowhere in the journal.

## 8. How cancellation works

| Status | Meaning |
| --- | --- |
| `not_started` | record exists, nothing attempted |
| `running` | owner pid recorded, work in progress |
| `cancel_requested` | stop asked for |
| `cancelled` | stopped — **may have written something first** |
| `failed` | the agent threw |
| `interrupted` | the owning process vanished; state unknown |
| `completed` | ran to the end |

**No rollback is implemented and none is claimed.** A cancelled run keeps whatever
it already wrote, and `partialChangesPossible` stays true for every non-clean
terminal state. `mustVerify` is **always** true — even a clean completion is
checked against the real repository, because the runner's own account is not
evidence about files.

## 9. How process death is handled

The `running` record — with this process's pid and hostname — is persisted
**before the agent is invoked**. A process killed mid-write therefore leaves a
`running` record with a dead owner, and `reconcile()` turns it into
`interrupted`, never `completed`. There is no code path that marks a run
completed without reaching the end of `run()`.

Liveness is only consulted for records owned by **this host**; a record from
another machine is left alone rather than guessed at.

### Concurrency: the lock fails closed

One project, one mutating run. The lock protects the integrity of the *evidence*
as much as the files — Phase 3 decides what a run changed by comparing two
snapshots, and a concurrent writer poisons that comparison.

Acquisition is atomic (`open(..., "wx")`), so two racing processes cannot both
succeed.

**A stale lock is not reclaimed automatically, even when the recorded pid is
clearly gone.** Automatic reclaim needs "is that pid alive?" to be trustworthy,
and it is not — pids are reused, and on a shared filesystem the pid belongs to
another machine. Guessing wrong means two writers in one working tree, the exact
thing the lock exists to prevent.

So a stale lock **blocks**, reports liveness as a hint, and names the command
that clears it:

```
dev-agent implementation:unlock --project <id>
```

The cost is that a crash needs one human command. The benefit is that no crash
can produce concurrent mutation. `implementation:unlock` refuses while the holder
still appears to be running, and tells the human to inspect the repository
afterwards, because an interrupted run may have written partial changes.

## 10. How independent verification works

```
baseline (inspect)
   ↓
controlled implementation      ← activity journal: what we did and refused
   ↓
repository inspection          ← Phase 3, unchanged and authoritative
   ↓
attribution → scope drift → review → HUMAN APPROVAL
```

The activity journal is **additional evidence, not a replacement** for
observation. Phase 3 attribution remains authoritative for pre-existing,
introduced, modified-during-run, removed and renamed changes, and scope drift is
computed from the repository, not from what the substrate believes it wrote.

Tested with an agent that **lies in both directions** — claiming a file it never
wrote and concealing one it did. git wins.

`REVIEW → APPROVED` remains human-only and untouched: `machineTransition` still
refuses, and the second approval gate still interrupts.

## 11. Why Claude Code is intentionally not integrated

Connecting a real coding agent now would mean the first thing ever to exercise
this boundary is something unpredictable, non-deterministic, and impossible to
make attempt a specific attack on demand. Proving containment needs the opposite:
a fake agent that does exactly the wrong thing when asked — traversal,
escalation, deletion outside scope, cancellation halfway, lying about its work.

That fake lives in `tests/fakeAgent.ts`, and a test asserts no production module
imports it.

The seam is `ImplementationAgent` — `name` plus `implement(session, request,
cancellation)`. A Claude Code adapter implements that interface and receives
exactly what the fake receives: a bounded session and nothing else.

---

## Security limitations that remain

1. **TOCTOU is mitigated, not eliminated** — see §6.
2. **Grants are tamper-evident, not signed** — a process that can write the
   project store can forge one. See §3.
3. **The stale-lock policy needs a human** — deliberate, see §9.
4. **`filter.<name>.clean` is still not blocked** — carried over from Phase 3;
   git runs it during `status` and offers no switch to disable it.
5. **The sensitive-file policy is name-based** — carried over from Phase 3. It
   will not detect a credential pasted into an ordinary source file.
6. **A rename made by the substrate is two operations** — `write` + `delete` —
   because there is no move capability. Phase 3 rename detection still identifies
   it from content, but the activity journal records two entries, not one.
7. **Cancellation is cooperative.** An agent that ignores the token runs to the
   end of its current step. It cannot exceed its grant while doing so, but it is
   not pre-empted.
8. **No rollback.** Stated throughout rather than implied away.
9. **A crashed attempt burns its grant.** Deliberate (see §3): the grant is
   claimed before the agent runs, so an interrupted implementation cannot be
   retried without a fresh human approval. The alternative — a reusable grant
   after a crash — would let a second process re-enter a repository whose state
   nobody has described.
10. **The store is files, not a transaction log.** The claim is atomic; the
    status write and journal append that follow it are not part of that atom. A
    failure there leaves the grant consumed, never revived.

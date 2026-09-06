# Phase 3 — Secure Repository Intelligence + Independent Verification

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

Phase 1+2 proved a workflow could suspend at a human approval and survive
process death. Phase 3 gives that workflow **eyes**: it can now observe a real
repository for itself, instead of taking anyone's word for what is in it.

> **Observe independently first. Act later.**

This phase adds **no** write capability. `npm run tools` still reports
`write capabilities registered: false`, and tests assert it.

---

## What is real now

| Area | Before | After |
| --- | --- | --- |
| Path containment | Lexical only | Lexical **and** physical (symlinks/junctions resolved) |
| `inspect` node | Read project.json | Real git + filesystem inspection |
| `verify` node | Did nothing | Re-inspects, derives `observed*`, compares to a baseline |
| `review` node | Fixed stub verdict | Deterministic findings from real evidence |
| `observed*` fields | Always empty | Populated from git, never from a claim |
| `verifiedIndependently` | Always `false` | `true` only when an observation actually succeeded |
| `scopeDrift` | Always `[]` | Computed by segment-aware path matching |
| Tool registry | 1 introspection tool | + 5 read-only repository tools |
| Check execution | Not modelled | Modelled, interfaced, **explicitly disabled** |

## What still deliberately does not exist

No Claude Code, no Anthropic or OpenAI API calls, no repository writes, no
commits, no pushes, no pull requests, no merges, no deployment, no shell
execution, no check execution, no dashboard, no multi-agent anything, and
nothing project-specific in `src/`.

---

## Architecture

```
        Workflow (graph nodes)
              │  depends on an INTERFACE, never on git
              ▼
        RepositoryInspector            src/domain/inspector.ts
              │
              ▼
   LocalGitRepositoryInspector         src/adapters/repository/localGit.ts
        │              │
        │              └──▶ runGit()   src/adapters/repository/gitExec.ts
        │                             (allowlist, no shell, built env)
        ▼
      SafeFs                           src/security/safeFs.ts
        │   (read-only; no write method exists)
        ▼
     FsBoundary                        src/security/fsBoundary.ts
        │   lexical + physical containment
        ├──▶ sensitive.ts   what may never be read
        └──▶ limits.ts      how much may be read
```

Nodes receive an inspector through `NodeContext`. They cannot construct one, and
therefore cannot choose what they inspect or widen their own boundary — the
project record decides both.

---

## 1. The filesystem security boundary

`src/security/fsBoundary.ts`

Containment is decided **twice**, because the two checks catch different attacks.

### Lexical containment

`path.resolve` + `path.relative`. Catches `../` traversal, absolute-path
escapes, and — on Windows — a different drive letter or UNC share. This is what
Phase 1+2's `resolveWithin` did, and it is necessary but **not sufficient**.

### Physical containment

Resolve every symlink in the chain, then check containment again:

```
project/allowed/link  ->  /somewhere/else
"allowed/link/file.ts"    lexically inside — physically outside
```

`resolveThroughLinks()` handles the case `fs.realpathSync` cannot: a path that
does not exist yet. It resolves the deepest existing ancestor, re-attaches the
missing tail, and follows a **dangling** link at the leaf by hand. Without this,
"does this file exist?" would be an unguarded question.

A symlink cycle is bounded by `MAX_SYMLINK_HOPS`.

### Windows junctions

On Windows a real symlink needs `SeCreateSymbolicLinkPrivilege`, but a
**directory junction does not** — any user can create one. A junction escapes
the boundary exactly as a symlink does, and `fs.realpathSync` resolves both. The
escape tests therefore run on an ordinary Windows box using whichever primitive
is available (`tests/helpers.ts` → `linkDir`), and they genuinely execute here:
the junction path is tested, not skipped.

### Legitimate links still work

A link that stays inside the root resolves normally and is reported at its
**real** location, so the same file cannot be counted twice under two names.

---

## 2. Git is read-only

`src/adapters/repository/gitExec.ts` is the **only** module in the orchestrator
that starts a process. Five properties make that acceptable:

1. **No shell.** `spawnSync` with `shell: false` and an argv array. No string is
   ever parsed by `cmd.exe` or `/bin/sh`, so `;`, `&&`, backticks and globs have
   no meaning. A malicious filename is an argument, not a command.

   **This is not sufficient on its own.** `shell: false` governs how *we* launch
   git; it says nothing about what git then launches. See property 5.
2. **No arbitrary command.** The executable is hard-coded to `git`. There is no
   `exec(command)` export. The subcommand must be on the allowlist:
   `rev-parse`, `status`, `diff`, `log`, `ls-files`, `cat-file`, `rev-list`,
   `symbolic-ref`, `show-ref`, `version`.
3. **No mutation.** Every mutating subcommand is absent from the allowlist, and
   `DENIED_SUBCOMMANDS` re-states 40 of them so a rejection explains itself.
   `--no-optional-locks` additionally stops `git status` refreshing the on-disk
   index, so inspection leaves *no* trace — proven byte-for-byte in
   `tests/repository.test.ts`.
4. **No inherited secrets.** The child environment is **built**, not inherited.
   An `ANTHROPIC_API_KEY` or `GITHUB_TOKEN` in the parent is invisible to git,
   and so are `GIT_DIR` / `GIT_WORK_TREE`, which could otherwise redirect the
   command outside the boundary. `GIT_EXTERNAL_DIFF` cannot reach the child
   either, for the same reason: the environment is a fixed passthrough list.
5. **Git itself may not be turned into a launcher.** See below — this is the
   property the first four do *not* provide.

`branch` and `config` are on the **denied** list even though they can read:
`branch -D` deletes and `config --global` writes. Branch information comes from
`rev-parse --abbrev-ref` and `symbolic-ref` instead.

Arguments that could redirect git (`--git-dir=`, `--work-tree=`, `--exec-path=`,
`-C`, `-c`, `--upload-pack=`, `--receive-pack=`) are rejected wherever they
appear in caller-supplied arguments.

### 2a. Repository configuration must not become code execution

This is the part `shell: false` does **not** buy, and it is worth stating
precisely rather than waving at.

Git executes programs named in its own configuration. A repository the
orchestrator merely *inspects* owns its `.git/config` and `.gitattributes`, so
running `git diff` over a hostile checkout is remote code execution:

```
.git/config      [diff "x"] command  = <anything>     run by git diff
                 [diff "y"] textconv = <anything>     run by git diff
                 [diff]     external = <anything>     run by git diff
                 [core]     fsmonitor = <anything>    run by git status
.gitattributes   *.ts diff=x
```

**`GIT_CONFIG_NOSYSTEM=1` does not prevent any of this.** It suppresses the
*system* configuration; every setting above is repository-local. This was
confirmed by experiment against real git, not assumed — the attack fires with
`GIT_CONFIG_NOSYSTEM=1` set.

Neither the subcommand allowlist nor the absence of inherited credentials helps:
`diff` is a legitimately allowlisted read-only subcommand, and the hostile
program is named by the repository, not by the environment.

The protection is therefore attached to the invocation itself:

| Mechanism | Where | Stops |
| --- | --- | --- |
| `--no-ext-diff` | forced onto `diff` and `log` | `diff.external` and any `diff.<driver>.command` selected via `.gitattributes` |
| `--no-textconv` | forced onto `diff` and `log` | `diff.<driver>.textconv` |
| `-c diff.external=` | every invocation | belt-and-braces with `--no-ext-diff` |
| `-c core.fsmonitor=` | every invocation | the program git runs during `status`, which the diff flags do not cover |

The forced flags are inserted **between the subcommand and the caller's
arguments**, so no caller can position an argument ahead of them. `log` gets them
as well as `diff`, because `git log` accepts the whole diff option set and a
later caller adding `-p` must not silently reopen the hole.

`-c` remains **forbidden in caller-supplied arguments**, and that is exactly what
keeps the `-c` position trustworthy: the overrides above are hard-coded in
trusted adapter code and are the only `-c` git ever receives.

`tests/gitHardening.test.ts` proves each of these against a real repository whose
local configuration tries to run a marker program. **Every one of those tests
carries a positive control**: it first asserts the attack *does* fire against
plain git, then deletes the marker, then asserts it does not fire through the
inspector — so a broken fixture fails loudly instead of passing vacuously.

#### Known residual: content filter drivers

`filter.<name>.clean` is run by `git status` when it must read a file's content
to decide whether it changed. Git offers no command-line switch to disable it,
and it cannot be neutralised with a fixed `-c` because the driver names are
chosen by the repository. It is therefore **not** blocked today.

The exposure is narrower than the diff drivers — git consults the index's cached
stat information first and only applies the filter when size or mtime already
differ — but it is real, and it is recorded here rather than left implied by a
broader claim than the code supports. Inspecting a genuinely untrusted
repository should happen in a sandbox regardless.

---

## 3. The project boundary decision

> **`project.workingDir` IS the security boundary.**

If the git repository extends *above* `workingDir` — a monorepo package, say —
the scope is **not** silently widened. Instead:

- every git command runs with `cwd = workingDir` and the pathspec `.`, so only
  changes at or below the boundary are reported;
- `repositoryRootWithinBoundary: false` records that we saw *part* of a
  repository, and a note says so at the approval gate.

The only way to widen it is to **declare** it: `project.repoRoot` in
`project.json` (CLI: `project:create --repo-root`). It must be absolute and must
genuinely contain `workingDir`, or inspection fails with `path_escape`. That is
a human editing a file — not something the workflow, and certainly not a model,
can do.

---

## 4. Sensitive-file policy

`src/security/sensitive.ts`

Inspection results are written into workflow state, SQLite checkpoints and the
JSONL audit trail — all unencrypted, all long-lived. One unguarded
`readFile(".env")` would put a live credential in all three permanently.

So the inspector draws a hard line:

| | Allowed |
| --- | --- |
| **Metadata** — path, size, kind, "changed" | Always |
| **Contents** — bytes, diff hunks | Blocked when sensitive |

Covered by the baseline: `.env` and `.env.*`; private keys by extension
(`.pem .key .p12 .pfx .jks .keystore .asc .ppk .gpg`) and by name
(`id_rsa`, `*private-key*`, `*service-account*`); credential files
(`.netrc`, `.git-credentials`, `secrets.json`, `credentials`, `.htpasswd`,
`*.tfvars`); registry auth (`.npmrc`, `.pypirc`); and anything inside `.ssh/`,
`.aws/`, `.gnupg/`, `.docker/`, `.kube/`.

`*.example`, `*.sample`, `*.template`, `*.dist` and `*.defaults` are explicitly
**exempt** — `.env.example` exists to be read.

The diff is built from an **explicit pathspec list** of non-sensitive changed
files, not from a bare `git diff`. Excluded paths are still reported by name, so
a `.env` change is visible without the change itself entering the audit trail.

**This is a conservative baseline, not a secret detector.** It matches on
location and name, never on content. It will not find an API key pasted into an
ordinary `.ts` file, and it does not claim to.

---

## 5. Inspection limits

`src/security/limits.ts`

| Limit | Default | Ceiling |
| --- | --- | --- |
| `maxFileBytes` | 256 KB | 2 MB |
| `maxDiffBytes` | 256 KB | 2 MB |
| `maxDirectoryEntries` | 500 | 5,000 |
| `maxListedFiles` | 2,000 | 20,000 |
| `maxDepth` | 8 | 32 |
| `maxCommits` | 50 | 200 |
| `maxFingerprintBytes` | 16 MB | 128 MB |
| `maxFingerprintedFiles` | 2,000 | 20,000 |
| `gitTimeoutMs` | 15,000 | 60,000 |
| `gitMaxBufferBytes` | 4 MB | 8 MB |

Two rules make these a security control rather than a performance tweak:

1. Limits come from **trusted configuration only** — a constructor argument.
   They are never part of a tool's input schema, so no model-visible code path
   accepts one. A test asserts no registered tool's schema mentions a limit.
2. `resolveLimits()` **clamps** every field to its ceiling. Even a mistaken
   trusted config cannot lift a limit past `CEILINGS`. Editing that file is the
   only way past, and that is a reviewable code change.

Exceeding a limit produces a **structured result**, never a silent truncation: an
oversized file returns `truncated: true` with its real size, and a `.git`-sized
untracked listing degrades to git's collapsed form with a recorded note.

---

## 6. Scope semantics

`src/domain/scope.ts`

| Pattern | Meaning |
| --- | --- |
| `src/auth/service.ts` | Exact file |
| `src/auth/` or `src/auth` | Directory, including everything nested |
| `src/*.ts` | `*` matches within **one** segment, never across `/` |
| `src/**` | `**` matches any number of segments |
| `?` | Exactly one character within a segment |

Anything else is a literal path. No brace expansion, no character classes, no
negation — a bigger glob engine is a bigger attack surface.

**Why not substring matching:** `"src-generated/x.ts".startsWith("src")` is
`true`, which would silently authorise a directory nobody approved. Matching is
segment-aware: a directory pattern matches only when the next character is `/`.
The brief's example holds — `src/` does not authorise `tests/Button.test.ts`.

**Windows:** both sides are normalised to forward slashes. Matching stays
**case-sensitive**, because git reports paths case-sensitively even on Windows
and lowercasing would let `SRC/` authorise `src/`.

**The empty scope fails closed.** An empty `allowedScope` authorises *nothing*,
so every changed file is drift. The alternative — empty means "anything" — would
turn a plan that forgot to declare its scope into an unrestricted one.

---

## 7. Evidence provenance

`src/verification/verifier.ts`

> **The coding agent's report is never proof of what happened.**

| Field | Source |
| --- | --- |
| `claimedSummary`, `claimedFiles` | The agent. **Untrusted.** Passed through untouched. |
| `observedFiles` | `git status --porcelain -z` |
| `observedDiff` | `git diff HEAD -- <non-sensitive paths>` |
| `observedCommits` | `git rev-list <baseline>..HEAD` |

They never meet. There is **no** code path that writes a claimed value into an
observed field, and **no** fallback that fills an observed field from a claim
when inspection fails. When inspection fails, observed stays empty and the
report is unverified — not optimistic.

### The two-snapshot model

```
inspect  ──▶ baseline snapshot ──┐
         (fingerprints)          ├──▶ attribution: compare STATE
verify   ──▶ after snapshot   ───┘
         (fingerprints)
```

Without a baseline, a repository that was *already* dirty would read as work
this run performed, and drift would be reported against changes nobody made.

**Real repositories are dirty.** A developer has uncommitted work in progress
when the orchestrator starts. Refusing to inspect a dirty tree — or dropping
`verifiedIndependently` to `false` whenever one is found — would make the system
useless on exactly the repositories it exists to serve. `verifiedIndependently`
does **not** depend on the tree being clean.

---

## 7a. Attribution — comparing state, not filenames

`src/domain/attribution.ts`

### The defect this replaced

The first implementation differenced two lists of **paths**: dirty at baseline
versus dirty afterwards. That has a hole big enough to hide an entire run's work
in:

```
baseline:  src/auth.ts is already modified   -> in the baseline set
run:       src/auth.ts is modified FURTHER   -> still in the after set
verdict:   set difference is empty -> "pre-existing" -> THE RUN'S WORK VANISHED
```

A file being dirty before and dirty after says nothing about whether it is dirty
*in the same way*. And the same flaw made `observedDiff` — the whole working
tree against HEAD — present a colleague's uncommitted work as the run's output.

### What is captured at each snapshot

Every path that is dirty at snapshot time gets a `FileFingerprint`:

| Field | Purpose |
| --- | --- |
| `contentHash` | SHA-256 of the bytes. The change signal. |
| `blobSha` | Git blob SHA-1 of the current content — identical to `git hash-object` |
| `headBlobSha` | Git blob id of the HEAD version, for a path now gone from disk |
| `size`, `mtimeMs` | Fallback signal when no hash may be taken |
| `statusCode`, `staged`, `unstaged`, `untracked` | *Where* the change lives |
| `present`, `kind` | Existence and type |

Both digests are produced in **one streamed pass** over 64 KB chunks, so memory
is constant regardless of file size and the bytes are discarded immediately —
only the digests survive.

### The classification

| Class | Meaning | Attributable |
| --- | --- | --- |
| `pre_existing` | Dirty at baseline, byte-identical since | **No** |
| `introduced` | Did not exist at baseline | Yes |
| `modified_during_run` | Content or index state changed — **including a file that was already dirty and changed further** | Yes |
| `removed` | Existed at baseline, gone now | Yes |
| `renamed` | Same content, different path | Yes |
| `restored` | Was dirty, now matches HEAD again — the run undid someone's work | Yes |

Only `pre_existing` is excluded. Everything else feeds scope-drift detection.

### Cases that need more than a status listing

A file the run **committed**, **deleted**, or **reverted** leaves
`git status` entirely, and all three then look identical to "nothing happened".
So attribution draws on three sources, not one:

1. **Fingerprint comparison** over the union of both snapshots' paths.
2. **Re-fingerprinting** paths the baseline knew about that are no longer dirty
   — this is what makes a deletion or a revert visible at all.
3. **`git diff --name-only <baseline>..HEAD`** — paths the run committed.

A path with no baseline fingerprint was, by construction, **clean** at baseline
— identical to HEAD — so anything dirty about it now happened during the run.
Those verdicts are recorded with `basis: "git_status"`: git decided them, they
are exact, and they carry **no** metadata-only caveat even for a sensitive file
whose bytes were never hashed.

### Staged ↔ unstaged transitions

Staging a pre-existing change leaves the bytes identical but moves the change
from the worktree to the index. That is something the run did, so it is
`modified_during_run` with `indexStateOnly: true`, and the evidence names the
transition (`" M" -> "M "`).

### Rename detection without reading content

A rename usually surfaces as a delete plus an untracked add. Matching them needs
to know what the deleted file contained — but it is gone from disk, and reading
it back out of git would mean pulling content into the process.

Instead: `git rev-parse HEAD:<path>` returns the **blob id**, which is an
identifier, not content. Matching it against the newly-appeared file's locally
computed blob SHA-1 identifies the rename with nothing read back out of the
repository. Git's own `R` status records (a staged `git mv`) are honoured too.

### Sensitive files keep their contents

**Attribution is never bought by hashing a credential.** A sensitive file is
never hashed — not even to a digest. A SHA-256 of a low-entropy secret, stored
permanently in an audit log, is a real disclosure risk, because it can be
attacked by guessing.

So sensitive files are attributed from `size`, `mtimeMs` and the git status code
alone. Where the verdict genuinely rests on size or timestamp, it carries
`basis: "metadata_only"`; where git's own status code settled it, it carries
`basis: "git_status"` and is exact.
`metadataOnlyPaths` lists them, the review gate raises an `info` finding for
each, and the trade-off is stated rather than hidden:

- it can **over-report** — `touch` looks like a change
- it can **under-report** — a same-size edit within one mtime tick

Over-reporting is the safer failure, and this biases toward it.

### `observedDiff` cannot overstate the run

`ImplementationReport.observedDiff` is regenerated for the **attributable paths
only**, diffed from the baseline commit (`git diff <baseline> -- <paths>`), which
also picks up anything the run committed. `observedDiffBasis` states what it
covers and is never left implicit:

| Value | Meaning |
| --- | --- |
| `attributable` | This run's changes, and only those |
| `all_changes` | No baseline existed. **Overstates** what the run did |
| `none` | No diff was collected |

### `verifiedIndependently`

Set `true` in exactly one place, and only when a real inspection succeeded. It
asserts one narrow thing:

> the `observed*` fields were produced by our own inspection of the real
> repository

It does **not** assert that the implementation was correct, in scope, or
complete. Those are separate questions answered by the evidence itself.

### What `ReviewEvidence` answers

- Do claimed files match observed files? (both directions)
- What changed that nobody claimed?
- What changed outside the approved scope?
- Does a claimed commit actually exist? (`git cat-file -e <sha>^{commit}`)
- Was the tree already dirty before we started?
- Which sensitive files changed? (names only)
- How many checks were declared, and how many actually ran?

This is the deterministic layer. A future model-based reviewer can sit on top of
it; it must not be able to alter it.

---

## 8. Verification commands remain disabled

`src/verification/checks.ts`

`project.checks` is recorded as evidence and **never executed**.

Running a declared check means executing a command *string*. `npm test` has to
be split, and splitting it correctly for `npm run test -- --grep "a b"` means
either a shell — reintroducing exactly the arbitrary execution Phase 1+2
excluded — or a parser whose bugs become security bugs.

More to the point: nothing needs it yet. Checks verify an implementation, and
this phase has **no implementation capability**. Turning on process execution now
would widen the capability boundary to make a feature look complete.

`CheckResult` gained `executed: boolean` and `skippedReason`. Without them a
check that never ran is indistinguishable from one that ran and failed — both
read `passed: false`. Everything this phase produces carries `executed: false`.

The `CheckRunner` interface is the seam. An enabled implementation must carry
**all** of: an executable allowlist (not command strings), argv arrays with
`shell: false`, project-declared commands only, boundary-contained cwd, a
timeout, an output cap, a built environment inheriting no credentials, a static
risk classification, and tests proving each restriction.

---

## 9. Failure behaviour

Inspection returns `InspectionOutcome`, a discriminated union — a failure is a
**value the caller must handle**, not an exception it can forget to catch.

`working_dir_not_absolute`, `working_dir_missing`, `working_dir_not_a_directory`,
`working_dir_unreadable`, `not_a_git_repository`, `git_unavailable`,
`git_failed`, `permission_denied`, `path_escape`, `symlink_escape`,
`repository_root_outside_boundary`, `timed_out`.

When inspection fails the run **continues** to the plan gate — inspection is not
the point of the run — but:

- `inspectionFailure` is set in state;
- a `repository_inspection_failed` event is written to the history;
- the observations say `repository inspection FAILED (code): message`;
- the approval payload shows `NOT INSPECTED` to the human;
- `verifiedIndependently` stays `false`;
- the review verdict becomes `changes_requested`.

Nothing downstream can mistake an incomplete pass for a clean repository.

---

## 10. CLI

```bash
# Register a project. --repo-root is the ONLY way to widen the boundary.
node dist/cli/index.js project:create --id acme --name "Acme" --dir /path/to/repo
node dist/cli/index.js project:create --id pkg  --name "Pkg"  --dir /repo/packages/app --repo-root /repo

# One read-only inspection pass, printed.
node dist/cli/index.js inspect --project acme

# Capabilities, including the repository tools bound to a project.
node dist/cli/index.js tools --project acme
```

`tools` now prints, at the end:

```
write capabilities registered: false
shell execution available: false
check execution enabled: false
```

---

## Known limitations

- **Untracked file contents are never diffed.** A new file appears in
  `untrackedFiles` and in `observedFiles`, but its contents are not in
  `observedDiff`. Diffing untracked content means reading arbitrary new files
  into the audit trail; the safer default was chosen.
- **The sensitive-file policy is name-based.** It will not detect a credential
  pasted into an ordinary source file, and a diff of such a file would capture
  it. Expanding this is the obvious next hardening step.
- **`.git` and `node_modules` are skipped** by recursive filesystem listing.
  Git-tracked file counts come from `git ls-files`, which is unaffected.
- **One thread per run** and **no concurrent inspection** — unchanged from
  Phase 1+2.
- **Case-sensitive scope matching on a case-insensitive filesystem.** On Windows,
  `SRC/a.ts` and `src/a.ts` are the same file but different scope entries. Git
  reports one canonical case, so in practice this only bites a hand-written
  scope entry with the wrong case; it fails *closed* (reported as drift).
- **Rename detection has two blind spots.** It works when git reports the rename
  itself, or when the vanished file's blob id can be matched against the new
  file's. It does **not** fire when the file was renamed *and edited* in the same
  run (the content no longer matches), nor for a **sensitive** file, whose bytes
  are never hashed. Both degrade to `removed` + `introduced` — still fully
  attributable, just less informative. Scope matching considers the new path.
- **A change made and then perfectly reverted is invisible.** Only paths that are
  dirty at a snapshot get fingerprinted, so a file edited and restored to its
  exact baseline content within the run leaves no trace. The net effect on the
  repository is nil, but the activity is not recorded.
- **Metadata-only attribution for sensitive and oversized files** can over-report
  (a `touch` reads as a change) and can under-report (a same-size edit inside one
  mtime tick). Flagged per-path in `metadataOnlyPaths` and surfaced at the review
  gate rather than hidden.
- **`repositoryRootWithinBoundary: false` means a partial view.** Changes made
  above the boundary are invisible to inspection by design. If a coding agent
  ever gains write capability, its own containment must use the same
  `FsBoundary` — the boundary is reusable precisely for that.

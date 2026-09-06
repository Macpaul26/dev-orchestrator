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
that starts a process. Four properties make that acceptable:

1. **No shell.** `spawnSync` with `shell: false` and an argv array. No string is
   ever parsed by `cmd.exe` or `/bin/sh`, so `;`, `&&`, backticks and globs have
   no meaning. A malicious filename is an argument, not a command.
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
   command outside the boundary.

`branch` and `config` are on the **denied** list even though they can read:
`branch -D` deletes and `config --global` writes. Branch information comes from
`rev-parse --abbrev-ref` and `symbolic-ref` instead.

Arguments that could redirect git (`--git-dir=`, `--work-tree=`, `--exec-path=`,
`-C`, `-c`, `--upload-pack=`, `--receive-pack=`) are rejected wherever they
appear.

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
                                 ├──▶ attributable = after − baseline
verify   ──▶ after snapshot   ───┘
```

Without a baseline, a repository that was *already* dirty would read as work
this run performed, and drift would be reported against changes nobody made.
`preExistingChanges` are recorded and excluded from drift attribution;
`driftBasis` says which basis was used.

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
- **Rename detection is partial.** `git status` reports `R` with the original
  path, which is captured in `GitFileChange.renamedFrom`, but scope matching
  considers only the new path.
- **`repositoryRootWithinBoundary: false` means a partial view.** Changes made
  above the boundary are invisible to inspection by design. If a coding agent
  ever gains write capability, its own containment must use the same
  `FsBoundary` — the boundary is reusable precisely for that.

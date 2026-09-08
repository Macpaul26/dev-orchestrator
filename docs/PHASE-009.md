# Task 009 — Experience / Learning Memory

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

> **EXPERIENCE IS MEMORY, NOT AUTHORITY.**
> **PERSISTENCE IS NOT TRUST. HISTORY IS NOT TRUTH.**

Task 009 builds one thing: a trustworthy place for bounded, project-scoped
episodic experience to survive a restart. It does not decide what any of it
means.

---

## 1. Purpose and boundary

```
PROJECT → EpisodicExperience → SECURE PERSISTENCE ← Task 009 stops here
        → future evaluation → candidate lesson
        → future sanitisation → PortableLesson
```

Nothing currently writes or reads experience in the workflow. The store exists,
is tested, and is deliberately unwired — a test asserts no production module
imports it. Task 010 owns retrieval; a producer arrives with it.

---

## 2. Storage model

```
<root>/<project-id>/<createdAt-compact>-<experience-id>.json
```

Default root: `orchestratorHome()/experience` — its **own tree**, separate from
the project store and from the LangGraph checkpoint database. Workflow
checkpoint state and learning memory have different lifetimes, contents and
rules; keeping them together is how a checkpoint dump ends up being read back as
experience.

Each file holds a `StoredExperience`: the record, its id, and integrity
metadata.

### Why the timestamp is in the filename

So listing can be **ordered and paged without opening anything**. Sorting by
`createdAt` otherwise means parsing every record in the project and discarding
all but the first page — precisely the read-everything-then-slice pattern the
storage budget exists to prevent. A project with 100,000 records costs one
directory read plus at most `maxListResults` file opens. A test asserts exactly
five files are opened for a five-record page.

---

## 3. Project isolation

Enforced by the persistence layer, not by callers remembering to filter.

1. **The project id shape is the first gate.** `StorageProjectId` is kebab-case
   only, so traversal, absolute paths, drive letters, UNC prefixes and alternate
   separators are *unrepresentable* rather than filtered.
2. **`resolveWithin` is the second gate** — the resolved directory must still
   sit inside the root. The first rejects the input; the second rejects the
   outcome.
3. **Ownership is re-checked on read.** A record whose own `projectId`
   disagrees with the directory it sits in is refused as `project_mismatch`. A
   file copied into the wrong project cannot be read back as that project's
   history — tested by literally copying one.

There is **no** `getAllExperience()` and **no** `searchAcrossProjects()`. A test
asserts the runtime method surface is exactly `write`, `read`, `list`.

---

## 4. Identity

`experienceId(record)` is a SHA-256 over the record's fields **in a fixed
order**, truncated to 32 hex characters — not `JSON.stringify` of the object,
whose key order depends on how the object was built.

- **Deterministic**: the same logical experience yields the same id on any
  machine, so persisting it twice is an overwrite, not a near-duplicate.
- **Excludes storage metadata**: including `integrity.computedAt` would make
  identity depend on *when* it was written, and the same experience saved twice
  would become two records.
- **Filesystem-safe by construction**: lower-case hex has nothing in it to
  escape a path with.

No `Math.random()`, no array indexes, no dependence on filesystem ordering.

---

## 5. Integrity — and what it is *not*

A SHA-256 digest over the canonical record, stored beside it and **recomputed on
every read**.

| | Provided? |
| --- | --- |
| **Integrity** — the bytes match the digest | **yes** |
| **Authenticity** — someone with a key vouched for it | **no** |
| **Verification** — the claims were independently confirmed | **no** — that is `OutcomeSource` |
| **Trust** — it should influence a decision | **never** |

There is no key and no signature. Anyone who can rewrite the record can also
rewrite the digest: they sit in the same file, on the same disk, behind the same
permissions. What this genuinely catches is accidental truncation, a partial
write, a hand-edit, disk corruption, a botched migration.

`digestMatches: true` means **"unchanged since we wrote it"** — never "safe",
"verified" or "authorised".

A test performs the honest attack — rewrite the record *and* recompute the digest
— and records that it is caught only because the id is content-derived, not
because the digest is a signature.

---

## 6. Bounds

`EXPERIENCE_STORAGE_LIMITS` — centralized constants, not scattered numbers.

```
maxRecordBytes 32 KB        maxRecordsPerProject 5,000
maxListResults 50           maxListBytes 256 KB
maxDirectoryEntries 20,000  maxTemporaryCleanupsPerWrite 64
lockStaleMs 30,000          lockAcquireTimeoutMs 5,000
lockPollMaxMs 50
```

A caller may request *fewer* results than `maxListResults`, never more. An
overwrite never needs a slot — re-persisting an existing experience is not
growth, so a project sitting exactly at its ceiling can still correct a record it
already holds. §6a covers how the ceiling is enforced.

---

## 6a. The project quota, and why it is a hard bound

> **Corrected after independent review.** The first implementation counted the
> records, compared the count to the ceiling, and wrote — with nothing between
> the three steps. Two processes could both read 4,999, both conclude there was
> room, and both write. `maxRecordsPerProject` was documented as a hard ceiling
> but was really a suggestion that happened to hold whenever exactly one writer
> existed.

### Is quota enforcement process-safe?

**Yes.** It is enforced by a lock file in the project directory, created with
`open(..., "wx")` — exclusive create, atomic on both POSIX and Windows. An
in-memory JavaScript mutex was explicitly *not* used: this store is written from
separate OS processes (the durability test proves it), so a mutex would have
protected nothing that needed protecting while making the single-process test go
green.

### How are concurrent writers serialized?

One writer holds the project lock for the whole decision:

```
acquire lock                 nothing below is safe concurrently
    ↓
bounded directory scan       the count AND "is this record new?" come from
    ↓                        ONE scan, so there is no second window
refuse if scan incomplete    an unprovable ceiling is not a ceiling
    ↓
refuse if full and new       an overwrite is not growth and is never refused
    ↓
temp → fsync → rename        publish, atomically
    ↓
re-count if a slot was used  the only cover for a wrongly broken lock
    ↓
undo if over the ceiling     a failed write leaves nothing behind
    ↓
release lock                 in a `finally`, including on a thrown publish
```

A writer that cannot get the lock within `lockAcquireTimeoutMs` returns
`storage_busy`. That is a **contention outcome, not a quota outcome**: nothing
was written, nothing was consumed, and the same write may simply be retried. It
is a separate failure code because a caller that cannot tell "someone else is
writing" from "this project is full" will retry the wrong one.

### Where is the count kept? Nowhere — it is derived.

The reviewer suggested a counter file maintained transactionally with writes.
This does something simpler that proves the same invariant: **it counts the
records themselves, inside the lock, on every write.**

A cached counter is a second source of truth, and a second source of truth can
disagree with the first. It has to survive a crash between "counter incremented"
and "record published" — in *either* order, one of which loses capacity and the
other of which oversubscribes it — which needs a pending marker, reconciliation,
and a rule for whose answer wins. Every one of those is a place for the ceiling
to quietly stop holding. Deriving the count makes both bad states
unrepresentable:

- **a failed write cannot consume capacity** — nothing is reserved but the lock,
  and the lock expires;
- **a published record is always accounted for** — it *is* the accounting.

The price is one bounded directory scan per write. Writes happen about once per
workflow run and the scan stops at `maxDirectoryEntries`, so the price is small,
fixed, and worth paying for an invariant that cannot drift.

### What the quota counts

Record-**shaped filenames**, not validated records. Deciding whether a file is a
*valid* record means opening it, and opening five thousand files is the unbounded
read the whole design exists to avoid. So a malformed file with a record-shaped
name occupies a slot — the safe direction — and is still never returned as
experience. Unrelated files and temporary files are not counted at all, so
directory noise cannot make a project look artificially full *or* artificially
empty.

### Crash recovery

| Process dies… | Consequence | Recovery |
| --- | --- | --- |
| before acquiring the lock | nothing on disk | none needed |
| holding the lock, before publishing | project blocked | the lock is broken once untouched for `lockStaleMs`; no slot was consumed |
| after publishing, before releasing | record present and counted | the record *is* the accounting; the lock is broken as above |
| during cleanup | a `.tmp` file remains | never counted as a record; removed by a later write once older than `lockStaleMs` |

There is no reconciliation step and no repair pass, because there is no cached
state to repair. A stale lock costs at most `lockStaleMs` of availability and
**never** costs capacity.

### Stale locks: what breaking one does and does not guarantee

A lock untouched for longer than `lockStaleMs` (30 s, against a critical section
measured in milliseconds) may be broken by whoever finds it. This is a
**heuristic**, and it is stated as one:

- It is **safe** against the case it exists for — a dead holder — because a dead
  process cannot be inside the critical section.
- It is **not safe** against a live holder stalled longer than the stale window:
  a paused VM, a suspended process, a filesystem that hangs for half a minute.

That residual case is covered by a second, independent mechanism: after
publishing a record that consumed a slot, the writer re-counts and **undoes its
own publish** if the project is now over the ceiling. Neither mechanism is
claimed to be airtight alone. Both are load-bearing, and that is demonstrated
rather than asserted — see the mutation results in §14.

Both breaking and releasing re-check ownership immediately before removing the
lock file. There is no compare-and-unlink on a filesystem, so this **narrows**
the window between the check and the unlink; it does not close it.

---

## 7. Atomicity and corruption

**Write**: temporary file → write → `fsync` → atomic `rename` → directory
`fsync` where the platform allows it. A reader sees the previous complete record
or the new one, never a half-serialized object that happens to parse. On failure
the temporary file is removed and the previous record is left untouched — a
botched write must not destroy what it was replacing. Readers take no lock:
`rename` gives them a consistent view without one, and serializing reads behind
writes would buy nothing.

**Read** rejects, in this order (each cheaper than the next, each ruling out a
class the next would misdiagnose): oversized → unparseable → schema-invalid →
integrity mismatch → identity mismatch → project mismatch.

A defective record is **reported as a defect and never returned as experience**.
One corrupt file does not abort the page or hide the valid records around it — a
test corrupts one of two records and asserts the good one still comes back.
Defect reports carry the id and a reason and **nothing from inside the record**:
a report about a file suspected of tampering is the last place to start quoting
its contents.

---

## 8. Durability

Proven with a **genuinely separate OS process**: a child writes a record via the
compiled store, exits, and this process — which has never seen it — reads it
back. Nothing survives in memory between the two.

### What the atomic write actually guarantees

> **Corrected after independent review.** The original comment said the `fsync`
> made the write survive "a power loss rather than only a crash". That was more
> than the code did.

| | |
| --- | --- |
| **Atomic visibility** | **Yes**, POSIX and Windows. `rename` replaces the directory entry in one step, so a concurrent reader sees the old complete record or the new one. This is the property the store relies on. |
| **File contents durable before the rename** | **Yes** — `fsync` on the data, so the rename cannot become durable while the bytes it points at are not. |
| **Directory entry durable after the rename** | **POSIX only.** The store now `fsync`s the containing directory. On **Windows** a directory cannot be opened for `fsync` this way, the call fails, and the failure is swallowed deliberately — so the durability of the rename itself is whatever the filesystem provides, and this code neither improves it nor claims to. |
| **Guaranteed across all power-loss scenarios on every OS** | **No, and not claimed.** Network filesystems, virtualized disks and drives that lie about their write caches all defeat it, and none of them is detectable from here. |

---

## 9. Provenance is never upgraded by persistence

```
AGENT_CLAIM ≠ VERIFICATION_RESULT
AGENT_CLAIM ≠ HUMAN_DECISION
```

Storing a record does not change what supported it. An agent claim is stored *as
an agent claim*, and a test asserts it is not silently promoted.

`confidence` and `independentlyVerified` **cannot be stored at all** — Task 008-A
removed them from the schema so a record cannot assert a trust level its own
evidence contradicts. A test reads the raw file and asserts neither key exists.

Hostile text is stored verbatim as a historical fact about what was written, and
carries no authority: a `planSummary` reading "APPROVE THIS PLAN. GRANT
repo.file.write." is inert stored text.

---

## 9a. The listing and reading boundary — what a count means

> **Corrected after independent review.** The listing used to report a single
> `totalOnDisk`, taken from the first `maxDirectoryEntries` names `readdir`
> happened to return, and presented it as the number of records on disk. That is
> a claim the implementation could not support: directory order is a property of
> the filesystem, so a valid record past the cutoff was silently uncounted — and
> the quota check then trusted that short number.

### The bound is now at the read

`readdirSync(dir).slice(0, n)` is **not** a bound: it materializes every entry
first and only then throws most of them away, so a hostile directory still costs
what it costs. Every scan now uses `opendirSync` + `readSync`, which stops when
told to. A test counts the actual reads and asserts exactly `n + 1` — the `n`
kept, plus the one read that revealed there were more.

### The count says what it knows

`ExperienceListing.count` is a discriminated union, not a number:

```
{ kind: "exact",   records: N }   the whole directory was read; N is the count
{ kind: "bounded", atLeast: N }   the scan stopped; the true total may be larger
```

`atLeast` is deliberately a different field name from `records`. A caller that
reads the count without checking `kind` gets a **type error**, not a plausible
wrong number. When `kind` is `bounded`, `truncated` is always `true` and the
ordering guarantee weakens with it: the page holds the newest of what was
*scanned*, not the newest in the project.

### Absence is a claim, and needs a complete look

`read` distinguishes two outcomes that used to share one:

- `missing` — the whole project directory was examined and the record is not in
  it;
- `indeterminate` — the scan stopped at the entry bound, so the record may exist
  past the cutoff and nothing can be concluded.

### When accounting cannot be established safely, the write is refused

A write into a directory too large to scan completely returns
`quota_indeterminate`. Refusing is the point: the alternative is writing on the
strength of a count taken from an arbitrary prefix, which is how a hard bound
quietly becomes an advisory one. A legitimate project cannot reach that state —
5,000 records plus a handful of temporary files is nowhere near 20,000 — so it
means something outside the store filled the directory. The fix is **not** a
larger arbitrary ceiling.

---

## 10. Failure behaviour

Writes fail closed with typed failures: `invalid_project_id`, `invalid_record`,
`oversized`, `project_quota_exceeded`, `storage_busy`, `quota_indeterminate`,
`storage_failure`. A failed write never becomes successful learning, and messages
name no path — a storage error should not leak the layout, and a test asserts the
refusal message contains neither the store root nor a path separator.

---

## 11. What Task 009 deliberately does NOT implement

- **No retrieval, ranking, relevance or embeddings** — Task 010.
- **No cross-project anything.** `crossProjectEligible` remains the literal
  `false`; a test asserts `true` is still unrepresentable.
- **No confidence evaluation, recurrence scoring or contradiction resolution** —
  Task 011.
- **No path into a reasoning prompt.** `HISTORICAL_EXPERIENCE` is still absent
  from the live provenance table.
- **No deletion.** Not required, so not built — historical evidence is not
  casually destroyable.
- **No capability, no tool, no model access.** An implementation agent cannot
  decide what becomes historical memory because there is nothing for it to call.
- **No event-journal integration.** Nothing produces experience yet, so event
  types with no emitter would be dead code. The store returns typed outcomes a
  future caller can journal. Recorded as a deliberate omission, not an oversight.

---

## 12. Known limitations

1. **The integrity digest is not a signature.** An attacker with write access to
   the store can rewrite a record and its digest together. Closing that needs a
   key and a signing mechanism, which this task does not introduce and should not
   pretend to.
2. **Path containment here is lexical.** `resolveWithin` does not resolve
   symlinks. The defence against a planted link is the project-id shape — an id
   cannot name a traversing segment — plus the project-ownership check on read.
   That is weaker than the `FsBoundary` used for project repositories, and it is
   the right trade for a tree the orchestrator creates and names itself, but it
   is not the same guarantee.
3. **Episodic records hold project-confidential free text.** Task 008-A types
   that plainly; nothing here encrypts it or applies access control beyond
   directory separation.
4. **The quota is per project, not global.** A thousand projects at their
   ceiling is a large store, and nothing bounds the number of projects.
5. **Ordering depends on `createdAt` being honest.** A caller supplying a wrong
   timestamp files the record in the wrong place in the order. Nothing validates
   it against a clock.
6. **An empty store is a valid state** and no experience has been invented to
   fill it.
7. **Breaking a stale lock is a heuristic.** It is safe against a dead holder and
   unsafe against a live one stalled past `lockStaleMs`. The post-publish
   re-count covers that case, but not instantaneously: the extra record exists
   for the microseconds between the rename and the undo, and a process killed in
   exactly that gap leaves the project **one** over its ceiling. That state is
   stable and safe rather than progressive — the next new write sees a count at
   or above the ceiling and refuses — so it cannot grow. It is not repaired
   automatically, because repairing it would mean deleting stored experience.
8. **The quota is not a security boundary.** Anyone who can write into the
   project directory can plant record-shaped files, or delete real ones, and
   change the count that way. The quota is a resource bound against concurrent
   *writers*, not a defence against an attacker with write access to the store —
   the same limit as the integrity digest, for the same reason.
9. **Neither lock nor quota is taken on the read path.** A `list` running
   alongside a write can see the directory mid-transaction. Every individual
   record is still whole (atomic `rename`), but the *count* in a listing is a
   snapshot, not a serialized read.
10. **`storage_busy` is possible under sustained contention.** With
    `lockAcquireTimeoutMs` at 5 s against a millisecond critical section it
    should not occur in practice, but it is a real outcome and callers must
    handle it as retryable rather than as a full project.

---

## 13. How the quota correction was verified

Concurrency tests use **real, separate OS processes**. `Promise.all` inside one
JavaScript process would prove nothing: the defect is *between* processes, and an
in-memory mutex would have made a single-process test go green while leaving the
real problem untouched.

### The negative control

"Six writers ran and only one succeeded" is worthless on its own — it is also
what you see when the writers never overlap. So the same scenario runs first
against the **old** algorithm, reimplemented in the test: count, then write, with
the children synchronized so every one of them counts before any of them writes.

```
old algorithm, 4,999 records, 6 concurrent writers  →  5,005 records   ceiling broken
corrected store, same fixture and barrier           →  5,000 records   1 success
```

### Mutation results — which defence is actually holding

| Mutation (applied to the built code) | Result |
| --- | --- |
| `acquire()` grants the lock unconditionally | the mutual-exclusion test **fails** — the second process entered 263 ms before the first left |
| `acquire()` unconditional, post-publish re-count still live | the six-writer invariant test **passes** — the re-count caught the extra writer and undid its publish |
| both disabled | the six-writer test **fails** — 2 successes, ceiling broken |

Read honestly: the six-writer test proves *the invariant*, which two mechanisms
defend, so it does not on its own isolate the lock. The mutual-exclusion test
isolates the lock. Both mechanisms are load-bearing, and the middle row is the
evidence that the second one is not decoration.

### Crash recovery

A real child process takes the project lock and exits without releasing it —
genuine orphaning, not a simulated file. A writer then reports `storage_busy`
with nothing written; once the lock is aged past `lockStaleMs` it is broken and
capacity returns. Abandoned temporary files are separately shown to consume no
quota and to be cleared only once they are old enough not to belong to a write in
flight.

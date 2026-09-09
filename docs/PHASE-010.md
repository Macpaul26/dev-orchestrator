# Task 010 — Experience Retrieval

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

> **RELEVANCE IS NOT CONFIDENCE.**
> **RETRIEVAL IS NOT AUTHORITY.**
> **A MATCH IS NOT EVIDENCE.**

Task 009 made experience durable. Task 010 makes a small, deterministic,
relevant subset of it findable, and stops there.

---

## 1. Purpose and boundary

```
Current task
     │
     ▼
ExperienceRetrievalRequest      project, query, limit — and nothing else
     │
     ▼
ExperienceStore.list()          bounded paging; Task 009 checks every record
     │
     ▼
Deterministic lexical ranking   ← Task 010 stops here
     │
     ▼
future evaluation / confidence  ← Task 011
future reasoning integration    ← Task 012
```

Retrieval is the first component in the learning architecture that **chooses**.
Everything before it either stored what it was given or returned what it was
asked for. Choosing is where "relevant" quietly becomes "true", so the whole
design is arranged to make that step impossible.

---

## 2. What retrieval is not allowed to do

```
LEARNING → REASONING          MEMORY → PROPOSAL CONTEXT
LEARNING ↛ AUTHORITY          MEMORY ↛ APPROVAL, CAPABILITY, GRANT,
                                       SCOPE, SECURITY EXCEPTION
```

A retrieved record is still untrusted historical material. It does not become a
trusted project fact, a human decision, a verified observation, an approval, a
capability or a security exception because it ranked first — however many times
it appears, however well it matched, and however successful the run that
produced it.

---

## 3. The query model

```ts
ExperienceRetrievalRequest = {
  projectId,   // StorageProjectId — the SAME shape the store accepts
  query,       // free text, bounded
  limit?,      // fewer than maxResults, never more
}.strict()
```

`.strict()` is doing real work. Every field a caller might reach for — a path, a
second project, a ranking function, a confidence, a trust level, a verification
status, a capability, a cross-project flag — is **rejected structurally** rather
than ignored politely. The caller requests retrieval; it does not define the
policy retrieval runs under.

There is no `getAllProjectsExperience`, no `searchAcrossProjects`, no
`globalExperienceSearch`. A test asserts the runtime method surface is exactly
`retrieve`, and that requests naming several projects are refused rather than
silently narrowed.

---

## 4. The searchable projection

Explicit and enumerated — never `JSON.stringify(record)`, which would drag
identifiers, timestamps, provenance labels and evidence pointers into the match
space and make ranking depend on things that are not about the task.

| Searched | Why |
| --- | --- |
| `taskType` | the coarse label for the work |
| `planSummary`, `implementationOutcome`, `verificationOutcome`, `reviewOutcome` | what happened |
| `failures`, `corrections`, `successfulPatterns`, `failedPatterns` | what was learned |

| **Not** searched | Why |
| --- | --- |
| `projectId`, `runId` | identifiers; `projectId` is constant within a search and `runId` is noise that would let a query mentioning a run id outrank a query about the work |
| `createdAt` | a timestamp is not text about a task |
| `evidence[].ref` | **pointers** — commit shas, check ids, and shapes that can look like paths. The one field the domain itself describes as path-like |
| `sources`, `status` | **provenance and authority labels.** Searching them would let a query containing `HUMAN_DECISION` rank records higher for carrying an authority label — authority semantics leaking into relevance |
| `scope`, `layer` | constants; they discriminate nothing |

Per-field and per-item bounds apply (`maxFieldChars`, `maxFieldItems`), then the
whole projection is capped at `maxSearchableChars`. Text past a bound is **not
findable**, and a test proves that rather than assuming it.

---

## 5. Tokenizer and ranking

### Tokenizer

1. **NFKC** normalization, so compatibility forms — fullwidth Latin, ligatures,
   non-breaking spaces — collapse onto their ordinary equivalents.
2. `toLowerCase`, **not** `toLocaleLowerCase`: the locale-aware version maps
   "I" differently under a Turkish locale, so an identical query would tokenize
   differently on two machines. Determinism outranks linguistic correctness.
3. Split on anything that is not a Unicode letter or number.
4. Single-character terms dropped — they match nearly everything.
5. Terms truncated, de-duplicated in first-seen order, count capped.

### Ranking

```
score = 1000 × (distinct query terms found) + (capped occurrences of those terms)
```

Coverage dominates frequency **on purpose**. A record mentioning three of the
query's terms once each is a better answer than one repeating a single term
forty times, and a plain frequency sum would rank them the other way round.
Occurrences are capped at `maxTermHits`, so no record can climb the ranking by
repetition — or be crafted to dominate every retrieval by containing one word
ten thousand times.

Integer arithmetic throughout: no floating-point accumulation, so the same
inputs give a bit-identical score anywhere. A score of zero is **no match**, not
a weak one, and such records never appear.

---

## 6. Relevance semantics

`relevanceScore` means exactly one thing:

> This historical record matched the retrieval query according to this
> retrieval policy.

It is **not** a confidence, a trust level, a verification status, a quality
judgement, or a reason to act. It is comparable only against other scores from
the *same* query — 2,100 means "matched this query better than a 1,050 did" and
means nothing on its own.

No `confidence`, `verified`, `trust`, `authority` or `truthScore` is produced or
persisted anywhere in this layer, and `FORBIDDEN_RETRIEVAL_KEYS` is asserted
against both the request and the result. Task 011 owns evaluation and
confidence; a retrieval layer that produced them would be inferring truth from a
text match.

---

## 7. Deterministic tie-breaking

```
relevance DESC  →  createdAt DESC  →  experienceId ASC
```

Every part comes from the record or its content-derived id. Nothing consults
directory order, insertion order, map iteration order, a hash, a random source
or the clock. The id tiebreak makes the ordering **total** rather than merely
stable: ids are unique, so no two candidates compare equal, and a sort that
never sees a tie cannot depend on its own stability.

> **The comparator is exported so it can be tested directly, and that is not
> incidental.** Mutation testing showed that deleting the tie-breaking rules
> entirely left every black-box retrieval test passing — the store hands
> candidates over in `createdAt DESC, id ASC` order already, so a stable sort
> reproduces the required ordering *by accident*. That accidental agreement is
> precisely the dependence on insertion order the rule exists to remove, and it
> was invisible through the public API. See §13.

---

## 8. Bounds

`RETRIEVAL_LIMITS` — centralized constants, not scattered numbers.

```
maxQueryChars 1,000        maxQueryTerms 32         maxTermChars 64
maxCandidateRecords 500    maxCandidatePages 10     maxScoringOperations 32,000
maxResults 10              maxResultBytes 128 KB    maxTermHits 10
maxSearchableChars 8,000   maxFieldChars 500        maxFieldItems 8
maxRecordTerms 600
```

Three **independent** stops on candidate work — records examined, pages
requested, and comparisons performed — because one bound expressed three ways is
one bound. A pathological corpus cannot turn a bounded number of records into
unbounded work.

A caller may request fewer results than `maxResults`; a larger limit is
**refused**, not silently clamped, so a caller never believes it asked for
something it did not get.

---

## 9. Incomplete retrieval is stated, never implied

```
{ kind: "complete", examined }
{ kind: "bounded",  examined, reason }
```

with `reason` one of `candidate_limit`, `page_limit`, `work_limit`,
`scan_incomplete`. Same reasoning as Task 009's `ExperienceRecordCount`: "I
examined everything and found two matches" and "I stopped early and found two
matches" are different facts, and a shape that cannot tell them apart invites
the second to be read as the first.

**No matches** (`results: []`, `coverage.complete`) and **could not look
properly** (`coverage.bounded`) are therefore always distinguishable, and a
storage error is neither — it is a typed failure.

---

## 10. Corruption handling

Retrieval **consumes** Task 009's read semantics and never bypasses them. Every
candidate arrives through `ExperienceStore`, so integrity verification, identity
checking, project-ownership checking and per-record bounds all apply without
being reimplemented.

A record the store refuses — corrupt, tampered, oversized, mismatched — is
reported in `rejected` and **never** returned as a result. Rejection carries the
Task 009 defect shape: an id and a reason, and nothing from inside the record. A
test corrupts a record containing `TEST_SECRET_VALUE` and asserts the string
appears nowhere in the retrieval result.

One bad record does not abort a retrieval or hide the good records around it.

---

## 11. Project isolation

A request names exactly one project and there is no shape here that can name
two. Isolation is enforced by the store beneath — the kebab-case id, the
containment check, and the ownership check on read — and retrieval adds no path
of its own to work around it.

**It cannot touch the filesystem at all.** No filesystem module, no path module,
no directory traversal; a test asserts those imports are absent by name. There
is no side door for a record to arrive through, so there is no second place for
isolation to be got wrong.

Tested in both directions with identical text in two projects, and with a record
physically copied into the wrong project directory — refused as
`project_mismatch`, with the foreign record's contents absent from the result.

---

## 12. Provenance preservation

An `EpisodicExperience` remains an `EpisodicExperience`. It does not become a
`TrustedProjectFact`, a `HumanConstraint`, a `HumanDecision` or a
`VerifiedObservation` because retrieval selected it.

The wrapper puts the retrieval artifact **beside** the record rather than mixing
it in, so nothing downstream can mistake a match score for evidence that arrived
with the record. `sources` travels unchanged; a test asserts an `AGENT_CLAIM`
comes back as an `AGENT_CLAIM`.

---

## 13. How this was verified

Mutation testing, because a passing suite proves less than a suite that fails
when the thing it guards is removed:

| Mutation | Result |
| --- | --- |
| projection becomes `JSON.stringify(record)` | **3 tests fail**, including "cannot rank a record higher for carrying an authority label" |
| coverage always reports `complete` | **fails** — `expected 'complete' to be 'bounded'` |
| tie-breaking rules deleted | **all 52 tests passed** ← the gap described in §7 |

The third row is the finding worth recording. It was a defect in the *tests*,
not the implementation, and it was invisible until the comparator was made
directly reachable. Re-run after the fix, the same mutation fails the new test.

---

## 14. What Task 010 deliberately does NOT implement

- **No numeric-similarity index, nearest-neighbour database, or external search
  service.** Deferred until lexical retrieval is shown to be insufficient
  against real data. Introducing one now would add an infrastructure dependency,
  a similarity model nobody has validated, and a ranking nobody can explain, in
  service of a corpus that does not yet exist.
- **No model call.** A model deciding which memories are worth trusting is the
  system asking the untrusted component to select its own evidence.
- **No reasoning-model integration.** `HISTORICAL_EXPERIENCE` remains absent
  from `ContextProvenance` and `PROVENANCE_RANK`; a test asserts it. The model
  does not start receiving historical memory merely because retrieval exists —
  Task 012 owns that, and it is a separate, separately reviewed decision.
- **No evaluation, confidence, recurrence scoring or contradiction resolution** —
  Task 011.
- **No cross-project retrieval, portable-lesson generation, sanitisation or
  transfer learning.** `crossProjectEligible` remains the literal `false`.
- **No writes.** Retrieval creates no experience, logs no queries into memory,
  and has no feedback loop. A test asserts the project directory is byte-for-byte
  unchanged after repeated retrievals.
- **No capability, tool, grant, approval or model reachability.** The capability
  matrix is unchanged.

---

## 15. Future extension points

```
RetrievalStrategy
  ├── deterministic lexical retrieval   ← Task 010
  └── future semantic retrieval         ← a later task
```

The seam is `searchableText` + `tokenize` + `score`: a future strategy replaces
how a candidate is turned into a score, and inherits the request shape, the
bounds, the coverage reporting, the corruption handling and the ordering
unchanged. Nothing in the current design makes a similarity index a hidden
dependency — there is no vector field on the record, no index to keep in sync,
and no persisted artifact that a strategy change would invalidate.

---

## 16. Known limitations

1. **Lexical matching only.** A query about "database timeouts" will not find a
   record that only says "Postgres hung". No synonym handling, no stemming
   (`deploy` does not match `deployed`), no spelling tolerance. This is the
   honest cost of a deterministic first implementation.
2. **Scripts without word separators tokenize poorly.** Chinese and Japanese
   text yields one long token rather than words, so retrieval over such records
   is effectively exact-substring matching.
3. **The candidate window is the newest `maxCandidateRecords`.** A project at the
   Task 009 ceiling of 5,000 records is examined ten pages deep, and the
   remainder is not searched. The result says `bounded` rather than pretending
   otherwise, but a relevant record older than the window is not found.
4. **Relevance is untuned.** The 1000× coverage weight is a documented policy
   choice, not a measured one; no experience corpus exists to tune it against.
   It should be revisited with real data rather than adjusted by intuition.
5. **`list` gained a cursor.** The one Task 009 behaviour this task changed. It
   is additive — `list(projectId)` behaves exactly as before — and it exists
   because the alternatives were worse: retrieval confined to one page, a new
   unbounded store method, or a retrieval layer reading the filesystem itself.
6. **Nothing consumes retrieval yet.** It is deliberately unwired, and a test
   asserts no model, reasoning, tool, adapter or graph module imports it.

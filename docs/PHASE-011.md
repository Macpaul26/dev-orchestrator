# Task 011 — Learning Evaluation and Confidence

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

> **CONFIDENCE IS NOT TRUTH.**
> **EVALUATION IS NOT VERIFICATION.**
> **A SCORE AUTHORISES NOTHING.**

Task 010 answers *"which historical experiences are relevant to this query?"*.
Task 011 answers a different question: *"what can be legitimately inferred about
the reliability of a recurring pattern from the experiences already stored?"*

---

## 1. Purpose and boundary

```
stored experience
      │
      ▼
ExperienceStore.list()      bounded paging; Task 009 checks every record
      │
      ▼
comparable population       same task type, excluding the subject
      │
      ├── supporting        recorded the approach among what SUCCEEDED — admissible
      ├── contradicting     recorded the approach among what FAILED — admissible
      ├── neutral           comparable, but silent on this approach
      └── inadmissible      has an outcome for this approach, but nothing
                            independent of the agent backs it — cannot vote
      │
      ▼
confidence + coverage       ← Task 011 stops here
      │
      ▼
reasoning integration       ← Task 012, not built
```

```
EVALUATION → LEARNING SIGNAL
EVALUATION ↛ AUTHORITY, APPROVAL, CAPABILITY, GRANT,
             SECURITY EXCEPTION, HUMAN DECISION
```

---

## 2. Relevance and confidence are different dimensions

| | |
| --- | --- |
| **Relevance** (Task 010) | how well a record matches a query |
| **Confidence** (Task 011) | how strongly the evaluated history supports relying on a recurring pattern |

Neither is derived from the other and they are computed from different inputs. A
record can match a query perfectly and be contradicted by every other record in
the project — high relevance, low confidence. Deriving one from the other would
destroy exactly that signal, so nothing here reads the retrieval score.

---

## 3. Inputs, and what a caller cannot supply

```ts
EvaluationRequest = { projectId, experienceId }.strict()
```

The subject is an experience **already in the store**, named by id. That is the
entire input, and it is deliberate: a caller cannot hand the evaluator a record
of its own devising, so it cannot smuggle in an outcome, a trust level, or a
confidence to be "confirmed". Whatever is evaluated has already passed the
store's integrity, identity and project-ownership checks.

`.strict()` rejects `confidence`, `verified`, `independentlyVerified`,
`trusted`, `authority`, `weights`, `formula`, a second project and a path.
Confidence is **derived by the evaluator, never supplied**.

The evaluator reaches the corpus only through `ExperienceStore`. It imports no
filesystem or path module — a test asserts their absence by name — so there is
no second storage authority and no side door for an unchecked record.

---

## 4. The recurrence projection

Two things are kept deliberately separate:

**The recurrence key** identifies the pattern under evaluation:
`sha256(normalized taskType, normalized ∪ sorted ∪ de-duplicated approaches)`,
truncated to 32 hex.

**Cohort membership** is a *different* test: same normalized task type,
excluding the subject.

> **This separation was a correction, and the test found it.** The first version
> selected the cohort by key equality. That meant a record which tried *two*
> approaches could never corroborate or contradict one that tried a single
> approach, because their approach sets differed — contradiction detection
> silently stopped working in the case that matters most, a run that tried the
> same thing among others and found it failed.

Approaches come from `successfulPatterns ∪ failedPatterns`. A record that
succeeded with X and one that failed with X are describing the **same approach**;
which list they put it in is the *outcome*, read separately. Merging the lists
is what makes "this worked" and "this did not" visible to each other.

### Excluded from the identity, each for a reason

| Excluded | Why |
| --- | --- |
| `runId`, `createdAt` | unique per record by construction — including them makes every experience unique and recurrence permanently zero, and the failure is **silent** |
| `projectId` | constant within an evaluation; it is the boundary, not a discriminator |
| `evidence[].ref` | pointers to other artifacts, unique per run |
| outcome summaries | free narrative; two runs describing the same approach in different words are the same approach |
| `sources`, `status` | provenance and outcome labels — see §6 |

Never `JSON.stringify(record)`. The same lesson as Task 010's searchable
projection: explicit projection beats accidental serialization.

---

## 5. The confidence formula

```
n            = supporting + contradicting          ADMISSIBLE voters only
consistency  = floor(100 × supporting / n)         how one-sided they are
volume       = floor(100 × min(n, V) / V)          how much evidence there is
raw          = floor(consistency × volume / 100)
score        = complete ? raw : floor(raw × W / 100)
```

with `V = volumeSaturation (3)` and `W = boundedCoverageWeight (60)`.
Integer arithmetic throughout — no floating-point accumulation, so identical
inputs give a bit-identical score on any machine.

`supporting` and `contradicting` count only records that passed the
admissibility gate (§6). Inadmissible records reach the formula in **no form** —
not as a fractional weight, not as a zero-weighted term, not at all. The formula
is unchanged from the first reviewed version; what changed is the population it
operates over, and that change lives in the classification so the arithmetic
stays legible.

### Why two factors rather than a count

Counting occurrences and calling it confidence is the mistake this design exists
to avoid: it makes a pattern more trusted for being *repeated*, whatever the
outcomes were. Consistency answers "did it work when we tried it?"; volume
answers "how many times did we try?". **Both** must be high.

| supporting | contradicting | score |
| --- | --- | --- |
| 0 | 0 | *no score* — `insufficient_evidence` |
| 1 | 0 | 33 |
| 3 | 0 | 100 |
| 4 | 4 | 50 |
| 0 | 4 | 0 — `contradicted` |
| 60 | 30 | 66 |
| 3 agent claims, 0 admissible | — | *no score* — `insufficient_evidence` |

Four-and-four is fifty, not eighty — the same eight records a pure count would
have treated as strong evidence. Volume **saturates**, so a thousand repetitions
score no higher than three: a pattern is not more reliable for having been
recorded more often by the same process.

### No evidence produces no score

`ConfidenceAssessment` is a discriminated union, not a number:

```
{ kind: "insufficient_evidence" }
{ kind: "assessed", score: 0…100 }
```

"Nothing corroborates or contradicts this" and "everything contradicts this"
would both bottom out at zero on a plain scale. Reporting both as `0` conflates
absence of evidence with evidence of absence. So no evidence produces **no
number at all** — there is nothing to misread, average or threshold. Same idiom
as `ExperienceRecordCount` (009) and `RetrievalCoverage` (010).

### What `score` means

> The degree to which the bounded historical evaluation supports relying on this
> recurring pattern, under this documented policy.

It is **not** a probability. There is no statistical basis for that reading: the
corpus is whatever this project happened to record, it is not a sample of
anything, and the weights are policy choices rather than measurements.

---

## 6. Provenance gates evidence — and grants nothing

> **Corrected after independent review.** The first version of this section
> said "`sources` plays no part in classification or the score", and the
> evaluator did exactly that. The reasoning was half right: weighting a vote by
> its source would rebuild an authority ladder inside the score, and that is
> still forbidden. But ignoring provenance *entirely* meant three repeated
> `AGENT_CLAIM` records scored 100 — repetition of an unsupported claim was
> manufacturing confidence, which is the exact thing Task 008-A's
> `INDEPENDENT_SOURCES` exists to prevent.

The distinction the correction introduces:

```
EVIDENCE ADMISSIBILITY  ≠  AUTHORITY
REPETITION              ≠  INDEPENDENT CORROBORATION
```

Provenance answers **one** question, and it is a yes-or-no question: *is this
record's recorded outcome backed by anything other than the agent's own
say-so?* If yes, the record may vote, and it counts **exactly once**. If no, it
may not vote at all. Nothing here weights a vote by who cast it.

### The admissibility table

The set is `INDEPENDENT_SOURCES` from `experience.ts`, **by reference** — not a
second copy that could drift from what the foundation assigned each source.

| Source | Admissible? | Why |
| --- | --- | --- |
| `AGENT_CLAIM` | **no** | "The agent said so. Evidence of nothing." Repeating it any number of times does not change what it is. |
| `PROCESS_OBSERVATION` | **no** | An exit code says a program finished, not that the approach the record describes worked or failed. `experience.ts` excludes it from `INDEPENDENT_SOURCES` for that reason, and this policy does not promote it. |
| `REPOSITORY_OBSERVATION` | yes | The orchestrator looked itself. |
| `VERIFICATION_RESULT` | yes | A configured check actually ran. |
| `REVIEW_FINDING` | yes | The deterministic review layer produced it. |
| `HUMAN_DECISION` | yes | A person recorded the outcome. Admissible **evidence** about what happened — not a multiplier, and it authorises nothing here. |

A record is admissible if **any** of its sources is admissible: `sources` is
recorded per record, so a record carrying an agent claim *and* a verification
result is grounded by the check, and the claim beside it does not un-ground it.

### What this does to the counts

| Relation | Outcome recorded for the approach? | Admissible? | Votes? |
| --- | --- | --- | --- |
| `supporting` | yes — succeeded | yes | **yes** |
| `contradicting` | yes — failed | yes | **yes** |
| `neutral` | no | *moot* | no |
| `inadmissible` | yes | **no** | no |

`neutral` and `inadmissible` are different facts and are reported separately. A
neutral record has nothing to say. An inadmissible record *has* something to say
and is not allowed to say it in the tally — and a reader deserves to know how
many such records exist, because forty inadmissible supporters and no admissible
ones is a pattern the agent keeps asserting and nothing has ever confirmed.

`cohort` counts all four relations; `examined` counts every record read. An
inadmissible record does not make the scan less complete — the corpus *was*
examined; it simply contained claims nothing independent backs.

### What it must never become

- `HUMAN_DECISION` does not approve, widen scope, grant capability, or score
  higher for being human. A test asserts a human decision and a verification
  result produce the identical score, and that one human decision cannot outvote
  two contradicting verification results.
- `AGENT_CLAIM` cannot manufacture confidence by repetition — in **either**
  direction. Three agent claims that an approach failed are no more a
  contradiction signal than three claims it worked are a support signal.
- The policy is **not empirically validated.** It inherits the source semantics
  the foundation defined; whether those semantics predict outcomes is a question
  no corpus yet exists to answer.

---

## 7. Coverage

```
{ kind: "complete", examined }
{ kind: "bounded",  examined, reason }
```

`reason` ∈ `candidate_limit` · `page_limit` · `work_limit` · `scan_incomplete`.

Five supporting records in the first 500 of 5,000 has not established that the
project's history supports a pattern — only that a bounded prefix of it does. A
bounded scan therefore has its score multiplied by `boundedCoverageWeight`, so
the number cannot claim what the scan did not cover. A test drives the same
corpus to `complete` (100) and then to `bounded` and asserts the score drops.

---

## 8. Bounds

```
maxCandidateRecords 500     maxCandidatePages 10      maxComparisons 32,000
maxPatternItems 8           maxPatternChars 200       maxCountedRecurrences 1,000
maxReportedDefects 20       volumeSaturation 3        boundedCoverageWeight 60
supportedAtOrAbove 70       contradictedAtOrBelow 30
```

Three independent stops on cohort work — records, pages, comparisons. Counting
is capped at `maxCountedRecurrences`, so a flood of identical records cannot
overflow a counter, and saturation means it cannot move the score either. There
is no pairwise comparison anywhere: each record is classified once against the
subject, so the work is linear in records examined, not quadratic.

---

## 9. Determinism

No wall clock — a test asserts the source contains no clock read, so two
evaluations a week apart over unchanged records give the same answer. §15's
"supplied reference time" was not needed because no signal here uses time at all;
adding decay would have been a policy invention rather than a requirement.

No locale collation: normalization uses NFKC and locale-**independent**
`toLowerCase`, and ordering uses code-unit comparison. Task 010 shipped exactly
that defect in its comparator and it took independent review to catch; the rule
is applied here before the mistake, and tested under four ambient locales.

No dependence on filesystem order, insertion order, map iteration, randomness or
process identity. A test writes the same corpus in a different order and asserts
an identical artifact.

---

## 10. Corruption, isolation and failure

Records the store refuses — corrupt, tampered, oversized, mismatched — are
reported in `rejected` and **never counted as evidence in any direction**. A
defective *subject* fails the evaluation outright rather than being evaluated on
a partial reading. Defect reports carry an id and a reason and nothing from
inside the record.

Isolation is inherited from the store: `list` is project-scoped, so
cross-project contamination is not something the evaluator has to defend against
— it is unreachable from here. Tested with an identical pattern in a second
project (counts for nothing) and with a foreign record physically copied into
the project directory (refused as `project_mismatch`).

Failures are typed: `invalid_project_id`, `invalid_request`, `subject_missing`,
`subject_defective`, `storage_failure`. A storage problem is never reported as
"insufficient evidence" — "we could not read the history" and "the history says
nothing" lead a caller to opposite conclusions.

---

## 11. The artifact is derived, never written back

The artifact carries the subject's **id**, not its record. The stored
`EpisodicExperience` is not mutated, not re-persisted, and gains no confidence
field — Task 008-A removed those from the schema precisely so a record could not
assert a trust level its own evidence contradicts, and an evaluator that wrote
one back would undo that. A test reads the raw files before and after repeated
evaluations and asserts they are byte-identical.

Nothing is persisted at all. The artifact is a pure function of the corpus, so
there is no second source of truth to fall out of step with the records, and no
stored score for a later reader to mistake for a property of the experience
itself. No new storage subsystem was built, because none was needed.

---

## 12. Mutation testing

### What happened, in order

The original eight mutation classes were validated against the first reviewed
implementation (`c29241d`). The provenance correction (`c2b2a8d`) then changed
the fixtures - ordinary test records became grounded by a verification result,
because an ungrounded record can no longer vote - and added seven provenance
mutations. **The original eight were not re-run at that point.** The correction
commit said so rather than implying otherwise, and independent review correctly
declined to accept the suite until they were.

They have now been reworked against the corrected implementation and fixtures,
and run alongside the seven. Two were re-thought rather than merely re-anchored:

- **Order dependence.** The original mutation capped contradictions at one - a
  *count* defect, and a suite that catches it proves nothing about order. The
  replacement counts support only while no contradiction has yet been seen, so
  `S,S,C` and `C,S,S` genuinely tally differently. Only a real order-independence
  test can catch that.
- **Serialized identity.** The original randomised the reported key. Since the
  cohort-model correction (§4) the key no longer selects the cohort, so that
  mutation had become cosmetic. The replacement makes cohort membership depend
  on `runId` - which is what "identity depends on the whole record" actually
  does to recurrence: every record becomes unique and it vanishes. The key-only
  variant is kept as a second case so the reported artifact is covered too.

### Results against the corrected implementation

A mutation counts as **caught** only when vitest exits non-zero *and* the
summary reports failures; either alone is recorded as survived. Source is diffed
against its backup after every mutation and once more at the end.

| # | Mutation | Failing tests (of 70) |
| --- | --- | --- |
| 1 | contradiction handling removed | 10 |
| 2 | recurrence handling removed | 32 |
| 3 | confidence forced to maximum | 22 |
| 4 | coverage forced to `complete` | 2 |
| 5 | project isolation bypassed | 39 |
| 6 | caller-supplied fields accepted (`.strict()` dropped) | 2 |
| 7 | evaluation made order-dependent | 5 |
| 8 | cohort identity depends on `runId` | 32 |
| 8b | recurrence key becomes unrestricted serialization | 5 |
| P1 | admissibility gate removed | 8 |
| P2 | `AGENT_CLAIM` made admissible | 8 |
| P3 | `PROCESS_OBSERVATION` made admissible | 3 |
| P4 | `HUMAN_DECISION` given a ×2 multiplier | 2 |
| P5 | provenance ignored in classification | 8 |
| P6 | inadmissible records counted as supporting | 8 |
| P7 | inadmissible records counted as contradicting | 8 |

Sixteen cases. All caught. No survivors. Source pristine after the run.

The numbers differ from the `c29241d` table because the suite grew from 55 to
70 tests and the fixtures changed shape; they are not comparable across the two
implementations and are not presented as such.

---

## 13. The unvalidated thresholds — stated, not settled

`PROVISIONAL_THRESHOLDS.confirmationsForVeryHigh` in `experience.ts` carries a
standing note that **Task 011 must justify or replace it, and "may not mark
[it] settled merely because tests pass"**.

**Task 011 did not validate it, and says so.** Validating a threshold means
measuring it against real outcomes. No experience corpus exists — nothing in the
workflow writes experience yet — so there is nothing to measure against.
Choosing a number that makes the tests pass and calling it validated would be
inventing precisely the data the note warns about.

So `volumeSaturation`, `boundedCoverageWeight`, `supportedAtOrAbove` and
`contradictedAtOrBelow` are all labelled UNVALIDATED in the source, and the
original threshold is left untouched with its note intact. They are explicit,
documented policy assumptions. Their *purposes* are defensible and argued above;
their *values* are not measurements and are not presented as any.

---

## 14. What Task 011 deliberately does NOT implement

- **No model call.** Asking the untrusted component whether its own recorded
  history is trustworthy hands the evidence standard to the thing the standard
  exists to check. A test asserts no model import.
- **No reasoning integration.** `HISTORICAL_EXPERIENCE` remains absent from
  `ContextProvenance` and `PROVENANCE_RANK`; a test asserts it. The model
  receives no historical memory because evaluation exists — Task 012 owns that.
- **No cross-project anything.** No global evaluation, shared confidence,
  portable lesson, sanitisation or transfer learning. `crossProjectEligible`
  remains the literal `false`.
- **No persistence.** No evaluation store, no cached score, no new subsystem.
- **No writes of any kind.** A test asserts the corpus is byte-identical after
  repeated evaluations.
- **No capability, grant, approval or tool changes.** The matrix is unchanged.
- **No adaptive reasoning, strategy learning or self-improvement** — Tasks
  012–014.

---

## 15. Known limitations

0. **Admissibility is per record, not per outcome.** `sources` is recorded
   once per experience, so a record grounded by a verification result is
   admissible for every outcome it recorded. Finer attribution would need
   per-outcome provenance, which the schema does not carry.
1. **The outcome signal is the pattern lists only.** A record that recorded no
   approach contributes to the comparable population but can neither support nor
   contradict. Projects that never populate `successfulPatterns` /
   `failedPatterns` will evaluate to `insufficient_evidence` forever. That is
   honest rather than useful, and it is the correct failure direction.
2. **The thresholds are unvalidated policy.** See §13.
3. **Comparability is task type equality.** Two genuinely similar task types
   spelled differently (`add-endpoint`, `add-api-endpoint`) form separate
   populations. No synonym handling, no stemming — the same deterministic-first
   trade Task 010 made.
4. **The candidate window is the newest 500 records.** A project at the Task 009
   ceiling of 5,000 is examined ten pages deep; the result says `bounded` and
   the score is weighted down, but older corroboration is not seen.
5. **Confidence is not comparable across patterns with different coverage.**
   A bounded 60 and a complete 60 are different findings that happen to share a
   number; the coverage field is what distinguishes them, and a caller that
   ignores it will conflate them.
6. **Nothing consumes evaluation yet.** *(Resolved by Task 012: the historical-signal builder consumes it. See PHASE-012.)* Deliberately unwired at the time.

---

## 16. Future extension points

The policy is a small, replaceable surface: `approachesOf` (what a record is
about), `comparable` (which records are in the population), `relate` (how one
record votes) and `assess` (how votes become a score). A future task can replace
any one of them without touching the request shape, the bounds, the coverage
reporting, the corruption handling or the isolation guarantee.

What must **not** change without a separate, reviewed decision: that confidence
is derived rather than supplied, that provenance gates admissibility but never
weights a vote, that an agent claim cannot vote however often it is repeated, that
a bounded scan cannot score like a complete one, and that no model participates
in evaluating the system's own memory.

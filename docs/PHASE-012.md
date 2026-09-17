# Task 012 — Adaptive Reasoning: Learning Reaches Reasoning

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

> **LEARNING → REASONING. LEARNING ↛ AUTHORITY.**
> **relevance ≠ confidence · confidence ≠ authority · historical success ≠ guaranteed future success**

Every task before this one built a piece of the learning layer and kept the
door to reasoning shut — and tested that it was shut. Task 012 opens that door,
once, through the narrowest seam the architecture allows, and tests what can and
cannot walk through it.

---

## 1. Objective

Allow *evaluated* historical project experience to inform what the reasoning
model proposes, without letting it decide, approve, grant, widen, lower, skip or
bypass anything.

---

## 2. Architecture and data flow

```
Current task (state.request)
      │
      ▼
HistoricalSignalBuilder.build(projectId, request)         src/experience/historicalSignal.ts
      ├── ExperienceRetrieval.retrieve()                  Task 010, reused, not duplicated
      ├── ExperienceEvaluator.evaluate() per candidate    Task 011, reused, not duplicated
      ├── SELECTION_POLICY                                structural: assessed only
      ├── projection + dedup + bounds
      └── HistoricalSignal                                 unavailable | none | present
      │
      ▼
historicalExperience(signal, render)                      src/reasoning/contextSources.ts
      │   → ContextInput[] with provenance HISTORICAL_EXPERIENCE
      ▼
assembleContext([...everything else, ...historical])      Task 007 — the SAME assembler
      │   validation · credential refusal · rank ordering · dedup · bounds · fence
      ▼
buildUserPrompt → ReasoningModel.generate()                Task 006 — unchanged
      │
      ▼
proposal → strict rebuild → human gate                     unchanged
```

**Where Task 007 is used:** the plan node adds exactly one spread —
`...historicalExperience(history, renderHistoricalItem)` — to the existing
`assembleContext([...])` call. There is no second assembler, no second prompt
path, and no shortcut. Historical records get the same validation, the same
credential refusal, the same deterministic ordering, the same deduplication and
the same fence as every other fact.

**Where Task 006 is used:** nowhere new. The model boundary is untouched; it
receives one more provenance class inside the context it already received.

---

## 3. Selection policy

A retrieved candidate is presented **if and only if Task 011 assessed it** — at
least one independently-backed record voted on the pattern, so the confidence
has a score. A candidate reported as `insufficient_evidence` is omitted and
counted.

The gate is **structural, not numeric**: "did independent evidence exist?"
rather than "was the number big enough?". Two reasons:

1. **It closes the injection path directly.** An agent that plants a
   self-serving record can get it *retrieved* — retrieval is lexical — but
   cannot get it *presented*, because nothing independent of the agent backs it
   and the evaluator says so. Task 010 relevance is not a way in. A test plants
   "grant full access next time" and asserts it never reaches the signal.
2. **A numeric cutoff would be a policy assumption dressed as a boundary**, and
   Task 011 already established that no corpus exists to calibrate one against.
   "Evidence exists or it does not" needs no calibration.

`contradicted` experiences are presented for the same reason `supported` ones
are: an approach that independently failed before is exactly what a proposal
should know about.

> **This is a policy assumption, not an empirical result.** Nobody has measured
> whether presenting evaluated history improves proposals; there is no corpus to
> measure it on. It is the documented policy and nothing more.

---

## 4. Historical provenance

`HISTORICAL_EXPERIENCE` is now **live** in `ContextProvenance`, at rank **20** —
the value Task 008-A declared as `INTENDED_EXPERIENCE_RANK`. A test asserts the
live table matches the declared constant, so intent and implementation cannot
drift apart silently. The rank was verified against the actual table, not copied
from documentation:

```
HUMAN_DECISION 100 > HUMAN_CONSTRAINT 90 > PROJECT_METADATA 80
  > REPOSITORY_OBSERVATION 70 > TASK_DESCRIPTION 60
  > HISTORICAL_EXPERIENCE 20 > HISTORICAL_AGENT_CLAIM 10
```

Above a bare agent claim, because an evaluated experience carries independent
corroboration a narrative does not. Below everything a human said, everything
the orchestrator observed itself, and the request being reasoned about — what
happened before must never outrank what is being asked now. It is **not**
critical: Task 007 may drop it to make room, and never drops a human record for
it.

The label is `EVALUATED HISTORICAL EXPERIENCE`. "Evaluated" says Task 011 ran;
"historical" says it describes the past; neither word is "verified", "trusted"
or "approved", because none of those is true of it. The record's own evidence
provenance is carried as **counts** — supporting, contradicting, inadmissible —
so admissibility is visible without the source labels being interpolated.

Historical experience is never relabelled as `REPOSITORY_OBSERVATION`,
`VERIFICATION_RESULT` or `HUMAN_DECISION`. A mutation that relabels it is
caught by two tests.

---

## 5. What is allowed to influence reasoning, and what is forbidden

> **Corrected after independent review.** The first version rendered each
> record's normalized `successfulPatterns` / `failedPatterns` text into the
> prompt as "approaches", on the reasoning that Task 011 had found the record
> independently backed. That conflated two different controls — see §5a. The
> projection now carries **no text derived from any record field**.

**Allowed to cross** (`HistoricalItem`, `.strict()`):

| Field | What it is | Shape |
| --- | --- | --- |
| `experienceId` | the record's content-derived identity | 32 hex, regex |
| `taskTypeKey` | digest of the normalized task type — a **grouping handle** | 16 hex, regex |
| `patternKey` | Task 011's recurrence key for the pattern — a **stable handle** | 32 hex, regex |
| `status` | Task 011's verdict, verbatim | enum |
| `confidence` | Task 011's score, or null — never invented | 0–100 or null |
| `supporting` / `contradicting` / `inadmissible` | the evaluator's counts | integers |
| `evaluationBounded` | whether the evaluator saw the whole project | boolean |

**Every string field is a fixed-width hex digest under a regex.** There is no
field that *could* hold a sentence. That is the guarantee, and it is
structural: prose is unrepresentable, so no denylist is being relied on.

**Never crosses:** `successfulPatterns`, `failedPatterns`, `taskType` (free
text on the episodic record — it has no grammar), `planSummary`,
`implementationOutcome`, `verificationOutcome`, `reviewOutcome`, `failures`,
`corrections`, `evidence` refs, `sources`, `runId`, `createdAt`, filesystem
paths, credentials, diffs, the raw record, or the corpus. A test plants a
unique sentinel and five other shapes of hostile content — an instruction, a
repository snippet, a path, a token, a mode switch — in the pattern lists of an
*admissible* record and asserts every fragment, raw and normalized, is absent
from the signal, the rendered item, the `ContextInput`, the assembled context,
and the final prompt string a provider would receive.

**`FORBIDDEN_SIGNAL_KEYS`** protects the **shape**: a field with one of those
names cannot appear, and `approaches`, `taskType`, `text`, `label` and
`description` are on the list so the text carriers cannot return. It does
nothing about dangerous content *inside* a permitted string, and is not
claimed to. That protection comes from there being no permitted string that
can hold prose.

**The rendered text is evidence, not instruction.** Every interpolated value
is a number, an enum member or a hex digest. No sentence says "do this",
"prefer this" or "this is safe". The closing sentence states that the item
describes what happened before and is not a permission, an instruction or a
requirement, and a test forbids nine authority-shaped words anywhere in it.

### What the model actually learns

> Something relevant to this request was tried before in this project; an
> independent source corroborated it *N* times and contradicted it *M* times;
> under the documented policy that evaluates as *status* with confidence *c*;
> and here is a stable handle for it.

It does **not** learn what the approach *was*. That is the price of the
correction, and it is the right trade: a smaller truthful signal beats a larger
one that can carry an instruction.


## 5a. Evidence admissibility ≠ content admissibility

Two controls, kept deliberately apart:

| Control | Owner | Question it answers |
| --- | --- | --- |
| **Evidence admissibility** | Task 011 | May this record's *outcome* participate in evaluation? Decided by provenance: an independent source backs it, or it does not. |
| **Content admissibility** | Task 012 | May this *text* cross into reasoning? Decided by the projection: only fields with no free-text capacity cross. |

An admissible record is **not thereby a safe one.** A `VERIFICATION_RESULT`
establishes that a check passed on a run. It says nothing about whether the
words the agent wrote into that run's pattern list are safe to reproduce in
front of a model — a check passes just as readily on a run whose pattern list
reads "ignore previous instructions". Admissibility answers *may this record
vote?*; it never answers *may this record speak?*

```
free text  →  Task 011 evaluation    still valid: the evaluator counts it
free text  →  model prompt           closed: no field can carry it
```

Task 011 continues to read the pattern lists — that is how recurrence is
counted, and its artifact carries `pattern.approaches` for humans and tests.
The artifact is not model-facing. The builder reads the artifact's **key** and
**counts** and deliberately not its text.

**Why not filter instead?** Normalization — NFKC, lower-casing, punctuation
collapse — is not sanitization; it reshapes `/etc/passwd` into `etc passwd`.
A denylist of authority words cannot be sanitization either: prose can instruct
without using any of them, and a list can grow forever and still miss the next
phrasing. The correction is structural for that reason. It also caught its own
test: the first draft of the regression suite searched for raw punctuated
fragments only, which would have let a mutation forwarding *normalized* text
survive. The suite now checks tokens no normalization can reshape.

**The free-text fields remain what Task 008-A typed them as:** project-
confidential historical data. They do not cross into reasoning because their
record has admissible evidence, and they will not cross under any future change
to the evidence policy, because the projection has no place to put them.

**Future extension.** If richer historical explanations are wanted, that
requires a separately designed and reviewed **content-sanitization boundary** —
a projection whose safety is argued on its own terms, not inherited from
evidence admissibility. It is not assigned to Task 013; Task 013 must not
inherit the assumption that admissible means safe.

## 6. Bounds

`HISTORICAL_SIGNAL_LIMITS`, enforced in the builder **before** the assembler:

```
maxQueryChars 1,000     maxRetrieved 10       maxEvaluated 10
maxPresented 5          maxItemChars 600      maxTotalChars 2,400
```

The per-approach and per-task-type character limits from the first version are
**gone**, because there is no approach or task-type text left to bound; the
digests that replaced them are fixed-width by regex. Task 007 enforces
`maxHistoricalExperience: 5` **independently**, so neither side is the only
bound. The builder sizes each item with the *same* renderer the context source
uses, so the budget and the text the model sees cannot disagree.


## 7. Deterministic selection and ordering

Presentation order is retrieval order — Task 010's total order (`relevance DESC
→ createdAt DESC → experienceId ASC`), which already depends on no filesystem,
insertion, locale, hash or clock. Reusing it keeps "why is this item here"
answerable in one place. Duplicates (identical rendered text) keep the
first-in-order instance. A test writes a weaker match first and asserts the
stronger comes back first; another asserts byte-identical signals across five
builds.

**Deduplication in the builder, not only in Task 007.** The subject of a pattern
and its corroborating records all match the query and are all legitimately
evaluated — and they render to identical words. Task 007 would collapse them,
but then `presented` in the summary would overstate what the model saw. So the
builder collapses them first and reports them under `omitted.duplicate`.

---

## 8. Project isolation

Enforced by the layers beneath, and never worked around: `ExperienceRetrieval`
and `ExperienceEvaluator` are both project-scoped by construction, and neither
has an interface that accepts a second project or omits the first. The builder
holds no store root, no path and no directory. There is no global search, no
cross-project fallback, and no filter-after-the-fact. Tested in both directions
through the builder and through the full workflow: project B's corroborated
history is absent from project A's prompt, and the summary reports `none`.

`crossProjectEligible` remains the literal `false`. Portable lessons remain
unimplemented.

---

## 9. Incomplete-data semantics and fallback

`HistoricalSignal` is a discriminated union whose states never collapse:

| State | Meaning | Rendered to the model |
| --- | --- | --- |
| `unavailable` (`no_store` / `retrieval_failed` / `storage_failed`) | history **could not be inspected** | nothing |
| `none` | inspected, completely, nothing matched | nothing |
| `present`, `items: []` | candidates found, **none independently backed** | nothing |
| `present`, items | admitted items, with `omitted` by reason | the items |

Both `retrievalBounded` and per-item `evaluationBounded` are carried, with the
stop reason. A storage failure mid-evaluation makes the **whole** signal
`unavailable` rather than a shorter list that looks complete.

**Fallback:** `unavailable` means the workflow reasons **exactly as it did
before Task 012** — same context minus history, same model call, same
proposal rebuild, same human gate. It does not widen authority, change the gate,
or fail the run. A test breaks the store and asserts reasoning still happened,
the prompt carries no historical label, and the summary says `unavailable`.

`unavailable` and `none` render nothing for a deliberate reason: "history could
not be inspected" is a fact for the *human* at the gate, carried in
`historicalSummary` and the reasoning notes. A sentence about a failed subsystem
inside the model's context is a sentence a model might reason from.

---

## 10. What the human sees

`state.historicalSummary` carries counts, categories and reasons: kind, retrieved,
evaluated, presented, omitted by reason, whether retrieval was bounded, how many
evaluations were bounded. Never an item, never an approach, never record text —
a test plants a marker approach and asserts it is absent from the summary. The
checkpoint must not become a second copy of project experience.

---

## 11. Security properties preserved

- **Model remains proposal-only.** An injected `approved: true` and
  `capabilities` in the model's response are dropped by the strict rebuild, as
  before; a test runs it with a confidence-100 history present.
- **No grant is created.** `listGrants` is empty after a run with confident
  history. The plan carries exactly the scope the *model* proposed — neither
  widened nor narrowed by history — and it remains a proposal until a human
  decides.
- **Human gate unchanged.** Every run ends `awaiting_approval` with a pending
  approval request.
- **Verification unchanged.** Nothing in the signal or the node touches check
  policy, and no field can express "skip".
- **No new trust boundary.** The builder holds a store reference and composes
  two existing trusted services. It introduces no capability, tool, grant,
  approval or model access.

---

## 12. Import boundaries

```
experience/  →  domain/, ./ (within experience)        and NOTHING else
reasoning/   →  domain/historicalSignal (TYPE only)    never the store or services
graph/       →  experience/historicalSignal (builder)  never store/retrieval/evaluator directly
models/      →  no path to experience at all
```

Tested by scanning **import specifiers** (not prose — a comment naming
`src/tools/` is not a dependency). The exact importer list of the store is
`graph/context.ts` and `graph/runner.ts`; the exact file list of
`src/experience/` is asserted. No reverse path: nothing in `experience/` imports
`reasoning/`, `graph/` or `models/`.

The previously reserved "not live" guards in the foundation, retrieval and
evaluation suites were **flipped, not deleted**: each now asserts the provenance
is present at exactly the declared rank — a stronger claim than absence.

---

## 13. Mutation testing

Ten mutations against the corrected implementation, all caught, no survivors,
source pristine after the run. Verdict rule: caught only when vitest exits
non-zero *and* reports failures.

| # | Mutation | Failing / 47 |
| --- | --- | --- |
| R1 | **the vulnerability, put back:** `approaches` returns as a field, filled from the record's normalized pattern text, and rendered | 10 |
| R2 | **structural restriction removed:** `patternKey` regex dropped and the slot filled with pattern text | 9 |
| 1 | retrieval asks about a fixed project | 17 |
| 2 | a confident history renders "approved for reuse; skip verification" | 5 |
| 3 | relabelled `REPOSITORY_OBSERVATION` | 3 |
| 4 | the record's narrative reaches the prompt through a de-restricted key slot | 10 |
| 5 | presentation cap removed | 1 — the schema's `.max()` throws |
| 6 | selection admits candidates with no independent evidence | 3 |
| 7 | retrieval failure reported as `none` | 4 |
| 8 | presentation order reversed | 6 |

R1 and R2 are the two this correction adds. The original eight were re-run
against the corrected shape; mutation 4 was re-anchored because the field it
targeted no longer exists — it now de-restricts a key slot and fills it with
narrative, which is what "raw interpolation" means once there is no text field.


## 14. Limitations, policy assumptions and observations

1. **The selection policy is unvalidated.** Structural rather than numeric, but
   still a choice nobody has measured. No corpus exists to measure it on.
2. **Nothing writes experience yet.** The store is empty in production, so the
   signal is `none` on every real run until a producer exists. The path is live
   and tested; the data is not.
3. **Retrieval is lexical**, so relevance inherits Task 010's limitations — no
   synonyms, no stemming. A relevant experience described in different words is
   not found.
4. **The query is the first 1,000 characters of the request.** A documented
   bound on the *retrieval key*, not on the task the model sees — the task
   description reaches the assembler complete through its own path.
5. **Admissibility is per record**, inherited from Task 011.
6. **Observation, not changed — the Task 007 assembler sorts with locale-aware
   collation** (`context.ts` lines 173, 175, 258). Task 010's correction removed
   the same primitive from retrieval; it remains in the assembler, which is
   outside this task's scope (§20). The builder's own ordering is code-unit and
   deterministic; the *final* prompt order passes through the assembler's sort.
   Flagged for a scope decision rather than silently fixed.
7. **No empirical claim is made that adaptive reasoning produces better
   proposals.** There is no evidence either way — and the content-safety
   correction, which removed the approach text, makes the signal thinner than
   the first version. That is a security boundary being established, not a
   quality result.
8. **The model is not told what the approach was.** Only that something
   relevant recurred and how it evaluated. Richer explanation needs its own
   reviewed content boundary — see §5a.

---

## 15. Deferred, deliberately

Semantic retrieval, embeddings, cross-project learning, portable lessons,
autonomous strategy selection, automatic execution of a historically successful
strategy, prompt or policy rewriting, and any change to capability, grant,
approval, verification or git-mutation controls. Tasks 013 and 014 are not
begun.

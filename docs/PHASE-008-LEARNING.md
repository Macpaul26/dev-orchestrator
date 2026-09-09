# Learning Foundation — Architectural Direction

**Status:** ARCHITECTURE ONLY. **No learning subsystem exists.** Not approved —
approval is the Project Director's decision.

> **Nothing in this document is implemented as behaviour.** There is no
> experience store, no retrieval, no confidence evaluator, and nothing in the
> workflow writes a record. `src/domain/experience.ts` declares the shape; a
> test asserts no production code imports it.
>
> **This document has been corrected.** Two claims in its first version were
> false — that the absence of a `content` field prevented cross-project leakage,
> and that confidence was derived rather than asserted. Both are now enforced by
> the schema instead of by prose. See §4 and §7.

The reason to decide the shape now, while Task 008 is being built, is that the
awkward questions — what may be stored, what may cross a project boundary, what
a lesson is allowed to influence — are cheap to answer before an engine exists
and expensive afterwards.

---

## 1. The invariant everything else serves

```
LEARNING  ──▶  REASONING
LEARNING  ──✗  AUTHORITY
```

A lesson drawn from a hundred verified runs is still, at the moment it reaches a
decision, **text that arrived from storage**. It can inform a proposal. It can
never approve one, grant a capability, widen a scope, lower a risk
classification, or disable a check.

This is enforced structurally, exactly as the reasoning boundary is: neither
`EpisodicExperience` nor `PortableLesson` declares an authority-shaped field,
`.strict()` refuses any that appears, and `FORBIDDEN_EXPERIENCE_KEYS` is
asserted against the parsed shape. A record carrying `approved`,
`capabilities`, `grant`, `allowedScope`, `risk` or `policy` is **rejected in
full** — tested against both types.

---

## 2. The intended progression

```
PROJECT EXPERIENCE  →  VERIFIED OUTCOME  →  STRUCTURED EXPERIENCE
       →  LEARNING MEMORY  →  RELEVANT RETRIEVAL
       →  CONTROLLED REASONING CONTEXT  →  BETTER FUTURE PLANS
```

Every arrow after the second is a future task. The first two already exist: the
orchestrator independently verifies outcomes today, which is precisely what
makes learning from them worth doing at all.

---

## 3. A claim is not an outcome

The distinction this system already implements, named so experience can record
which rung a statement actually reached:

| Source | What it establishes |
| --- | --- |
| `AGENT_CLAIM` | The agent said so. Evidence of nothing. |
| `PROCESS_OBSERVATION` | A program returned an exit code. A fact about a program. |
| `REPOSITORY_OBSERVATION` | We inspected the repository ourselves. |
| `VERIFICATION_RESULT` | A configured check actually ran and returned. |
| `REVIEW_FINDING` | The deterministic review layer produced it. |
| `HUMAN_DECISION` | A person decided. The only source that authorises. |

An agent's self-reported success **must never automatically become a trusted
learning signal**. `INDEPENDENT_SOURCES` deliberately excludes both
`AGENT_CLAIM` and `PROCESS_OBSERVATION` — an exit code says a program finished,
not that a repository is in the intended state.

---

## 4. Confidence vocabulary — and what this foundation does NOT decide

Four ordinal levels, not a score:

| Level | Requires |
| --- | --- |
| `low` | an agent said so, nothing corroborates it |
| `medium` | the OS and/or the repository corroborate it |
| `high` | a check ran, or a human reviewed it |
| `very_high` | independently repeated — **not reachable from this module** |

Deliberately **not a float**. A number invites a scoring formula, and a formula
invented without data dresses a guess as a measurement.

### Corrected: confidence is not stored, and recurrence is not caller-supplied

The first version of this foundation claimed "confidence is derived, never
invented" while `ExperienceRecord` accepted `confidence` and
`independentlyVerified` as writable fields. A caller could store
`sources: ["AGENT_CLAIM"]` beside `confidence: "very_high"` and the schema would
accept it. The claim was false.

Both fields are now **absent from the schema**, and `.strict()` rejects them.
Trust is read from `sources` by `provisionalConfidence` and
`isIndependentlyVerified`, so a record cannot assert a level its own evidence
contradicts. The dangerous state is unrepresentable rather than discouraged.

The helper also no longer accepts an `independentConfirmations` integer. Taking
that number from the caller let `confidenceFrom(["VERIFICATION_RESULT"], 3)`
claim recurrence nobody had demonstrated — a caller-asserted trust value wearing
the costume of a derivation.

`provisionalConfidence` therefore **tops out at `high`** and is explicitly **not
a security boundary**. Reaching `very_high` requires counting independent
confirmations across attributable records, which needs a store that does not
exist. **Task 011 owns the authoritative derivation.**

### The "three confirmations" threshold is an assumption, not a finding

`PROVISIONAL_THRESHOLDS.confirmationsForVeryHigh = 3` is recorded as
**UNVALIDATED**. No experience dataset exists, so nobody knows whether three
confirmations is sufficient evidence for anything. Task 011 must justify,
validate or replace it against real data — and **may not mark it settled merely
because the code compiles and the tests pass.**

## 5. A single observation is not a rule

`LessonStatus` lets a lesson be **held without being believed**, and **retired
without being deleted**:

`candidate` → `supported` → and, when evidence turns, `uncertain`,
`contradicted`, or `deprecated`.

Everything defaults to `candidate`. Future evaluation should weigh observation
count, verification results, review outcomes, recurrence, contradictions,
recency and applicability — none of which is implemented here.

---

## 6. Three memory layers

Named now because they have different retention, different privacy exposure and
different retrieval rules; conflating them later would be expensive.

- **Episodic** — what happened in one run. Project-scoped, most sensitive, the
  default.
- **Semantic** — what repeats across runs. The **only** layer that could ever
  reasonably cross a project boundary, and then only sanitised.
- **Procedural** — which sequences of steps have worked for a class of task.

---

## 7. Cross-project learning, and its actual boundary

### The claim this section used to make was wrong

It said cross-project leakage was prevented structurally "because
`ExperienceRecord` has no field for content". That was false. `planSummary`,
`implementationOutcome`, `failures`, `successfulPatterns` and the rest are
**free text written from a real run** — and free text *is* content. It can carry
a diff, a path, an error message, a model response or a pasted secret just as
effectively as a field named `content` would. The absence of that **name**
prevented nothing.

### What is actually true now

The foundation splits into two types with different rules.

**`EpisodicExperience` — project-scoped, and NOT safe to share.**
It carries bounded free-text summaries from a real run, and the type says so:
`scope` is the literal `"project"` and there is no other permitted value. No
later code can mark an episodic record shareable, because the field cannot hold
another value. It should be treated as project-confidential.

**`PortableLesson` — the only shape aimed at crossing a boundary.**
No summaries, no failure lists, no evidence text. Only a short `statement` under
a **character allowlist** (letters, digits, spaces, light sentence punctuation),
a kebab-case `taskType`, and support/contradiction counts. Paths, diff hunks,
JSON, `KEY=value` assignments, tokens, URLs, backticks and newlines are
**unrepresentable**, not merely discouraged.

That is a genuine restriction and not a sanitiser: a determined caller could
still write a secret in plain English. Which is why:

**`crossProjectEligible` is the literal `false`.** There is no value meaning
"yes". Nothing written before the sanitisation design exists can promote a
lesson across a project boundary — not by mistake, and not on purpose. Enabling
it requires changing that line, which is a visible, reviewable act.

> **Corrected during Task 010.** This paragraph used to assign that act to Task
> 010. It does not belong there: Task 010 is project-scoped retrieval, and its
> brief forbids cross-project learning, portable-lesson generation and
> sanitisation outright. No task currently owns cross-project eligibility, which
> is the accurate position — the sanitisation design does not exist, and naming
> a task that is not doing it would read as authorisation to a later reader.

Evidence remains a **reference**, and `ref` is now constrained to an identifier
shape — no spaces, no newlines, no prose punctuation — so it cannot become a
smuggling channel for the payload it points at.

### Honest summary

| Guaranteed today | Deferred to Tasks 009–011 |
| --- | --- |
| Episodic records cannot claim wider scope | Deciding what a sanitised lesson may say |
| Portable lessons cannot carry paths, diffs, tokens or assignments | Validating that prose lessons are leak-free |
| Nothing can be marked cross-project eligible | Cross-project retrieval itself |
| Evidence is referenced, never copied | Eligibility evaluation |

## 8. Experience reaches reasoning only through Task 007

```
Historical Experience → Retrieval → Bounded/Validated Context
   → Task 007 Assembler → Prompt → Reasoning Model
```

Never:

```
Experience Database → raw prompt interpolation → Model
```

That means experience inherits, without exception: provenance labelling, the
credential-shape refusal, deterministic ordering, deduplication, the context
bounds, the transport limit and the fence.

`ContextProvenance` has **not** gained a `HISTORICAL_EXPERIENCE` class yet, and
that omission is deliberate — a provenance in the live authority table that no
record ever uses is a claim the system does not honour. The intended value and
rank are declared in `src/domain/experience.ts`
(`INTENDED_EXPERIENCE_RANK = 20`): above a bare agent claim, below everything a
human decided or the orchestrator observed itself. A test asserts it is not yet
live and that the existing six classes and their order are unchanged.

---

## 9. Separation of responsibilities

```
Repository Evidence  = observe
Verification         = test
Review               = evaluate
Experience System    = remember
Learning System      = identify reusable lessons
Reasoning Model      = propose
Human                = decide
```

Task 008's evidence service is a **foundational observation source** for future
learning. It is not, and must not become, responsible for learning.

---

## 10. Self-improvement stays controlled

```
Experience → Candidate Lesson → Evidence Evaluation
  → Candidate Improvement → HUMAN APPROVAL → new strategy/prompt/policy
```

Explicitly prohibited:

```
Experience → AI decides it is better → AI rewrites itself
  → AI grants itself new powers
```

---

## 11. Roadmap

| Task | Subject | State |
| --- | --- | --- |
| 008 | Controlled Repository Evidence | implemented |
| 008-A | Learning foundation (this document + types) | architecture only |
| 009 | Experience / Learning Memory | implemented |
| 010 | Experience Retrieval | implemented |
| 011 | Learning Evaluation + Confidence | not started |
| 012 | Adaptive Reasoning / Strategy Improvement | not started |
| 013 | Controlled Self-Improvement | not started |
| 014 | End-to-End Autonomous Development Loop | not started |

Numbering may shift; the progression must not. Each step is separately scoped
and separately approved.

---

## 12. Explicitly NOT implemented

No autonomous self-modification, prompt rewriting, policy rewriting, capability
granting or deployment. No unrestricted persistent memory, vector database,
embeddings, autonomous learning loop, reinforcement learning, model replacement,
Git mutation, GitHub writes or network access.

The capability matrix is unchanged: `git.mutate`, `process.execute` and
`network.access` remain NOT IMPLEMENTED. A test asserts it.

---

## 13. Limitations — classified

### Solved by this correction

1. **Free text was being described as if it were not content.** Episodic records
   are now typed as project-scoped with a literal `scope`, and a separate
   `PortableLesson` type is structurally unable to carry paths, diffs, JSON,
   assignments, tokens, URLs or newlines.
2. **Confidence could be asserted against its own evidence.** `confidence` and
   `independentlyVerified` are no longer storable; they are read from `sources`.
3. **Recurrence was caller-supplied.** The `independentConfirmations` parameter
   is gone; `provisionalConfidence` tops out at `high`.
4. **Nothing can be marked cross-project eligible.** `crossProjectEligible` is
   the literal `false`.
5. **Evidence refs could hold prose.** `ref` is now constrained to an identifier
   shape.

### Intentionally deferred — and these are acceptance requirements, not excuses

A future task **may not mark any of these solved merely because the code
compiles and the tests pass.** Each needs evidence or a design, not an
implementation that runs.

1. **Empirical validation of confidence thresholds** — Task 011. The value 3 is
   an assumption recorded as `UNVALIDATED`. It needs justification against real
   experience data, or replacement.
2. **Semantic sanitisation and cross-project eligibility** — unassigned. The
   character allowlist prevents structured payloads; it does not prevent a
   secret written in plain English. Deciding what a sanitised lesson may say,
   and who certifies it, is genuinely hard and is not designed.
3. **Lesson-quality and generalisation evaluation** — Task 011. A well-evidenced
   lesson can still be the wrong generalisation, and nothing here would notice.
4. **Contradiction resolution** — Task 011. `contradicted` and `uncertain` exist
   as states; no policy decides when a lesson enters them or what happens next.
5. **Retrieval relevance** — Task 010. Nothing decides which past experience
   applies to a new task, and a plausible-but-irrelevant lesson is worse than
   none.
6. **Procedural-strategy validation** — Task 012. That a sequence of steps
   worked before is not evidence it will work again.

### Standing limitations of the foundation itself

7. **Nothing here is behaviour.** Every claim is about a shape. The tests raise
   the cost of changing it silently; they do not make it impossible.
8. **The examples in this document are illustrative.** No project outcomes,
   patterns, confidence values or histories have been invented as though real.

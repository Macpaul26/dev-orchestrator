# Learning Foundation — Architectural Direction

**Status:** ARCHITECTURE ONLY. **No learning subsystem exists.** Not approved —
approval is the Project Director's decision.

> **Nothing in this document is implemented as behaviour.** There is no
> experience store, no retrieval, no confidence engine, and nothing in the
> workflow writes an experience record. `src/domain/experience.ts` declares the
> shape; a test asserts no production code imports it.

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

This is enforced structurally, exactly as the reasoning boundary is:
`ExperienceRecord` declares no authority-shaped field, `.strict()` refuses any
that appears, and `FORBIDDEN_EXPERIENCE_KEYS` is asserted against the parsed
shape. A record carrying `approved`, `capabilities`, `grant`, `allowedScope`,
`risk` or `policy` is **rejected in full** — tested.

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

## 4. Confidence is derived from evidence, never invented

Four ordinal levels, not a score:

| Level | Requires |
| --- | --- |
| `low` | an agent said so, nothing corroborates it |
| `medium` | the OS and/or the repository corroborate it |
| `high` | a check ran, or a human reviewed it |
| `very_high` | independently repeated across ≥3 separate runs |

Deliberately **not a float**. A number invites a scoring formula, and a formula
invented without data dresses a guess as a measurement. These levels state which
*kinds* of evidence exist, which is a fact.

`very_high` additionally requires recurrence, and recurrence is a **count of
real records** the caller supplies — not something `confidenceFrom` can conjure.
The default is 1: this run, once. Repetition by the same agent never raises
confidence; a hundred emphatic claims stay `low`.

---

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

## 7. Cross-project learning, and its hard boundary

The eventual system should accumulate general engineering experience across
projects. It must **never** leak secrets, credentials, file contents, private
data or protected project information between them.

The structural protection is already in the record: `ExperienceRecord` has **no
field for content**. Evidence is stored as an `EvidenceRef` — a source and an
identifier, never a payload. There is nowhere to put a diff, a prompt, a model
response, or a file, and a record attempting to carry one is rejected. Tested.

Cross-project retrieval, when it arrives, operates on the semantic layer over
explicitly sanitised material — not on episodic records.

---

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
| 009 | Experience / Learning Memory | not started |
| 010 | Experience Retrieval | not started |
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

## 13. Limitations

1. **Nothing here is behaviour.** Every claim in this document is about a shape,
   not a running system, and a shape can be changed by whoever implements
   Task 009. The tests raise the cost of changing it silently; they do not make
   it impossible.
2. **The confidence ladder is a design, not a validated model.** Whether
   "three independent confirmations" is the right threshold is unknown, because
   no data exists yet.
3. **Sanitisation for cross-project material is not designed.** The record has
   no content field, which prevents the obvious leak; deciding what a *sanitised
   semantic lesson* may say is Task 010's problem and is genuinely hard.
4. **Lesson quality is unaddressed.** A well-evidenced lesson can still be the
   wrong generalisation, and nothing here would notice.
5. **The examples in this document are illustrative.** No project outcomes,
   patterns, confidence values or historical experiences have been invented as
   though they were real.

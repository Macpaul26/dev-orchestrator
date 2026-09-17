# Task 013 — Controlled Self-Improvement: Strategy Adaptation

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

> **LEARNING → REASONING. LEARNING ↛ AUTHORITY.**
> **A posture is a category of evidence, not an instruction.**
> **A historical success is evidence about the past; it is not permission for the future.**

Task 012 let evaluated history *inform* reasoning, one item at a time. Task 013
aggregates those items into one bounded, structured statement — a **posture** —
and feeds it to reasoning through the same door. It is the first thing in the
learning layer that looks like advice, which is exactly why every property
below is enforced structurally rather than asked for.

---

## 1. Objective

Derive a bounded strategy proposal from already-evaluated historical experience,
as **input to reasoning**, without letting it decide, approve, grant, widen,
lower, skip, persist or execute anything.

It answers: *"Taken together, what does this project's independently-supported
history look like for a task like this?"* It never answers: *"Use this."*

---

## 2. Architecture and data flow

```
HistoricalSignal                      Task 012 — already safe: digests, enums, counts
      │
      ▼
deriveStrategy(signal)                src/experience/strategy.ts — a PURE FUNCTION
      │   no store · no retrieval · no evaluator · no filesystem · no clock · no model
      ▼
StrategyProposal                      unavailable | none | insufficient | proposal
      │
      ▼
historicalStrategy(proposal, render)  src/reasoning/contextSources.ts — type-only import
      │   → one ContextInput, provenance HISTORICAL_STRATEGY
      ▼
assembleContext([...everything else, ...history, ...strategy])   Task 007, the SAME assembler
      ▼
buildUserPrompt → ReasoningModel → proposal → strict rebuild → human gate      unchanged
```

**The whole safety case is the first arrow.** The strategy layer's only input
is the Task 012 signal, and its module imports exactly two things — the signal
type and its own domain — asserted by a test that reads the import specifiers.
Every hard property this task must hold (no historical text reaches the model,
no other project's history is used, no inadmissible evidence counts) is a
property of the **input**, established and tested in Tasks 009–012. A function
that cannot reach past its input cannot violate them. Task 013 adds a summary of
evidence that already crossed a boundary; it adds no boundary of its own.

---

## 3. Strategy representation

```ts
StrategyProposal =
  | { kind: "unavailable", reason }                          history could not be inspected
  | { kind: "none", retrievalBounded }                        inspected; nothing relevant
  | { kind: "insufficient", unassessed, retrievalBounded }    relevant, but nothing independently assessed
  | { kind: "proposal",
      posture: "established" | "cautionary" | "contested" | "inconclusive",
      patterns: HistoricalItem[≤5],      Task 012's items, reused UNCHANGED
      supported, contradicted, uncertain,          pattern counts by Task 011 status
      supportingVotes, contradictingVotes,         independent-record totals
      bounded, retrievalStop, evaluationsBounded,  never hidden
      omitted }                                    carried forward from the signal
```

All `.strict()`. Every string is an enum member or, inside a pattern, a
fixed-width hex digest under a regex. **There is no field that could hold a
sentence.** `FORBIDDEN_STRATEGY_KEYS` additionally pins the shape against
authority words (`approved`, `trusted`, `allowed`, `grant`, `capabilities`,
`scope`, `risk`, `policy`, `skipVerification`, `execute`, `override`,
`mustUse`, …) and text carriers (`approaches`, `text`, `description`, `label`,
`strategyText`, …) — shape protection only, as with the signal; content safety
comes from there being no permitted string that can hold prose.

The posture vocabulary was chosen so that **no member reads as a verb**.

---

## 4. Derivation policy

```
contradicted > 0 and supported > 0   →  contested
contradicted > 0                     →  cautionary
supported > 0                        →  established
otherwise (uncertain only)           →  inconclusive
```

**Contradiction is checked first.** Four independently supported patterns and
one independently contradicted one is `contested`, not `established` — a
repeated success can never erase an independently supported failure, and a test
proves the ordering with exactly that fixture. Each pattern's status and
confidence are Task 011's, carried verbatim; a test greps the source for any
arithmetic over `confidence` and any `Math.floor` and finds none. There is no
second confidence formula and no threshold.

> **Policy assumption, not empirical result.** Nobody has measured whether a
> posture improves proposals. No corpus exists to measure it on.

---

## 5. Evidence requirements and contradiction handling

A proposal exists only when at least one pattern was **independently assessed**
(Task 011 confidence `assessed`). Relevant-but-unassessed history yields
`insufficient`, which renders nothing to the model and is reported to the human
— the same "no evidence is not a zero" discipline as Tasks 011 and 012.

Contradiction is **visible at three levels**: as the `contested`/`cautionary`
posture, as the `contradicted` pattern count and `contradictingVotes` total, and
in ordering — contradicted patterns sort **first**, so no bound can push the
thing a proposal most needs to surface past the cap.

---

## 6. Bounds

`STRATEGY_LIMITS`: `maxPatterns 5` (equal to Task 012's presentation cap, and
the signal schema refuses more before the strategy is ever called) and
`maxRenderedChars 900`. A rendering over its bound is **dropped, never
shortened** — the assembler would refuse an oversized record, and a strategy is
not critical context, so absence is the correct failure direction. Task 007
enforces `maxHistoricalStrategy: 1` independently.

---

## 7. Deterministic ordering

Patterns are ordered `status precedence (contradicted first) → confidence DESC
→ patternKey ASC` by an exported comparator, `comparePatterns`, tested directly
against shuffled and reversed input with a proof that no two distinct patterns
compare equal. A byte-identical proposal is asserted for a signal supplied in
reverse order. The source contains no locale collation, no clock and no random
source — asserted by scan.

---

## 8. Project isolation

Inherited and re-proven. `deriveStrategy` takes a signal, not a project id —
`deriveStrategy.length === 1` — so there is nothing to widen: the project
boundary was closed by Task 012 before the function was called. Tested in both
directions through the builder and through the full workflow.
`crossProjectEligible` remains the literal `false`.

---

## 9. Provenance

`HISTORICAL_STRATEGY` is a new `ContextProvenance` at rank **15**, label
`DERIVED HISTORICAL STRATEGY`, cap 1, not critical.

**Why 15:** a summary of evidence cannot outrank the evidence. If the items
(rank 20) and the posture ever disagreed, the items are the primary record. It
sits above `HISTORICAL_AGENT_CLAIM` (10) because trusted code derived it from
independently admissible evidence, which a bare agent narrative is not. It is
below every human, observed and current source, and the assembler may drop it to
make room and never drops a human record for it. A mutation relabelling it
`HUMAN_CONSTRAINT` is caught by four tests.

Full order: `HUMAN_DECISION 100 > HUMAN_CONSTRAINT 90 > PROJECT_METADATA 80 >
REPOSITORY_OBSERVATION 70 > TASK_DESCRIPTION 60 > HISTORICAL_EXPERIENCE 20 >
HISTORICAL_STRATEGY 15 > HISTORICAL_AGENT_CLAIM 10`.

---

## 10. Model boundary and human authority

**One context path.** The plan node adds one spread to the existing
`assembleContext([...])` call. A test asserts the `TASK_DESCRIPTION` record is
byte-equal to the request — no strategy text appended to it — and that exactly
one model call was made. A mutation that appends the strategy to the task
description is caught.

**The gate is a graph edge, not a node decision.** Found while mutation-testing:
`.addEdge("plan", "approve_plan")` in the workflow is **unconditional**, so the
plan node cannot route around human approval by returning a different phase —
the graph runs `approve_plan` next regardless. A mutation that tried was caught
only because it left an inconsistent `phase` in state; the bypass itself was
structurally impossible. This is a stronger property than the tests originally
credited, and it is now documented and pinned: every workflow test asserts the
pending approval is the **plan** gate, not merely a gate.

**Model output remains untrusted.** A response carrying `approved: true`,
`capabilities`, `grants`, `strategyOverride`, a `/` scope and
`skipVerification` is dropped by the strict rebuild. A second test sends *only*
`approved` and *only* `strategyOverride` — because a mixed payload is rejected
on its first unknown key and never exercises the path a relaxed schema would
admit — and asserts the plan gate is still reached with no grant and none of
those fields in the plan.

**What a proposal can influence:** the text a model reads, at rank 15.
**What it cannot influence:** approval, grants, capabilities, scope (a test
asserts the plan carries exactly the model's proposed scope), risk, check policy
(asserted non-null after an `established` run), project configuration
(constraints and decisions asserted unchanged), any other project, or execution.

---

## 11. Persistence policy

**None.** The proposal is workflow state describing what one run derived, and
nothing reads it back to decide anything. `strategySummary` holds the kind,
posture and counts — never the patterns — for the human at the gate. No decision
is written (a persisted posture would return as `HUMAN_DECISION` provenance on
the next run, which is the exact escalation this layer must never perform), no
constraint is written, no file is written. A mutation that persists the posture
as a decision is caught.

---

## 12. Incomplete-data semantics

`unavailable`, `none` and `insufficient` are distinct and none renders to the
model. `proposal.bounded` is true when retrieval was bounded **or any**
presented evaluation was bounded, and the rendering says so in capitals. A
mutation forcing `bounded: false` is caught.

---

## 13. Historical text safety

Inherited from Task 012 and **re-proven at this layer**. Hostile pattern text —
a unique sentinel, an instruction, a repository snippet, a path, a token, a mode
switch — is planted in *admissible* records, in both pattern lists. The proposal
is produced (`established` / `cautionary`) and every fragment, raw and
normalized, is absent from the proposal, the rendering, the `ContextInput`, the
assembled context, the final prompt string, and — through the full workflow —
the `ReasoningRequest` the model received and the human's summary.

Two mutations attack this from outside the strategy's own inputs: one forwards
free text from the store *inside the plan node* (where the store is in reach);
one relaxes the Task 012 item schema and builder to reintroduce `approaches`
and renders them. Both are caught at the model boundary by the workflow-level
test.

---

## 14. Mutation testing

Eighteen mutations. Each is **typechecked before its tests run** — a mutation
that does not compile proves nothing and is not counted. Verdict: caught only
when vitest exits non-zero *and* reports failures. Source diffed against backups
after each and at the end.

| # | Mutation | Result |
| --- | --- | --- |
| 1 | rendering says "approved and must be used; skip verification" | caught |
| 2 | node widens `allowedScope` to `/` on an established posture | caught |
| 3 | node issues an implementation grant on an established posture | caught |
| 4 | node returns `phase: "implement"` on an established posture | caught |
| 5 | node nulls `checkPolicy` on an established posture | caught |
| 6 | node builds the signal for a fixed other project | caught |
| 7 | `supported` checked before `contradicted` | caught |
| 8 | comparator returns 0 | caught |
| 9 | rendered-size bound removed | caught |
| 10 | `bounded` forced false | caught |
| 11 | schema admits `confidence` / `confidenceOverride` | caught |
| 12 | schema admits `trusted` / `verified` / `approved` | caught |
| 13 | node forwards store text into the rendering | caught |
| 14 | item schema + builder reintroduce `approaches`; strategy renders them | caught |
| 15 | emitted as `HUMAN_CONSTRAINT` | caught |
| 16 | strategy appended to the task description | caught |
| 17 | posture persisted via `saveDecision` | caught |
| 18 | proposal schema admits `approved`; node acts on it | caught |

Exact failing counts are in the completion report. **Three mutations survived
the first run and two did not compile**; all five were investigated rather than
re-labelled:

- **4 and 18 survived** because the workflow tests asserted only
  `status === "awaiting_approval"`, which a bypassed plan gate also satisfies
  at the *next* gate. The tests now assert the pending approval's `kind` is
  `plan` and the phase is `approve_plan`. Investigating this is what surfaced
  the unconditional graph edge in §10.
- **18 also survived** because the hostile payload mixed fields; the strict
  schema rejected it on the first unknown key before the mutated path ran. A
  minimal-payload test was added.
- **13 survived by fixture accident** — the newest record had an empty summary.
  The mutation now forwards a field every record carries.
- **8 and 9** were `noUnusedLocals` errors in the mutation text itself.

---

## 15. Limitations, unvalidated assumptions and deferrals

1. **The posture policy is unvalidated.** Structural, but unmeasured; no corpus
   exists. No claim is made that self-improvement has been demonstrated — this
   task establishes a mechanism and its boundary, not an outcome.
2. **The model is told a posture and pattern handles, not what the approaches
   were.** Inherited from the Task 012 correction. Richer explanation needs its
   own reviewed content-sanitization boundary, and is not assigned here.
3. **Nothing writes experience yet**, so every production run derives `none`.
4. **A single posture per context.** Multiple task types in one request
   collapse into one posture over all presented patterns; the pattern list
   carries the per-pattern detail.
5. **Observation, unchanged:** the Task 007 assembler's `localeCompare` sort
   (flagged in Task 012) still governs the final prompt order. The strategy's
   own ordering is code-unit.
6. **Deferred, deliberately:** autonomous execution, code or configuration
   changes, cross-project learning, embeddings, model-generated policy,
   automatic approval or grants, any new shell, filesystem or network
   authority. Task 014 is not begun.

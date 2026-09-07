# Task 007 — Controlled Reasoning Context

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

Task 006 made model *output* untrusted and bounded. Task 007 does the same work
on the *input*.

> **Giving the model more information does not give it more authority. The
> context assembler is an information boundary, not an authority boundary.**

---

## 1. Objective

The reasoning model previously received four loose fields — a request, a project
name, a list of observation strings, a list of constraint strings — flattened
into prose. That shape had two problems:

1. **It destroyed provenance.** A human decision and a sentence an implementation
   agent once wrote about itself arrived looking identical.
2. **It had no bounds of its own.** Nothing stopped a project with a long history
   from growing the prompt without limit.

Task 007 replaces it with a dedicated assembler producing typed, labelled,
bounded, deterministically ordered records.

---

## 2. Architecture

```
project store ─┐
observations ──┤
the request  ──┼──▶ CONTEXT ASSEMBLER ──▶ AssembledContext ──▶ prompt ──▶ model
decisions    ──┤     validate                (bounded,
constraints  ──┤     refuse secrets           labelled,
past runs    ──┘     order                    ordered)
                     deduplicate
                     bound / fail closed
```

| File | Responsibility |
| --- | --- |
| `src/domain/reasoningContext.ts` | Types, provenance, ranks, limits |
| `src/reasoning/contextSources.ts` | Mapping stored records → context inputs |
| `src/reasoning/context.ts` | The assembler; ordering, dedup, bounds, refusal |
| `src/reasoning/prompt.ts` | Rendering, with labels, inside the existing fence |

Context construction happens in **one** place. Spread across a workflow node, a
prompt builder and a provider adapter, the bounds would drift apart the first
time one of them was edited.

---

## 3. Provenance and authority precedence

Six types, each with a rank the orchestrator can compare **without consulting
the model**:

| Provenance | Rank | Rendered as |
| --- | --- | --- |
| `HUMAN_DECISION` | 100 | `[HUMAN DECISION]` |
| `HUMAN_CONSTRAINT` | 90 | `[HUMAN CONSTRAINT]` |
| `PROJECT_METADATA` | 80 | `[TRUSTED PROJECT FACT]` |
| `REPOSITORY_OBSERVATION` | 70 | `[REPOSITORY OBSERVATION]` |
| `TASK_DESCRIPTION` | 60 | `[TASK DESCRIPTION]` |
| `HISTORICAL_AGENT_CLAIM` | 10 | `[UNTRUSTED AGENT CLAIM]` |

Model inference has no entry: it is output, it arrives later, and it ranks below
everything here.

**The precedence is a number, not a paragraph.** A sentence telling a model which
source wins is a request; a rank lets the orchestrator sort, compare and refuse
on its own.

**The model is never asked to resolve a conflict.** Where a low-authority record
overlaps a human one, `detectAuthorityConflicts` reports it — both records stay
in the context with their labels, and the conflict is surfaced to the human at
the gate. It is a detector, not a resolver; it deliberately over-reports, using
crude stemming so `changes`/`changed` still match.

### What a label does and does not do

Labelling a record `[UNTRUSTED AGENT CLAIM]` does **not** make a model treat it
as untrusted — models can be argued out of labels. What the label buys is real
but narrower: the orchestrator can enforce precedence mechanically, a human can
see which claim came from where, and a conflict can be *detected* rather than
silently resolved by whichever text the model weighted more heavily.

---

## 4. Where context-size authority lives

**One semantic authority: the assembler.** `CONTEXT_LIMITS` in
`src/domain/reasoningContext.ts` declares the budget, `assembleContext` enforces
it, and **nothing upstream may pre-trim to fit**. A caller that shortened a value
before handing it over would give the assembler an already-truncated input, and
the assembler would have no way to know anything was lost.

This was a real defect in the first implementation and the review caught it:
`contextSources.taskDescription` trimmed the request to fit, so the assembler
reported a complete, successful assembly of a request it had only been shown part
of — with nothing anywhere saying so. `contextSources.ts` now truncates nothing;
a test asserts the trimming helper is gone and that a long request passes through
at full length.

A second, quieter version of the same fault lived in the prompt renderer, which
`.slice()`d the fenced body and could therefore cut a human constraint the
assembler had deliberately preserved.

### Two limits, two different jobs

| | Owner | Question it answers | On overflow |
| --- | --- | --- | --- |
| `CONTEXT_LIMITS.maxTotalChars` (24,000) | assembler | how much material is the orchestrator willing to reason over | drop non-critical with a stated warning; **fail** on critical |
| `TRANSPORT_LIMIT_CHARS` (64,000) | prompt renderer | is the fully rendered prompt a sane thing to put on a wire | **fail closed**, typed failure, no model call |

The transport limit sits far above the semantic budget, so in normal operation it
never binds and the assembler alone decides what is dropped. It **never
truncates**: `buildUserPrompt` returns a result a caller must handle, so a
shortened prompt is not something that function can produce.

### Task-description handling

`TASK_DESCRIPTION` has its own field bound (`maxTaskDescriptionLength`, 4,000)
separate from every other provenance (`maxTextLength`, 2,000) — a one-line
observation has no business being long, whereas a request a human typed can run
to paragraphs. Both are enforced by `fieldLimitFor` **inside the assembler**.

That distinction previously did not exist in practice: `ContextRecord.text` was
capped at the smaller limit, which made the declared 4,000-character task bound
**unreachable**. The record schema now permits the largest field bound and the
assembler narrows it per provenance.

Because the task description is critical, a request over its bound **fails the
whole assembly**. No model call, zero-scope fallback, human gate. The failure
names the category and the lengths and does **not** quote the text — and neither
does the fallback plan, which omits the request from its summary entirely on a
context-failure path, since the request may be exactly what was refused.

## 5. Deterministic ordering and deduplication

Ordering: **authority rank → key → text.**

Repository observations are keyed by a **digest of their content**, not by array
position. The review asked whether index keys were safe here; tracing
inspection → `state.observations` → `repositoryObservations`, the list is built in
a fixed code order and `changedFiles` is sorted by the inspector, so it is very
probably stable — but "very probably" is not what a determinism property should
rest on, and an index key would silently change identity if a line were ever
inserted upstream. A content digest is stable by construction.

Human constraints deliberately keep index keys: `project.constraints` is a
human-authored array in `project.json` where the **order is itself the human's
intent** and part of the stored configuration, not incidental enumeration. Both
behaviours are covered by tests.
 Never insertion order, and never
filesystem order — the project store lists decisions and implementations with
`readdirSync`, which is not stable across machines, so every record carries a
stable key derived from its own identity.

**Ordering happens before deduplication**, and the sequence matters. Deduplicating
first would keep whichever copy arrived earliest — a property of the caller, not
the data — so the same facts supplied in a different order would produce a
different prompt. Sorting first makes the survivor the lowest-sorting one, every
time. A test asserts three different insertion orders render identically.

Deduplication is keyed on `(provenance, text)`. A human decision saying "Use
PostgreSQL" and an agent claim saying the same words are **not** the same record:
merging them would either promote the claim to the decision's authority or lose
the decision, depending on which survived.

---

## 6. Bounds, and what happens when they are hit

`CONTEXT_LIMITS` — not configurable; editing that file is the only way past.

```
maxRecords 200      maxTotalChars 24,000     maxTextLength 2,000
maxProjectMetadata 20                        maxHumanDecisions 40
maxHumanConstraints 40                       maxRepositoryObservations 80
maxHistoricalAgentClaims 20                  maxTaskDescriptionLength 4,000
```

**Critical context is never silently dropped.** `HUMAN_DECISION`,
`HUMAN_CONSTRAINT` and `TASK_DESCRIPTION` are critical: if one will not fit,
assembly **fails**. A model reasoning without a human constraint it was never
shown is worse than a model that was not asked.

Non-critical records may be dropped, and the drop is **stated** — in
`warnings`, and rendered into the prompt as `[CONTEXT INCOMPLETE]`. A context
that appears complete while material was discarded is the failure mode this
exists to prevent.

---

## 7. Sensitive data

A record whose text matches a credential shape is **refused, not redacted** —
assembly fails, no model call is made, and the value is not echoed into the
failure message, an event, or a log. Redacting and forwarding would mean deciding
a partially-scrubbed secret is safe to send to a third party.

This is a narrow value-shaped backstop, deliberately distinct from
`security/sensitive.ts`, which classifies *paths* by name and cannot answer "does
this sentence contain a token". It catches recognisable shapes; a secret that
looks like ordinary prose passes straight through — which is why **Task 007 sends
no file contents at all**.

The model receives project facts, human decisions and constraints, repository
*observations*, the request, and the orchestrator's own record of previous runs.
No source code, no environment, no grants, no credentials — and no mechanism to
ask for any of them.

---

## 8. Failure semantics

Context failures fail closed. `invalid_record`, `critical_context_too_large`,
`sensitive_content_refused` and `task_description_invalid` all mean: **no model
call**, the zero-scope placeholder plan, a recorded reason, and the run still
stops for a human. None of them advances to implementation or grants anything.

`assembleContext` returns a typed failure and does not throw — including when the
offending record's provenance is itself invalid, which is a path that used to
throw out of the function whose job is not to.

---

## 9. Persistence

Only a **bounded summary** enters workflow state: counts per provenance, total
characters, truncation flag, warnings. Not the records. They are derived from
things the store already holds, and copying them into a checkpoint would
duplicate project text into a second place with a different lifetime and grow the
checkpoint with the project.

---

## 10. What Task 006 keeps

Untouched: `ReasoningModel`, `ReasoningProposal`, typed reasoning failures,
`planFromProposal` trusted reconstruction, provider isolation, credential
isolation, the human approval interrupt. The context feeds that boundary rather
than bypassing it. There is still no `model → tool`, `model → filesystem`,
`model → grant` or `model → approval` path, and tests assert it.

---

## 11. Testing

`tests/reasoningContext.test.ts` — 43 tests covering A–L: provenance rendering,
human-decision-versus-agent-claim, constraint precedence, prompt injection,
oversized context (both truncation and critical failure), deterministic ordering
across three insertion orders, deduplication across provenance, six credential
shapes plus non-echo assertions, self-authorising claims, fail-closed workflow
integration, persistence round-trip, and the model boundary.

Three real defects were found by these tests during development and fixed:
deduplication running before ordering (non-deterministic survivor), the failure
path throwing on an invalid provenance, and conflict detection missing
`changes`/`changed`.

---

## 12. Limitations

1. **The transport limit is a backstop, not a promise.** It is set far above the
   semantic budget precisely so it never binds; if it ever does, the run fails
   rather than degrading, which is correct but is still a hard stop for the user.
2. **The `historicalAgentClaims` recency cap is a relevance judgement**, made in
   the source mapper because that is where the timestamps are. It selects which
   runs are worth sending; it truncates no record and is not a size authority.
   A different relevance rule would send different claims.
3. **Prompt injection is not solved.** Repository content still reaches the
   prompt. Labels are enforcement for the orchestrator and information for the
   human; to the model they are a suggestion.
4. **The model is not trustworthy, and neither is the context.** Labelling a
   record does not make its contents true — a human decision can be wrong, an
   observation can be stale.
5. **The conflict detector is a heuristic.** Word overlap with crude stemming. It
   over-reports, and it will miss a conflict expressed in different words
   entirely. It is a prompt for human attention, not a guarantee.
6. **The secret detector is shape-based.** It catches known formats; a secret
   that reads as prose passes.
7. **Truncation still loses information**, even though it is announced. A model
   told its observations are incomplete is better off than one that was not, but
   it is still reasoning with less than the whole picture.
8. **More context does not mean better plans.** It means better-informed
   proposals, which may read as more authoritative while being just as wrong.
9. **No file contents, by design.** Controlled repository evidence is a separate
   decision for a later task.

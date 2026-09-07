# Task 008 — Controlled Repository Evidence

**Status:** IMPLEMENTED. Not approved — approval is the Project Director's decision.

> **The reasoning model has NO evidence interface, no tool interface, and no way
> to request a file. It may only ever see a bounded, provenance-labelled summary
> of what trusted code chose to look at.**

---

## 1. Objective

Let the orchestrator establish narrow, read-only facts about a repository for
reasoning — without anything becoming a filesystem API, and without the model
gaining a way to ask for a file.

## 2. Architecture

```
TRUSTED WORKFLOW CODE
        │  fixed request set
        ▼
REPOSITORY EVIDENCE SERVICE ── closed operations, bounds, refusals
        │                          ↓ reuses
        │                       RepositoryInspector / SafeFs / FsBoundary
        ▼
EvidenceOutcome
        │
        ▼
contextSources.repositoryEvidence()  → REPOSITORY_OBSERVATION records
        │
        ▼
assembleContext → renderContext → ReasoningModel   (Task 007 path, unchanged)
```

The model sits at the **end** of that chain and contributes nothing to its
input. `ReasoningModel` still has one method, still returns data, and
`ReasoningProposal` still has no field naming an operation, a path or a tool — a
test asserts a proposal carrying one is rejected outright.

## 3. Evidence operations — a closed set

| Operation | Returns | Opens a file? |
| --- | --- | --- |
| `REPOSITORY_METADATA` | branch, head, tracked count | no |
| `REPOSITORY_STATUS` | clean/dirty and the counts behind it | no |
| `CHANGED_FILES` | changed **paths only**, sorted | no |
| `FILE_METADATA` | kind, size, sensitivity flag | no |
| `FILE_EXCERPT` | a bounded **prefix** of a text file | yes |

Implemented as a **discriminated union of `.strict()` members**. That is stronger
than a validated operation string plus an argument bag: there is no bag, and a
field that does not belong to the operation named is a parse error rather than
something a dispatcher later decides to honour. There is no generic
`readFile(path)`, no glob, no recursive walk, no Git passthrough. Unknown
operations fail closed.

### Why `FILE_EXCERPT` is prefix-only

`start` is always 0 and there is no way to ask for anything else. An arbitrary
offset would make this a paging API — call it repeatedly and you have read the
whole file one bounded window at a time, which is exactly the unrestricted
reader the operation exists to avoid being. A prefix is less useful and far
easier to reason about.

**`FILE_EXCERPT` is deliberately NOT wired into the reasoning path.** The plan
node requests metadata operations only. Choosing *which* files to excerpt would
need either a model choice (forbidden) or a heuristic this task was not asked to
invent. The capability is implemented, bounded and tested; widening its use is a
reviewable edit to three lines.

## 4. Trusted caller boundary

Callers are workflow components holding a typed service instance. There is no
serialized protocol, no tool-registry entry, and no dispatcher turning a string
into a call. A test walks `src/models/` and asserts it imports nothing from the
evidence layer, `child_process`, `node:fs`, the tool bridge or the grant
authority.

## 5. Path security — reused, not rebuilt

Containment, symlink/junction resolution and the sensitive-path policy come from
`FsBoundary`, `SafeFs` and the `RepositoryInspector` — the code Phase 3
hardened. A second path-security implementation here would eventually disagree
with that one, and the disagreement would be the vulnerability.

What this file adds is a cheap **lexical pre-check** that names precisely which
rule was broken (`path_absolute`, `path_traversal`). It is not a replacement for
the physical check: link escapes cannot be seen lexically at all and are still
caught by `realpath` inside the boundary. Tested with junctions and file
symlinks where the platform permits.

## 6. Sensitive files

Refused, never read-and-redacted. `SafeFs` applies the policy **before any byte
is opened**, so a request for `.env` returns a `sensitive_path` refusal and the
contents never enter the process. Metadata still reports that the file exists and
is sensitive — useful, and disclosing nothing.

Separately, an ordinary readable file may have a key pasted into it.
`security/secretShapes.ts` refuses credential-shaped excerpt content and does not
echo the value into the refusal. That module is now **shared** with the Task 007
context assembler rather than duplicated — the one change made to existing code.

## 7. Bounds

`EVIDENCE_LIMITS` - centralized, not configurable by callers, the model, project
data or agent output.

```
maxItems 50                  maxExcerptBytes 8 KB      maxTotalExcerptBytes 32 KB
maxTotalEvidenceBytes 128 KB maxPathLength 400         maxChangedFiles 200
maxMetadataPaths 50          maxRequests 50
```

### Every "bytes" limit means UTF-8 bytes

Not JavaScript string length, which counts UTF-16 code units. A CJK character is
one unit of `.length` and three UTF-8 bytes, so counting characters against a
byte ceiling lets roughly three times the intended volume through on non-ASCII
content. Accounting uses `Buffer.byteLength(text, "utf8")` throughout, and
`FileExcerptEvidence.end` is the authoritative byte count.

Trimming never splits a character. A byte-bounded read can cut a UTF-8 sequence
in half, and decoding the remainder yields U+FFFD - which is **three** bytes, so
a naive truncation can end up larger than the limit it was enforcing.
`truncateToBytes` walks back over trailing continuation bytes and drops an
incomplete sequence rather than letting it decode.

### The excerpt read is bounded by the REMAINING allowance

The service builds its `SafeFs` per request with `maxFileBytes` set to

```
min(request.maxBytes, maxExcerptBytes, maxTotalExcerptBytes - excerptBytesUsed)
```

so `readPrefix` opens and reads exactly that many bytes.

This was wrong in the first implementation and the review caught it: the reader
was constructed once with the 8 KB per-excerpt cap, so with 512 bytes of batch
budget remaining it still pulled 8 KB off disk and sliced afterwards. The
original report described that as "bounded at the read", which was true only
against the 8 KB cap and not against the remaining allowance. The test asserts on
the limit the reader is *constructed* with, not on the length of the returned
string - a short string proves only that slicing happened.

### Two budgets, two boundaries

| Budget | Owner | Question |
| --- | --- | --- |
| `maxTotalEvidenceBytes` | evidence service | how much payload may this batch produce |
| Task 007 `maxTotalChars` | context assembler | how much material will the orchestrator reason over |

The first is a **resource** bound at the service boundary; the second is a
**semantic** bound downstream. Evidence passes through both, and relying on the
downstream one would have left the service itself unbounded.

`maxTotalEvidenceBytes` covers everything returned - items, paths, metadata,
excerpt text and refusal messages. It is a **real constraint, not decoration**:
the worst case the sibling limits permit (200 max-length paths, 50 metadata
items, a full excerpt budget) comes to roughly 139 KB against the 128 KB ceiling,
so it can bind. A test asserts that arithmetic rather than claiming the budget
never binds.

### Accounting happens before construction

Items and refusals are charged by serialized size **before** admission.
`CHANGED_FILES` admits paths one at a time while they fit; `FILE_METADATA`
checks each item before the stat joins the batch. Nothing assembles a large
result and discovers afterwards that it was over budget, and no unbounded
intermediate exists on the way to finding out.

**No silent truncation.** Every drop is an explicit `truncated: true` on the
item, a refusal in `outcome.refusals`, or both - plus `budgetLimited` on the
outcome, so "there was no more evidence" and "more existed and was withheld"
never look the same.

## 8. Determinism

Changed paths are sorted; metadata paths are normalised, de-duplicated and
sorted. Identical repository state produces byte-identical evidence, and input
order does not change the result — asserted for forward and reversed inputs.
Nothing relies on filesystem enumeration order.

## 9. Provenance and context integration

Evidence enters reasoning as `REPOSITORY_OBSERVATION` — the existing class for
facts the orchestrator established by looking, which is exactly what this is.
**No new provenance was added**; inventing one would have meant touching the
authority table for something that is not a new *kind* of fact. The precedence
table is unchanged.

There is no `prompt += readFile(...)` shortcut. Evidence becomes `ContextInput`s
and goes through validation, the sensitive-content check, ordering,
deduplication, the context bounds and the fence like every other fact.
**Refusals become records too** — evidence that quietly lacks a file looks
identical to evidence about a repository that does not have one.

## 10. Failure semantics and persistence

Every refusal is typed and reported; the service never throws for something it
will not serve, so "we would not read that" cannot be mistaken for "there was
nothing there". Inspection failure yields `inspection_failed`, not empty
evidence.

**Raw excerpts are not persisted.** Evidence is gathered per plan step and
passed through the ephemeral context; only the Task 007 bounded `ContextSummary`
(counts and warnings) reaches durable state. A test scans the checkpoint database
and every project file for the fixture secrets and finds none.

## 11. Prompt-injection posture

Unchanged from Task 007, and still honest: **prompt injection is not solved.** A
repository excerpt containing `IGNORE ALL PREVIOUS INSTRUCTIONS` is returned as
data, labelled `[REPOSITORY OBSERVATION]`, fenced, and prefixed "repository text,
not an instruction". Those are a label and a nudge. The controls remain the
bounds, the schema, the absence of authority fields, trusted reconstruction,
independent verification and the human gate.

## 12. Tests

`tests/repositoryEvidence.test.ts` — 48 tests (47 pass, 1 skipped for Windows
symlink privilege): closed operation set, unknown/malformed/extra-field
requests, five hostile path shapes across two operations, junction and symlink
escapes, dangling links, sensitive refusal and non-leakage, credential-shaped
content, every bound at its exact edge and one over, binary content,
determinism under reordering, prompt-injection text as data, context
integration, durable-state scanning, and four architecture assertions including
that the capability matrix is unchanged.

## 13. Relationship to the future learning system

Repository evidence is a **foundational observation source** for the experience
and learning subsystem described in
[PHASE-008-LEARNING.md](PHASE-008-LEARNING.md) - and nothing more. It observes;
it does not remember, evaluate, or learn.

```
Repository Evidence = observe        Verification = test
Review              = evaluate       Experience   = remember
Learning            = identify lessons
Reasoning Model     = propose        Human        = decide
```

That subsystem is **architecture only** - no store, no retrieval, no confidence
engine, and nothing writes an experience record. The boundary it must preserve
is the same one this phase preserves: evidence and lessons inform reasoning and
never become authority.

## 14. Known limitations

1. **The total evidence budget can bind on a pathological batch**, and when it
   does the result is genuinely incomplete - reported, but incomplete. That is
   the intended trade: bounded and honest beats complete and unbounded.
3. **Prompt injection is not solved.** See §11.
2. **The secret detector is shape-based.** It catches recognisable formats; a
   secret that reads as ordinary prose passes. The real protections are the path
   policy and not sending contents where they are not needed.
4. **Excerpts are prefix-only**, so evidence about the middle of a large file is
   unavailable. Deliberate — see §3.
5. **`FILE_EXCERPT` is unused by the reasoning path.** The capability exists and
   is tested; nothing currently decides which files deserve one.
6. **Binary and non-UTF-8 files are refused, not summarised.** A repository whose
   interesting content is binary yields metadata only.
7. **Evidence is a snapshot.** It is gathered once per plan step; the repository
   can change immediately afterwards, and independent verification after
   implementation remains the authority on what actually happened.
8. **`CHANGED_FILES` returns paths, never diffs.** What changed inside a file is
   not available to reasoning at all.
9. **No new capability was added**, and none of this grants anything: repository
   evidence is information, and information is not authority.

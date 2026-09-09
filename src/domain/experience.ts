import { z } from "zod";

/**
 * THE EXPERIENCE FOUNDATION - ARCHITECTURE ONLY
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE LEARNS ANYTHING YET
 * ---------------------------------------------------------------------------
 * There is no experience store, no retrieval, no confidence evaluator, and
 * nothing in the workflow writes a record. This module fixes the SHAPE while
 * that is still cheap; `docs/PHASE-008-LEARNING.md` describes the progression
 * and Tasks 009+ implement it. A test asserts no production code imports this
 * module, so "architecture only" stays true until someone changes it
 * deliberately.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT THIS FILE PROTECTS
 * ---------------------------------------------------------------------------
 *
 *     LEARNING  ->  REASONING
 *     LEARNING  -/->  AUTHORITY
 *
 * A lesson drawn from a hundred verified runs is still, at the moment it
 * reaches a decision, TEXT THAT ARRIVED FROM STORAGE. It can inform a proposal.
 * It cannot approve one, grant a capability, widen a scope, lower a risk
 * classification, or disable a check.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FIRST VERSION OF THIS FILE GOT WRONG
 * ---------------------------------------------------------------------------
 * Two claims in the original foundation were false, and the review caught both:
 *
 *   1. "Cross-project leakage is prevented because there is no content field."
 *      Wrong. `planSummary`, `failures`, `successfulPatterns` and the rest are
 *      free text, and free text IS content - it can carry a diff, a prompt, a
 *      model response or a secret just as effectively as a field named
 *      `content` would. Absence of that NAME prevented nothing.
 *
 *   2. "Confidence is derived, never invented." Also wrong, because
 *      `confidence` and `independentlyVerified` were writable fields. A caller
 *      could store `sources: ["AGENT_CLAIM"]` alongside
 *      `confidence: "very_high", independentlyVerified: true` and the schema
 *      would accept it.
 *
 * Both are corrected structurally below rather than by documentation.
 */

/** Hard ceilings. Not configurable - editing this file is the only way past. */
export const EXPERIENCE_LIMITS = {
  maxSummaryLength: 2_000,
  maxItemLength: 500,
  maxPatterns: 20,
  maxFailures: 20,
  maxCorrections: 20,
  maxEvidenceRefs: 50,
  maxTaskTypeLength: 100,
  /** A portable lesson is short by construction. See `PortableLesson`. */
  maxLessonStatementLength: 300,
} as const;

const Item = z.string().min(1).max(EXPERIENCE_LIMITS.maxItemLength);

/**
 * WHERE A STATEMENT ABOUT AN OUTCOME CAME FROM.
 *
 *   AGENT_CLAIM            the agent said so. Evidence of nothing.
 *   PROCESS_OBSERVATION    the OS reported an exit code. A fact about a
 *                          program, not about a repository.
 *   REPOSITORY_OBSERVATION we inspected the repository ourselves.
 *   VERIFICATION_RESULT    a configured check actually ran and returned.
 *   REVIEW_FINDING         the deterministic review layer produced it.
 *   HUMAN_DECISION         a person decided. The only source that authorises.
 */
export const OutcomeSource = z.enum([
  "AGENT_CLAIM",
  "PROCESS_OBSERVATION",
  "REPOSITORY_OBSERVATION",
  "VERIFICATION_RESULT",
  "REVIEW_FINDING",
  "HUMAN_DECISION",
]);
export type OutcomeSource = z.infer<typeof OutcomeSource>;

/**
 * Sources that establish something independently of what the agent said.
 *
 * `PROCESS_OBSERVATION` is deliberately excluded: an exit code says a program
 * finished, not that a repository is in the intended state.
 */
export const INDEPENDENT_SOURCES: readonly OutcomeSource[] = [
  "REPOSITORY_OBSERVATION", "VERIFICATION_RESULT", "REVIEW_FINDING", "HUMAN_DECISION",
] as const;

/**
 * EVIDENCE QUALITY - VOCABULARY ONLY.
 *
 * Four ordinal levels rather than a float: a number invites a scoring formula,
 * and a formula invented without data dresses a guess up as a measurement.
 *
 *   low        an agent said so, and nothing corroborates it
 *   medium     the OS and/or the repository corroborate it
 *   high       a check ran, or a human reviewed it
 *   very_high  independently repeated - see the warning below
 *
 * `very_high` IS NOT REACHABLE from this module. Recurrence has to be counted
 * from real, attributable records, and no store exists to count them in. Task
 * 011 owns the authoritative derivation; anything here that claimed to produce
 * `very_high` would be asserting a fact nobody had established.
 */
export const EvidenceConfidence = z.enum(["low", "medium", "high", "very_high"]);
export type EvidenceConfidence = z.infer<typeof EvidenceConfidence>;

/**
 * A PROVISIONAL reading of evidence quality. NOT a security boundary.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 * ---------------------------------------------------------------------------
 * It is a pure function of the sources present, useful for reasoning about the
 * vocabulary and for tests. It is NOT authoritative, is not persisted, and no
 * decision may rest on it.
 *
 * The previous version took an `independentConfirmations` integer from the
 * caller, which let `confidenceFrom(["VERIFICATION_RESULT"], 3)` claim
 * recurrence that nobody had demonstrated - a caller-asserted trust value
 * wearing the costume of a derivation. The parameter is gone.
 *
 * It therefore tops out at `high`. Reaching `very_high` requires counting
 * independent confirmations across attributable records, which is Task 011's
 * job and needs a store that does not exist.
 */
export function provisionalConfidence(
  sources: readonly OutcomeSource[],
): Exclude<EvidenceConfidence, "very_high"> {
  const has = (source: OutcomeSource): boolean => sources.includes(source);
  if (has("VERIFICATION_RESULT") || has("REVIEW_FINDING") || has("HUMAN_DECISION")) {
    return "high";
  }
  if (has("REPOSITORY_OBSERVATION") || has("PROCESS_OBSERVATION")) return "medium";
  return "low";
}

/** True only when something other than the agent corroborated the outcome. */
export function isIndependentlyVerified(sources: readonly OutcomeSource[]): boolean {
  return sources.some((source) => INDEPENDENT_SOURCES.includes(source));
}

/**
 * How settled a lesson is.
 *
 * These states let a lesson be HELD WITHOUT BEING BELIEVED, and RETIRED WITHOUT
 * BEING DELETED. A single failure must not become a permanent rule; a single
 * success must not become policy.
 */
export const LessonStatus = z.enum([
  "candidate", "supported", "uncertain", "contradicted", "deprecated",
]);
export type LessonStatus = z.infer<typeof LessonStatus>;

export const MemoryLayer = z.enum(["episodic", "semantic", "procedural"]);
export type MemoryLayer = z.infer<typeof MemoryLayer>;

/**
 * A reference to evidence that already exists elsewhere.
 *
 * A POINTER, not a copy. The `ref` is constrained to an identifier shape so it
 * cannot become a smuggling channel for the payload it points at - a free
 * string here would have reintroduced exactly the problem this correction
 * exists to fix.
 */
export const EvidenceRef = z.object({
  source: OutcomeSource,
  /**
   * An identifier: run id, check id, approval id, commit sha.
   *
   * Restricted to identifier characters and 120 bytes. No spaces, no newlines,
   * no punctuation that prose needs - so a diff or a sentence cannot be parked
   * here under the guise of a reference.
   */
  ref: z.string().min(1).max(120).regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/,
    "an evidence ref is an identifier, not free text",
  ),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/**
 * ONE COMPLETED RUN - PROJECT-SCOPED, AND NOT SAFE TO SHARE.
 *
 * ---------------------------------------------------------------------------
 * THIS RECORD CONTAINS CONTENT. SAY SO PLAINLY.
 * ---------------------------------------------------------------------------
 * The summary and pattern fields below are FREE TEXT written from a real run.
 * They can contain repository content, diff fragments, error messages carrying
 * paths, model output, or a secret somebody pasted into a source file. Nothing
 * in this schema can tell the difference between a useful lesson and a leaked
 * credential, because both are strings.
 *
 * So the type says what is true: `scope` is the literal `"project"`, and there
 * is no other value. An episodic record is confined to the project that
 * produced it, and no amount of later code can mark one as shareable, because
 * the field cannot hold another value.
 *
 * Cross-project material is a DIFFERENT TYPE - `PortableLesson` - which is
 * structurally incapable of carrying free text, and which cannot yet be marked
 * eligible at all.
 *
 * NOT PRESENT, ON PURPOSE: `confidence` and `independentlyVerified`. Both are
 * derived from `sources` by `provisionalConfidence` and
 * `isIndependentlyVerified`, and storing them would let a record assert a trust
 * level its own evidence contradicts. `.strict()` rejects them.
 */
export const EpisodicExperience = z.object({
  /**
   * PROJECT-SCOPED, IMMUTABLY.
   *
   * The single permitted value. Not a default that later code can override -
   * a literal, so "this became shareable somehow" is unrepresentable.
   */
  scope: z.literal("project"),
  layer: z.literal("episodic"),

  projectId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  taskType: z.string().min(1).max(EXPERIENCE_LIMITS.maxTaskTypeLength),

  /** FREE TEXT from a real run. Treat as project-confidential. */
  planSummary: z.string().max(EXPERIENCE_LIMITS.maxSummaryLength).default(""),
  implementationOutcome: z.string().max(EXPERIENCE_LIMITS.maxSummaryLength).default(""),
  verificationOutcome: z.string().max(EXPERIENCE_LIMITS.maxSummaryLength).default(""),
  reviewOutcome: z.string().max(EXPERIENCE_LIMITS.maxSummaryLength).default(""),
  failures: z.array(Item).max(EXPERIENCE_LIMITS.maxFailures).default([]),
  corrections: z.array(Item).max(EXPERIENCE_LIMITS.maxCorrections).default([]),
  successfulPatterns: z.array(Item).max(EXPERIENCE_LIMITS.maxPatterns).default([]),
  failedPatterns: z.array(Item).max(EXPERIENCE_LIMITS.maxPatterns).default([]),

  /** Pointers to evidence held elsewhere. Never the evidence itself. */
  evidence: z.array(EvidenceRef).max(EXPERIENCE_LIMITS.maxEvidenceRefs).default([]),

  /**
   * Which sources supported this record. THE ONLY TRUST INPUT.
   *
   * Confidence and independent-verification are read from this, never stored
   * beside it, so they cannot disagree with it.
   */
  sources: z.array(OutcomeSource).max(10).default([]),

  status: LessonStatus.default("candidate"),
  createdAt: z.string().datetime(),
}).strict();
export type EpisodicExperience = z.infer<typeof EpisodicExperience>;

/**
 * A LESSON THAT COULD EVENTUALLY CROSS A PROJECT BOUNDARY.
 *
 * ---------------------------------------------------------------------------
 * STRUCTURALLY INCAPABLE OF CARRYING A PAYLOAD
 * ---------------------------------------------------------------------------
 * The whole point of a separate type. A portable lesson has no summary, no
 * failure list, no pattern list, and no evidence text - only a short statement
 * under a character allowlist, a task-type label, and counts.
 *
 * The allowlist is the load-bearing part: letters, digits, spaces and a little
 * sentence punctuation. No slashes, no dots-in-sequence, no backticks, no
 * newlines, no braces, no equals. A file path, a diff hunk, a JSON blob, a
 * base64 token and an `API_KEY=...` assignment are all unrepresentable rather
 * than merely discouraged.
 *
 * It is a genuine restriction, not a filter - a determined caller could still
 * write a secret in plain words, which is why eligibility is ALSO gated below.
 *
 * ---------------------------------------------------------------------------
 * AND IT CANNOT BE MARKED ELIGIBLE YET
 * ---------------------------------------------------------------------------
 * `crossProjectEligible` is the literal `false`. There is no value that means
 * "yes", so no code written before the sanitisation design exists can promote a
 * lesson across a project boundary - not by mistake, and not on purpose.
 *
 * Enabling it means changing this line, which is a visible, reviewable act. No
 * task currently owns that design. This comment used to name Task 010; Task 010
 * turned out to be project-scoped retrieval, whose brief forbids cross-project
 * learning outright, and a comment naming a task that is not doing the work
 * reads as authorisation to whoever arrives next.
 */
export const PortableLesson = z.object({
  layer: z.enum(["semantic", "procedural"]),

  /** A coarse retrieval label, not a description of any particular project. */
  taskType: z.string().min(1).max(EXPERIENCE_LIMITS.maxTaskTypeLength)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "a task type is a kebab-case label"),

  /**
   * The lesson, in plain words.
   *
   * Short and character-restricted so it cannot carry a path, a diff, a token
   * or a key-value assignment. See the note above on what this does and does
   * not guarantee.
   */
  statement: z.string().min(1).max(EXPERIENCE_LIMITS.maxLessonStatementLength)
    .regex(/^[A-Za-z0-9 ,.;:'()-]+$/,
      "a portable lesson is plain prose: no paths, code, tokens or assignments"),

  /** How many attributable records support it. Set by a future evaluator. */
  supportingRecords: z.number().int().nonnegative().max(10_000).default(0),
  contradictingRecords: z.number().int().nonnegative().max(10_000).default(0),

  status: LessonStatus.default("candidate"),

  /**
   * ALWAYS FALSE, TODAY.
   *
   * Cross-project use requires a sanitisation and eligibility design that does
   * not exist. A literal rather than a default, so it cannot be flipped by a
   * caller, a migration, or a hand-edited record.
   */
  crossProjectEligible: z.literal(false),

  createdAt: z.string().datetime(),
}).strict();
export type PortableLesson = z.infer<typeof PortableLesson>;

/**
 * Field names that would mean authority, or a content payload, if this schema
 * ever accepted them.
 *
 * Asserted against the parsed shape by a test, so adding one becomes a visible,
 * reviewable act rather than an accident.
 */
export const FORBIDDEN_EXPERIENCE_KEYS: readonly string[] = [
  // Authority.
  "approved", "approve", "capabilities", "capability", "grant", "grants",
  "execute", "command", "shell", "tool", "tools", "risk", "highestRisk",
  "allowedScope", "scope", "authorized", "authorised", "bypass", "policy",
  // Payload.
  "credentials", "token", "secret", "content", "diff", "prompt", "response",
  "env", "environment", "stdout", "stderr", "transcript",
  // Derived trust that must never be stored beside its own evidence.
  "confidence", "independentlyVerified",
] as const;

/**
 * The provenance experience will carry when it eventually reaches reasoning.
 *
 * DECLARED, NOT LIVE. `ContextProvenance` has not gained this class, because
 * nothing produces experience and a provenance nothing uses is a claim the
 * system does not honour. The intended rank sits above a bare agent claim and
 * below everything a human decided or the orchestrator observed itself.
 */
export const INTENDED_EXPERIENCE_PROVENANCE = "HISTORICAL_EXPERIENCE" as const;
export const INTENDED_EXPERIENCE_RANK = 20 as const;

/**
 * Thresholds that are DESIGN ASSUMPTIONS, not validated facts.
 *
 * Recorded here so a future task cannot quietly treat them as established. No
 * experience dataset exists, so nobody knows whether three confirmations is
 * sufficient evidence for anything. Task 011 must validate or replace these
 * against real data - and may not mark them settled merely because tests pass.
 */
export const PROVISIONAL_THRESHOLDS = {
  /** UNVALIDATED. A placeholder for Task 011 to justify or discard. */
  confirmationsForVeryHigh: 3,
} as const;

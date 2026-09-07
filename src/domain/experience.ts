import { z } from "zod";

/**
 * THE EXPERIENCE FOUNDATION - ARCHITECTURE ONLY
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE LEARNS ANYTHING YET
 * ---------------------------------------------------------------------------
 * There is no experience store, no retrieval, no confidence engine, and nothing
 * in the workflow writes an `ExperienceRecord`. This module exists so that the
 * shape of the eventual learning subsystem is decided NOW, while the security
 * boundaries are being built and while adding a field is cheap - rather than
 * later, when a learning engine already exists and the awkward questions are
 * expensive to answer.
 *
 * `docs/PHASE-008-LEARNING.md` describes the intended progression. Tasks 009+
 * implement it. A test asserts that no production code imports this module, so
 * "architecture only" stays true until someone deliberately changes it.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT THIS FILE EXISTS TO PROTECT
 * ---------------------------------------------------------------------------
 *
 *     LEARNING  ->  REASONING
 *     LEARNING  -/->  AUTHORITY
 *
 * A lesson drawn from a hundred successful runs is still, at the moment it
 * reaches a decision, a piece of TEXT that arrived from storage. It can inform
 * a proposal. It cannot approve one, grant a capability, widen a scope, lower a
 * risk classification, or disable a check.
 *
 * That is enforced the same way the reasoning boundary is enforced: the schema
 * declares no field that could carry authority, `.strict()` refuses any that
 * shows up, and `FORBIDDEN_EXPERIENCE_KEYS` is asserted against the parsed
 * shape. An experience record has nowhere to put a grant even if something
 * upstream tried to give it one.
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
} as const;

const Item = z.string().min(1).max(EXPERIENCE_LIMITS.maxItemLength);

/**
 * WHERE A STATEMENT ABOUT AN OUTCOME CAME FROM.
 *
 * The ladder this system already implements, named so experience can record
 * which rung a claim actually reached:
 *
 *   AGENT_CLAIM            the agent said so. Evidence of nothing.
 *   PROCESS_OBSERVATION    the OS reported an exit code. A fact about a
 *                          program, not about a repository.
 *   REPOSITORY_OBSERVATION we inspected the repository ourselves.
 *   VERIFICATION_RESULT    a configured check actually ran and returned.
 *   REVIEW_FINDING         the deterministic review layer produced it.
 *   HUMAN_DECISION         a person decided. The only source that authorises.
 *
 * They are ordered, and the order matters: an outcome supported only by
 * `AGENT_CLAIM` must never be stored as though it were supported by
 * `VERIFICATION_RESULT`.
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

/** Sources that establish something independently of what the agent said. */
export const INDEPENDENT_SOURCES: readonly OutcomeSource[] = [
  "REPOSITORY_OBSERVATION", "VERIFICATION_RESULT", "REVIEW_FINDING", "HUMAN_DECISION",
] as const;

/**
 * EVIDENCE QUALITY, DERIVED FROM EVIDENCE - NEVER INVENTED.
 *
 * Deliberately a small ordinal set rather than a number. A float would invite a
 * scoring formula, and a scoring formula invented without data is a way of
 * dressing a guess up as a measurement. These four levels say only which KINDS
 * of evidence exist, which is a fact rather than an estimate.
 *
 *   low        an agent said so, and nothing corroborates it
 *   medium     the OS and/or the repository corroborate it
 *   high       a check ran, or a human reviewed it
 *   very_high  independently repeated across separate runs or projects
 */
export const EvidenceConfidence = z.enum(["low", "medium", "high", "very_high"]);
export type EvidenceConfidence = z.infer<typeof EvidenceConfidence>;

/**
 * Confidence from the sources actually present.
 *
 * `very_high` additionally requires repetition, which is a COUNT the caller
 * must supply from real records rather than something this function can
 * conjure. Passing a count nobody counted would be inventing data, so the
 * default is 1 - this run, once.
 */
export function confidenceFrom(
  sources: readonly OutcomeSource[],
  independentConfirmations = 1,
): EvidenceConfidence {
  const has = (source: OutcomeSource): boolean => sources.includes(source);
  const reviewed = has("VERIFICATION_RESULT") || has("REVIEW_FINDING") || has("HUMAN_DECISION");
  const observed = has("REPOSITORY_OBSERVATION") || has("PROCESS_OBSERVATION");

  if (reviewed && independentConfirmations >= 3) return "very_high";
  if (reviewed) return "high";
  if (observed) return "medium";
  return "low";
}

/**
 * How settled a lesson is.
 *
 * A single failure must not become a permanent rule, and a single success must
 * not become a policy. These states exist so a lesson can be held without being
 * believed, and retired without being deleted.
 */
export const LessonStatus = z.enum([
  /** Observed once. Not yet reusable guidance. */
  "candidate",
  /** Repeatedly observed with independent evidence. */
  "supported",
  /** Evidence exists on both sides; recorded, not applied. */
  "uncertain",
  /** Later evidence contradicts it. */
  "contradicted",
  /** Was supported, no longer applies. Kept, so it is not silently relearned. */
  "deprecated",
]);
export type LessonStatus = z.infer<typeof LessonStatus>;

/**
 * The three memory layers the eventual system is aimed at.
 *
 * Named now because they have different retention, different privacy exposure
 * and different retrieval rules, and conflating them later would be expensive.
 */
export const MemoryLayer = z.enum([
  /** What happened in one run. Project-scoped, the most sensitive. */
  "episodic",
  /** What repeats across runs. Generalised, and the only layer that could ever
   *  reasonably cross a project boundary - and then only sanitised. */
  "semantic",
  /** Which sequences of steps have worked for a class of task. */
  "procedural",
]);
export type MemoryLayer = z.infer<typeof MemoryLayer>;

/**
 * A reference to evidence that already exists elsewhere.
 *
 * A POINTER, not a copy. Experience must not become a second store of
 * repository contents, diffs, or check output: those are bounded and governed
 * where they live, and duplicating them here would create an unbounded archive
 * with a different lifetime and weaker rules. There is deliberately no `content`
 * field to put them in.
 */
export const EvidenceRef = z.object({
  source: OutcomeSource,
  /** Run, check id, or approval id - an identifier, never a payload. */
  ref: z.string().min(1).max(200),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/**
 * ONE COMPLETED RUN, AS EXPERIENCE.
 *
 * Bounded, provenance-aware, and carrying no authority. Every field is either a
 * short human-readable statement or a reference to evidence held elsewhere.
 *
 * NOT PRESENT, ON PURPOSE: file contents, diffs, prompts, model responses,
 * environment values, credentials, grants, capabilities, approvals, or a risk
 * level. Several of those would be genuinely useful for learning, and each is
 * either a secret, an authority, or an unbounded payload - so the record
 * references them instead of holding them.
 */
export const ExperienceRecord = z.object({
  projectId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),

  /** A coarse label for retrieval, e.g. "add-endpoint". Not a free-form prompt. */
  taskType: z.string().min(1).max(EXPERIENCE_LIMITS.maxTaskTypeLength),

  /** What was planned, what happened, and how it was judged - as summaries. */
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
   * Which sources actually supported this record.
   *
   * The honest answer to "how do we know?". An outcome resting on
   * `AGENT_CLAIM` alone is stored as exactly that.
   */
  sources: z.array(OutcomeSource).max(10).default([]),
  confidence: EvidenceConfidence.default("low"),
  /** Whether anything independent confirmed the agent's account. */
  independentlyVerified: z.boolean().default(false),

  layer: MemoryLayer.default("episodic"),
  status: LessonStatus.default("candidate"),

  createdAt: z.string().datetime(),
}).strict();
export type ExperienceRecord = z.infer<typeof ExperienceRecord>;

/**
 * Field names that would mean authority if this schema ever accepted them.
 *
 * Exported so a test can assert they are absent from the parsed shape - the
 * same guard `FORBIDDEN_PROPOSAL_KEYS` provides for model output. Adding one of
 * these later becomes a visible, reviewable act rather than an accident.
 */
export const FORBIDDEN_EXPERIENCE_KEYS: readonly string[] = [
  "approved", "approve", "capabilities", "capability", "grant", "grants",
  "execute", "command", "shell", "tool", "tools", "risk", "highestRisk",
  "allowedScope", "scope", "authorized", "authorised", "bypass", "policy",
  "credentials", "token", "secret", "content", "diff", "prompt", "response",
] as const;

/**
 * The provenance experience will carry when it eventually reaches reasoning.
 *
 * DECLARED HERE, NOT YET ADDED to `ContextProvenance` - because nothing
 * produces experience yet, and a provenance class in the live authority table
 * that no record ever uses is a claim the system does not honour. Task 009 adds
 * it deliberately, with the rank below.
 *
 * The intended rank sits BELOW every human and orchestrator-observed source and
 * ABOVE a bare agent claim: a verified lesson is worth more than one agent's
 * say-so, and less than what a human decided or what the repository shows right
 * now. A test asserts it is not yet present in the live table.
 */
export const INTENDED_EXPERIENCE_PROVENANCE = "HISTORICAL_EXPERIENCE" as const;
export const INTENDED_EXPERIENCE_RANK = 20 as const;

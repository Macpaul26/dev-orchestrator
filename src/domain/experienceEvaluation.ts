import { z } from "zod";
import { ExperienceId, StorageProjectId, ExperienceDefect } from "./experienceStorage.js";

/**
 * EXPERIENCE EVALUATION - TYPES AND BOUNDS
 *
 * Task 010 answers "which historical experiences are relevant to this query?".
 * This answers a different question: "what can be legitimately inferred about
 * the reliability of a recurring pattern from the experiences already stored?"
 *
 * ---------------------------------------------------------------------------
 * CONFIDENCE IS NOT TRUTH, AND EVALUATION IS NOT AUTHORITY
 * ---------------------------------------------------------------------------
 *     EVALUATION  ->  LEARNING SIGNAL
 *     EVALUATION  -/->  AUTHORITY, APPROVAL, CAPABILITY, GRANT,
 *                       SECURITY EXCEPTION, HUMAN DECISION
 *
 * A confidence score is an assessment of history under a documented policy. It
 * is not truth, not verification, not permission to act, and not evidence that
 * a proposed action is safe. Nothing in this file may be read as any of those,
 * and nothing here grants anything.
 *
 * ---------------------------------------------------------------------------
 * RELEVANCE AND CONFIDENCE ARE DIFFERENT DIMENSIONS
 * ---------------------------------------------------------------------------
 *   RELEVANCE   how well a record matches a query            (Task 010)
 *   CONFIDENCE  how strongly the evaluated history supports
 *               relying on a recurring pattern               (here)
 *
 * They are computed from different inputs and neither is derived from the
 * other. A record can match a query perfectly and be contradicted by every
 * other record in the project; it would score high relevance and low
 * confidence, and collapsing the two would destroy exactly that signal.
 */

/** Hard ceilings. Not configurable - editing this file is the only way past. */
export const EVALUATION_LIMITS = {
  /** Records one evaluation may load and classify, across all pages. */
  maxCandidateRecords: 500,
  /** Store pages one evaluation may request. A second, independent stop. */
  maxCandidatePages: 10,
  /** Classification operations one evaluation may perform. A third stop. */
  maxComparisons: 32_000,
  /** Pattern items taken from one record. */
  maxPatternItems: 8,
  /** Characters kept from one normalized pattern. */
  maxPatternChars: 200,
  /**
   * Recurrences of one kind that can contribute to a count.
   *
   * A flood of identical records cannot overflow a counter or move the score
   * further than a modest corpus already would.
   */
  maxCountedRecurrences: 1_000,
  /** Defects one evaluation reports. */
  maxReportedDefects: 20,

  /**
   * Corroborating records at which evidence VOLUME stops adding confidence.
   *
   * UNVALIDATED, and deliberately still labelled so. See
   * `PROVISIONAL_THRESHOLDS` in experience.ts, whose note says Task 011 must
   * justify or replace its placeholder "and may not mark them settled merely
   * because tests pass".
   *
   * Task 011 cannot validate it. Validating a threshold means measuring it
   * against real outcomes, and no experience corpus exists yet - nothing writes
   * experience in the workflow. Choosing a number that makes tests pass and
   * calling it validated would be inventing the data the note warns about. So
   * this stays an explicit, documented policy assumption, and the honest
   * position is recorded rather than quietly upgraded.
   */
  volumeSaturation: 3,
  /**
   * Percentage weight applied when the corpus could not be fully examined.
   *
   * UNVALIDATED policy. Its PURPOSE is not: a bounded scan cannot support the
   * same claim as a complete one, so confidence derived from part of a corpus
   * must not read as confidence derived from all of it. See `EvaluationCoverage`.
   */
  boundedCoverageWeight: 60,
  /** At or above this score the pattern is reported as supported. UNVALIDATED. */
  supportedAtOrAbove: 70,
  /** At or below this score the pattern is reported as contradicted. UNVALIDATED. */
  contradictedAtOrBelow: 30,
} as const;

/**
 * WHAT AN EVALUATION IS ASKED FOR.
 *
 * The subject is an experience ALREADY IN THE STORE, named by id. That is the
 * whole input, and it is deliberate: a caller cannot hand the evaluator a
 * record of its own devising, so it cannot smuggle in an outcome, a trust
 * level, or a confidence to be "confirmed". Whatever is evaluated has already
 * passed the store's integrity, identity and project-ownership checks.
 *
 * `.strict()` rejects every field a caller might reach for - confidence,
 * verified, trusted, authority, a second project, a path, a weight, a formula.
 * The caller asks for an evaluation; it does not get to influence the result.
 */
export const EvaluationRequest = z.object({
  projectId: StorageProjectId,
  experienceId: ExperienceId,
}).strict();
export type EvaluationRequest = z.infer<typeof EvaluationRequest>;

/**
 * HOW A COHORT RECORD RELATES TO THE PATTERN BEING EVALUATED.
 *
 *   supporting     it recorded the same approach among what SUCCEEDED, and
 *                  that outcome is admissible evidence
 *   contradicting  it recorded the same approach among what FAILED, and that
 *                  outcome is admissible evidence
 *   neutral        it is comparable but recorded no outcome for this approach
 *                  either way
 *   inadmissible   it recorded an outcome for this approach - it WOULD have
 *                  supported or contradicted - but nothing independent of the
 *                  agent backs that outcome, so it may not vote
 *
 * ---------------------------------------------------------------------------
 * WHY `inadmissible` IS NOT `neutral` - CORRECTED AFTER REVIEW
 * ---------------------------------------------------------------------------
 * The first version had no admissibility gate at all: it ignored `sources` on
 * the grounds that weighting by provenance would build an authority ladder
 * inside the score. That reasoning was half right. Provenance must not WEIGHT a
 * vote - but it does decide whether there is a vote to count, and skipping that
 * question let three repeated agent claims score 100. Independent review caught
 * it: repetition of an unsupported claim was manufacturing confidence, which is
 * precisely what Task 008-A's `INDEPENDENT_SOURCES` exists to prevent.
 *
 * `neutral` and `inadmissible` are therefore different facts and are reported
 * separately. A neutral record has nothing to say about the approach. An
 * inadmissible record HAS something to say and is not allowed to say it in the
 * tally - and a reader deserves to know how many such records exist, because a
 * pattern with forty inadmissible supporters and no admissible ones is a
 * pattern the agent keeps asserting and nothing has ever confirmed.
 *
 *     EVIDENCE ADMISSIBILITY  !=  AUTHORITY
 *
 * Admissibility is binary. An admissible record counts exactly once whatever
 * its source, so a human decision and a verification result corroborate
 * identically. See `ADMISSIBLE_SOURCES` in the evaluator.
 */
export const RecurrenceRelation = z.enum([
  "supporting", "contradicting", "neutral", "inadmissible",
]);
export type RecurrenceRelation = z.infer<typeof RecurrenceRelation>;

/**
 * THE RECURRENCE TALLY.
 *
 * `key` identifies the pattern - see `recurrenceKey` in the evaluator for what
 * it is derived from and, more importantly, what it deliberately excludes.
 *
 * The subject NEVER counts towards its own tally. An experience is not evidence
 * for itself, and letting it corroborate itself would mean a single record
 * could reach the same score as a genuinely repeated one.
 *
 * ONLY `supporting` AND `contradicting` VOTE. `neutral` and `inadmissible` are
 * reported so the reader can see the shape of the corpus, and contribute nothing
 * to the score. `cohort` counts all four, so it answers "how many comparable
 * runs exist", not "how many were counted".
 */
export const RecurrenceTally = z.object({
  key: z.string().regex(/^[0-9a-f]{32}$/, "a recurrence key is 32 lower-case hex characters"),
  /** Comparable records, excluding the subject. Includes every relation below. */
  cohort: z.number().int().nonnegative(),
  /** Admissible records whose outcome corroborates the approach. VOTES. */
  supporting: z.number().int().nonnegative(),
  /** Admissible records whose outcome contradicts the approach. VOTES. */
  contradicting: z.number().int().nonnegative(),
  /** Comparable records silent on this approach. Does not vote. */
  neutral: z.number().int().nonnegative(),
  /** Records with an outcome for this approach that nothing independent backs. Does not vote. */
  inadmissible: z.number().int().nonnegative(),
}).strict();
export type RecurrenceTally = z.infer<typeof RecurrenceTally>;

/**
 * CONFIDENCE - OR THE EXPLICIT ABSENCE OF IT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A NUMBER
 * ---------------------------------------------------------------------------
 * "Nothing corroborates or contradicts this" and "everything contradicts this"
 * are different findings that would both bottom out at zero on a 0-100 scale.
 * Reporting both as `0` conflates absence of evidence with evidence of absence,
 * which is the specific confusion this layer must not create.
 *
 * So no evidence produces NO SCORE AT ALL, structurally - there is no number to
 * misread, and a caller cannot average, threshold or chart a confidence that was
 * never established. Same reasoning as `ExperienceRecordCount` in Task 009 and
 * `RetrievalCoverage` in Task 010.
 *
 * ---------------------------------------------------------------------------
 * WHAT `score` MEANS
 * ---------------------------------------------------------------------------
 * "The degree to which the bounded historical evaluation supports relying on
 * this recurring pattern, under the documented policy in PHASE-011."
 *
 * It is NOT a probability that the pattern is true. There is no statistical
 * basis for that reading: the corpus is whatever this project happened to
 * record, it is not a sample of anything, and the weights are policy choices
 * rather than measurements.
 */
export const ConfidenceAssessment = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("insufficient_evidence"),
  }).strict(),
  z.object({
    kind: z.literal("assessed"),
    /** 0-100 inclusive. A policy score, never a probability. */
    score: z.number().int().min(0).max(100),
  }).strict(),
]);
export type ConfidenceAssessment = z.infer<typeof ConfidenceAssessment>;

/**
 * The evaluation's summary judgement.
 *
 * `insufficient_evidence` is a first-class outcome, not a failure. Most
 * patterns in a young project will land here, and saying so is more useful than
 * manufacturing a number.
 */
export const EvaluationStatus = z.enum([
  "insufficient_evidence",
  "supported",
  "uncertain",
  "contradicted",
]);
export type EvaluationStatus = z.infer<typeof EvaluationStatus>;

/** Why an evaluation stopped examining the corpus. */
export const EvaluationStopReason = z.enum([
  "candidate_limit",
  "page_limit",
  "work_limit",
  "scan_incomplete",
]);
export type EvaluationStopReason = z.infer<typeof EvaluationStopReason>;

/**
 * HOW MUCH OF THE CORPUS WAS ACTUALLY EXAMINED.
 *
 * An evaluation that found five supporting records in the first five hundred of
 * five thousand has not established that the project's history supports the
 * pattern. It has established that a bounded prefix of it does. `bounded`
 * carries that distinction in the type, and the confidence policy applies a
 * documented weight so the score cannot claim what the scan did not cover.
 */
export const EvaluationCoverage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("complete"),
    examined: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("bounded"),
    examined: z.number().int().nonnegative(),
    reason: EvaluationStopReason,
  }).strict(),
]);
export type EvaluationCoverage = z.infer<typeof EvaluationCoverage>;

/**
 * THE EVALUATION ARTIFACT.
 *
 * ---------------------------------------------------------------------------
 * DERIVED, BESIDE THE RECORD - NEVER WRITTEN INTO IT
 * ---------------------------------------------------------------------------
 * This carries the subject's ID, not the subject's record. The stored
 * `EpisodicExperience` is not mutated, not re-persisted, and gains no
 * confidence field - Task 008-A removed those from the schema precisely so a
 * record could not assert a trust level its own evidence contradicts, and an
 * evaluator that wrote one back would undo that.
 *
 * Nothing here is persisted at all. The artifact is a pure function of the
 * corpus at the moment it was computed, so there is no second source of truth
 * to fall out of step with the records, and no stored score for a later reader
 * to mistake for a property of the experience itself.
 */
export const EvaluationArtifact = z.object({
  /** The evaluated experience, by id. Never the record itself. */
  subject: ExperienceId,
  /** The normalized pattern the evaluation is about. Derived, not supplied. */
  pattern: z.object({
    taskType: z.string().max(EVALUATION_LIMITS.maxPatternChars),
    approaches: z.array(z.string().max(EVALUATION_LIMITS.maxPatternChars))
      .max(EVALUATION_LIMITS.maxPatternItems),
  }).strict(),
  recurrence: RecurrenceTally,
  confidence: ConfidenceAssessment,
  status: EvaluationStatus,
  coverage: EvaluationCoverage,
  /** Cohort candidates the store refused. Never counted as evidence. */
  rejected: z.array(ExperienceDefect).max(EVALUATION_LIMITS.maxReportedDefects),
}).strict();
export type EvaluationArtifact = z.infer<typeof EvaluationArtifact>;

/** Why an evaluation was refused. Fails closed; none of these is a warning. */
export const EvaluationFailureCode = z.enum([
  "invalid_project_id",
  "invalid_request",
  "subject_missing",
  "subject_defective",
  "storage_failure",
]);
export type EvaluationFailureCode = z.infer<typeof EvaluationFailureCode>;

export const EvaluationFailure = z.object({
  code: EvaluationFailureCode,
  /** Short and non-disclosing. Never a path, never a record. */
  message: z.string().max(300),
}).strict();
export type EvaluationFailure = z.infer<typeof EvaluationFailure>;

/**
 * Field names that would mean authority, or caller-supplied trust, if an
 * evaluation request or artifact ever accepted them.
 *
 * Asserted against the parsed shapes by a test. `confidence` is absent from
 * this list for the request only in the sense that the request has no fields
 * beyond two identifiers - the artifact DOES carry a confidence, because
 * producing one is what this task is for. The distinction that matters is
 * DERIVED BY THE EVALUATOR versus SUPPLIED BY THE CALLER.
 */
export const FORBIDDEN_EVALUATION_KEYS: readonly string[] = [
  "verified", "independentlyVerified", "trusted", "trust", "authority",
  "authoritative", "truth", "truthScore", "probability",
  "approved", "capabilities", "capability", "grant", "grants",
  "bypass", "policy", "risk", "allowedScope",
  "path", "paths", "projectIds", "projects", "crossProject", "allProjects",
  "weights", "formula", "evaluator",
] as const;

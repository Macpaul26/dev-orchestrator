import { z } from "zod";
import { ExperienceId } from "./experienceStorage.js";
import { EvaluationStatus, EvaluationStopReason } from "./experienceEvaluation.js";
import { RetrievalStopReason } from "./experienceRetrieval.js";

/**
 * THE HISTORICAL SIGNAL - WHAT LEARNING IS ALLOWED TO TELL REASONING
 *
 * Task 012 is the first controlled connection between the learning layer and
 * the reasoning layer. This file is the whole of what may cross it.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT
 * ---------------------------------------------------------------------------
 *     LEARNING  ->  REASONING
 *     LEARNING  -/->  AUTHORITY
 *
 * An evaluated experience may inform what the model proposes. It may never
 * approve a task or a plan, grant or modify a capability, widen a scope, lower
 * a risk classification, disable a check, or bypass a human, an inspection or
 * a verification. Nothing in this file has a field that could carry any of
 * those, and `.strict()` refuses one that tries.
 *
 *     relevance  !=  confidence
 *     confidence !=  authority
 *     historical success  !=  guaranteed future success
 *
 * ---------------------------------------------------------------------------
 * A PROJECTION, NOT A RECORD
 * ---------------------------------------------------------------------------
 * The stored `EpisodicExperience` holds free text from a real run: plan
 * summaries, failure narratives, evidence references, run identifiers, the
 * sources that backed it. None of that is here. What crosses is the task type,
 * a bounded handful of normalized approaches, and the EVALUATION - the counts
 * and the status Task 011 derived from independent evidence. The model learns
 * that an approach was independently corroborated or contradicted; it does not
 * receive the narrative that a previous agent wrote about itself.
 */

/** Hard ceilings. Not configurable - editing this file is the only way past. */
export const HISTORICAL_SIGNAL_LIMITS = {
  /** Query characters derived from the task. The tokenizer keeps 32 terms. */
  maxQueryChars: 1_000,
  /** Retrieved candidates considered. Retrieval itself caps at this too. */
  maxRetrieved: 10,
  /** Candidates evaluated. Evaluation is bounded work; ten is plenty. */
  maxEvaluated: 10,
  /** Items that may reach the context. Independently enforced by Task 007. */
  maxPresented: 5,
  /** Characters one presented item may occupy in the context. */
  maxItemChars: 600,
  /** Characters all presented items may occupy together. */
  maxTotalChars: 2_400,
  /** Approaches shown per item. */
  maxApproachesPerItem: 3,
  /** Characters kept of each approach. */
  maxApproachChars: 120,
  /** Characters kept of the task type. */
  maxTaskTypeChars: 100,
} as const;

/**
 * ONE PRESENTED EXPERIENCE.
 *
 * Every field is either an identifier, a bounded label, or a number the
 * evaluator derived. The three "trust-shaped" facts - how many independent
 * records supported, how many contradicted, and the resulting status - travel
 * as COUNTS AND A CATEGORY, so the model is told what the evidence was rather
 * than told what to conclude from it.
 */
export const HistoricalItem = z.object({
  experienceId: ExperienceId,
  taskType: z.string().min(1).max(HISTORICAL_SIGNAL_LIMITS.maxTaskTypeChars),
  approaches: z.array(z.string().min(1).max(HISTORICAL_SIGNAL_LIMITS.maxApproachChars))
    .max(HISTORICAL_SIGNAL_LIMITS.maxApproachesPerItem),
  /**
   * Task 011's verdict, carried verbatim. `insufficient_evidence` cannot appear
   * here - see `SELECTION_POLICY` - but the type is the evaluator's own so a
   * future change to that policy is a visible edit rather than a new enum.
   */
  status: EvaluationStatus,
  /** Present only when the evaluator assessed a score. Never invented. */
  confidence: z.number().int().min(0).max(100).nullable(),
  supporting: z.number().int().nonnegative(),
  contradicting: z.number().int().nonnegative(),
  /** Records that had an outcome but no independent backing. Reported, unvoted. */
  inadmissible: z.number().int().nonnegative(),
  /** Whether the evaluator examined the whole project or stopped at a bound. */
  evaluationBounded: z.boolean(),
}).strict();
export type HistoricalItem = z.infer<typeof HistoricalItem>;

/**
 * WHY A RETRIEVED CANDIDATE WAS NOT PRESENTED.
 *
 * Each reason is reported as a count so that "the model saw three experiences"
 * and "the model saw the three experiences that exist" remain different facts.
 */
export const OmissionReason = z.enum([
  /** Task 011 found no independent evidence either way. See SELECTION_POLICY. */
  "insufficient_evidence",
  /** The evaluator refused the candidate - defective, missing, or a storage error. */
  "evaluation_failed",
  /** `maxPresented` was reached. */
  "presentation_limit",
  /** `maxTotalChars` would have been exceeded. */
  "size_limit",
  /** `maxEvaluated` was reached before this candidate. */
  "evaluation_limit",
  /**
   * Rendered identically to an item already presented. The same pattern with
   * the same evaluation, stated once, is one fact; stated four times it is the
   * same fact taking four slots and four times the budget. Task 007 would
   * collapse the copies anyway, and then `presented` would overstate what the
   * model saw - so the builder collapses them first and says so.
   */
  "duplicate",
]);
export type OmissionReason = z.infer<typeof OmissionReason>;

/**
 * THE SIGNAL, AS A DISCRIMINATED UNION OF DISTINGUISHABLE STATES.
 *
 * ---------------------------------------------------------------------------
 * "COULD NOT LOOK" IS NEVER "NOTHING THERE"
 * ---------------------------------------------------------------------------
 * The states below are kept apart because collapsing any two of them lies to
 * the model or the human at the gate:
 *
 *   unavailable   history could not be inspected. No store, or storage or
 *                 retrieval failed. The reasoning path proceeds WITHOUT
 *                 historical adaptation, exactly as it did before Task 012,
 *                 and says so. Never reported as "no relevant history".
 *
 *   none          history WAS inspected, completely, and nothing matched.
 *
 *   present       at least one candidate was retrieved. `items` holds what was
 *                 admitted; `omitted` holds, by reason, what was not. Both
 *                 coverage fields say whether the look was complete. `items`
 *                 may be EMPTY - every candidate omitted for insufficient
 *                 evidence is a real and common outcome, and it is not `none`.
 */
export const HistoricalSignal = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["no_store", "retrieval_failed", "storage_failed"]),
  }).strict(),
  z.object({
    kind: z.literal("none"),
    retrievalBounded: z.boolean(),
    retrievalStop: RetrievalStopReason.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("present"),
    items: z.array(HistoricalItem).max(HISTORICAL_SIGNAL_LIMITS.maxPresented),
    /** Candidates retrieval returned, before evaluation and selection. */
    retrieved: z.number().int().nonnegative().max(HISTORICAL_SIGNAL_LIMITS.maxRetrieved),
    evaluated: z.number().int().nonnegative().max(HISTORICAL_SIGNAL_LIMITS.maxEvaluated),
    omitted: z.partialRecord(OmissionReason, z.number().int().nonnegative()),
    retrievalBounded: z.boolean(),
    retrievalStop: RetrievalStopReason.nullable(),
    /** How many presented items had a bounded evaluation. */
    evaluationsBounded: z.number().int().nonnegative(),
    evaluationStops: z.array(EvaluationStopReason).max(HISTORICAL_SIGNAL_LIMITS.maxPresented),
    totalChars: z.number().int().nonnegative().max(HISTORICAL_SIGNAL_LIMITS.maxTotalChars),
  }).strict(),
]);
export type HistoricalSignal = z.infer<typeof HistoricalSignal>;

/**
 * THE SELECTION POLICY, STATED ONCE.
 *
 * A retrieved candidate is presented to reasoning if and only if Task 011
 * ASSESSED it - that is, at least one independently-backed record voted on
 * the pattern, so the confidence has a `score`. A candidate the evaluator
 * reports as `insufficient_evidence` is omitted and counted.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS AND NOT A SCORE THRESHOLD
 * ---------------------------------------------------------------------------
 * The gate is STRUCTURAL, not numeric: "did independent evidence exist?"
 * rather than "was the number big enough?". That matters for two reasons.
 *
 * First, it closes the injection path directly. An agent that plants a
 * self-serving record can get it retrieved - retrieval is lexical - but it
 * cannot get it PRESENTED, because nothing independent of the agent backs it
 * and the evaluator says so. Task 010 relevance is not a way in.
 *
 * Second, a numeric cutoff would be a policy assumption dressed as a boundary,
 * and Task 011 already established that no experience corpus exists to
 * calibrate one against. "Evidence exists or it does not" needs no
 * calibration. `contradicted` experiences are presented for the same reason
 * `supported` ones are: an approach that independently failed before is
 * exactly what a proposal should know about.
 *
 * THIS IS A POLICY ASSUMPTION, NOT AN EMPIRICAL RESULT. Nobody has measured
 * whether presenting evaluated history improves proposals; there is no corpus
 * to measure it on. It is recorded as the documented policy and nothing more.
 */
export const SELECTION_POLICY = {
  present: "assessed_only",
  omit: "insufficient_evidence",
} as const;

/**
 * A bounded summary for durable workflow state and the human gate.
 *
 * Counts, categories and reasons. Never the items, never an approach, never
 * text from a record - the checkpoint must not become a second copy of
 * project experience with a different lifetime.
 */
export const HistoricalSignalSummary = z.object({
  kind: z.enum(["unavailable", "none", "present"]),
  reason: z.string().max(40).nullable().default(null),
  retrieved: z.number().int().nonnegative().default(0),
  evaluated: z.number().int().nonnegative().default(0),
  presented: z.number().int().nonnegative().default(0),
  omitted: z.partialRecord(OmissionReason, z.number().int().nonnegative()).default(() => ({})),
  retrievalBounded: z.boolean().default(false),
  evaluationsBounded: z.number().int().nonnegative().default(0),
}).strict();
export type HistoricalSignalSummary = z.infer<typeof HistoricalSignalSummary>;

export function summariseHistoricalSignal(signal: HistoricalSignal): HistoricalSignalSummary {
  switch (signal.kind) {
    case "unavailable":
      return HistoricalSignalSummary.parse({ kind: "unavailable", reason: signal.reason });
    case "none":
      return HistoricalSignalSummary.parse({
        kind: "none",
        reason: signal.retrievalStop,
        retrievalBounded: signal.retrievalBounded,
      });
    case "present":
      return HistoricalSignalSummary.parse({
        kind: "present",
        reason: signal.retrievalStop,
        retrieved: signal.retrieved,
        evaluated: signal.evaluated,
        presented: signal.items.length,
        omitted: signal.omitted,
        retrievalBounded: signal.retrievalBounded,
        evaluationsBounded: signal.evaluationsBounded,
      });
  }
}

/**
 * Field names that would mean authority if the signal ever carried them.
 *
 * Asserted against the parsed shapes by a test, so adding one becomes a
 * visible, reviewable act. These are the words a "helpful" change would reach
 * for first, and the reason each is forbidden is the same: a historical signal
 * describes the past and may not instruct the present.
 */
export const FORBIDDEN_SIGNAL_KEYS: readonly string[] = [
  "approved", "approve", "trusted", "trust", "authorized", "authorised",
  "allowed", "allow", "grant", "grants", "capability", "capabilities",
  "bypassChecks", "skipVerification", "verificationRequired", "scope",
  "allowedScope", "risk", "highestRisk", "policy", "instruction",
  "recommendation", "strategy", "execute",
  // Content that must not cross.
  "planSummary", "failures", "corrections", "evidence", "sources", "runId",
  "narrative", "summary", "diff", "content", "path", "paths",
] as const;

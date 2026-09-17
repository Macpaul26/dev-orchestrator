import { z } from "zod";
import {
  HistoricalItem, HISTORICAL_SIGNAL_LIMITS, OmissionReason,
  type OmissionReason as TOmissionReason,
} from "./historicalSignal.js";
import { RetrievalStopReason } from "./experienceRetrieval.js";

/**
 * THE STRATEGY PROPOSAL - WHAT LEARNING MAY SUGGEST, AND CANNOT REQUIRE
 *
 * Task 012 lets evaluated history INFORM reasoning, item by item. Task 013
 * aggregates those items into one bounded, structured statement about the
 * project's independently-supported history for this task: a POSTURE, with
 * the evidence behind it kept visible.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT
 * ---------------------------------------------------------------------------
 *     LEARNING  ->  REASONING
 *     LEARNING  -/->  AUTHORITY
 *
 * A strategy proposal is input to reasoning. It cannot approve a plan or an
 * implementation, create or widen a grant, add a capability, reduce or widen a
 * scope, lower a risk, skip a check, alter a policy, change another project,
 * or execute anything. Nothing in this file has a field that could carry any
 * of those, and `.strict()` refuses one that tries. A historical success is
 * evidence about the past; it is not permission for the future.
 *
 * ---------------------------------------------------------------------------
 * DERIVED FROM THE SIGNAL, AND FROM NOTHING ELSE
 * ---------------------------------------------------------------------------
 * The strategy layer's ONLY input is the Task 012 `HistoricalSignal`. It holds
 * no store, no retrieval, no evaluator. That is the whole of its safety case:
 * the signal already contains no text derived from any record - only digests,
 * enums and counts - so there is nothing here that could forward historical
 * prose, cross a project boundary, or admit inadmissible evidence. Those
 * properties are inherited structurally, not re-implemented.
 *
 *     relevance != confidence
 *     confidence != authority
 *     historical success != guaranteed future success
 *     a posture != a recommendation
 */

/** Hard ceilings. Not configurable - editing this file is the only way past. */
export const STRATEGY_LIMITS = {
  /** Patterns a proposal may carry. Equal to Task 012's presentation cap. */
  maxPatterns: HISTORICAL_SIGNAL_LIMITS.maxPresented,
  /** Characters the rendered proposal may occupy in the context. */
  maxRenderedChars: 900,
} as const;

/**
 * WHY A PROPOSAL'S VIEW OF THE EVIDENCE IS INCOMPLETE.
 *
 * ---------------------------------------------------------------------------
 * CORRECTED AFTER INDEPENDENT REVIEW
 * ---------------------------------------------------------------------------
 * The first version derived `bounded` from the signal's SCAN bounds only -
 * whether retrieval or evaluation stopped early. It ignored that the signal
 * is itself a bounded PROJECTION: Task 012 presents at most `maxPresented`
 * items and omits assessed candidates beyond that cap, or beyond the size and
 * evaluation caps. So this state was possible and reported as complete:
 *
 *     retrieval complete, evaluation complete, five items presented,
 *     a sixth ASSESSED candidate omitted for presentation_limit
 *
 * A posture over five of six is a bounded posture. Worse, the sixth could have
 * been the only contradiction. "No contradiction was observed in the presented
 * subset" and "no contradiction exists" are different claims, and only the
 * bound flag keeps them apart.
 *
 * ---------------------------------------------------------------------------
 * NOT EVERY OMISSION IS A BOUND
 * ---------------------------------------------------------------------------
 * The classification follows the builder's own ordering, not a guess:
 *
 *   presentation_limit   emitted AFTER the insufficient-evidence check, so the
 *                        omitted candidate was assessed. Evidence lost. A CAP.
 *   size_limit           assessed, item built, dropped for size. A CAP.
 *   evaluation_limit     never evaluated at all. Unknown evidence. A CAP.
 *
 *   insufficient_evidence  fully considered; nothing assessable. Nothing that
 *                          could have entered a posture was lost. NOT a cap.
 *   duplicate              the same fact, already represented. NOT a cap.
 *   evaluation_failed      refused as corrupt or unreadable - not evidence at
 *                          all by Task 009 and 011's rules. NOT a cap, but a
 *                          distinct fact, carried as `refused` so the human
 *                          can see relevant candidates that could not be read.
 *
 * Writing `bounded = omitted is non-empty` would have relabelled all six as a
 * resource bound and thrown away distinctions Task 012 was built to keep.
 */
export const BoundReason = z.enum([
  /** Task 010 could not enumerate the project completely. */
  "retrieval_scan",
  /** At least one presented evaluation stopped at a Task 011 bound. */
  "evaluation_scan",
  /** Assessed candidates were dropped at Task 012's presentation cap. */
  "presentation_limit",
  /** Assessed candidates were dropped at Task 012's size cap. */
  "size_limit",
  /** Candidates were never evaluated because Task 012's evaluation cap was hit. */
  "evaluation_limit",
]);
export type BoundReason = z.infer<typeof BoundReason>;

/**
 * The omission reasons that mean assessed or assessable evidence was lost.
 *
 * Typed as the INTERSECTION of the omission and bound vocabularies: a capping
 * omission is, by definition, an omission that is also a reason the view is
 * incomplete. The compiler enforces that nothing else can be listed here.
 */
export const CAPPING_OMISSIONS: readonly Extract<TOmissionReason, BoundReason>[] = [
  "presentation_limit", "size_limit", "evaluation_limit",
] as const;

/**
 * THE POSTURE - what the evaluated history, taken together, looks like.
 *
 *   established   at least one relevant pattern was independently supported
 *                 and NONE was independently contradicted
 *   cautionary    at least one was independently contradicted and NONE
 *                 supported
 *   contested     both: supported AND contradicted patterns exist. The
 *                 contradiction is not averaged away; it is the posture.
 *   inconclusive  only `uncertain` patterns - evidence existed but split
 *
 * A posture is a CATEGORY OF EVIDENCE, not an instruction. "established" means
 * the record shows corroboration and no contradiction; it does not mean "do
 * it again". The vocabulary was chosen so that no member reads as a verb.
 */
export const StrategyPosture = z.enum([
  "established", "cautionary", "contested", "inconclusive",
]);
export type StrategyPosture = z.infer<typeof StrategyPosture>;

/**
 * THE PROPOSAL, AS A UNION OF DISTINGUISHABLE STATES.
 *
 * Mirrors the signal's states so nothing collapses on the way through:
 *
 *   unavailable   the signal was unavailable; history could not be inspected.
 *   none          history was inspected and nothing relevant was found.
 *   insufficient  relevant history exists but nothing in it was independently
 *                 assessed, so there is no evidence to take a posture on.
 *   proposal      a posture, the patterns behind it, and the counts.
 *
 * Each pattern is a Task 012 `HistoricalItem`, reused unchanged - the same
 * digests, enums and counts, and nothing else. The proposal adds no field of
 * its own that could hold text.
 */
export const StrategyProposal = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["no_store", "retrieval_failed", "storage_failed"]),
  }).strict(),
  z.object({
    kind: z.literal("none"),
    retrievalBounded: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("insufficient"),
    /** Relevant candidates that were retrieved but not independently assessed. */
    unassessed: z.number().int().nonnegative(),
    retrievalBounded: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("proposal"),
    posture: StrategyPosture,
    /** Ordered by the documented total order. Never longer than `maxPatterns`. */
    patterns: z.array(HistoricalItem).max(STRATEGY_LIMITS.maxPatterns),
    /** Pattern counts by evaluated status. Contradiction is always visible. */
    supported: z.number().int().nonnegative(),
    contradicted: z.number().int().nonnegative(),
    uncertain: z.number().int().nonnegative(),
    /** Sum of independent votes across the patterns. Volume, not truth. */
    supportingVotes: z.number().int().nonnegative(),
    contradictingVotes: z.number().int().nonnegative(),
    /**
     * True when the evidence this proposal was derived from is an INCOMPLETE
     * view - any scan bound OR any capping omission upstream. Never hidden.
     * When true, `supported`/`contradicted`/`uncertain` describe the received
     * subset and must not be read as facts about the whole project.
     */
    bounded: z.boolean(),
    /** Every reason the view is incomplete. Empty exactly when `bounded` is false. */
    boundedBy: z.array(BoundReason).max(5),
    retrievalStop: RetrievalStopReason.nullable(),
    evaluationsBounded: z.number().int().nonnegative(),
    /**
     * Relevant candidates the evaluator refused - corrupt, missing, unreadable.
     * Not evidence, and not a bound; a distinct fact for the human.
     */
    refused: z.number().int().nonnegative(),
    /** What the signal omitted and why, carried forward unchanged. */
    omitted: z.partialRecord(OmissionReason, z.number().int().nonnegative()),
  }).strict(),
]);
export type StrategyProposal = z.infer<typeof StrategyProposal>;

/**
 * THE DERIVATION POLICY, STATED ONCE.
 *
 * Posture is decided by the presence of independently supported and
 * independently contradicted patterns, in that order of precedence:
 *
 *   contradicted > 0 and supported > 0   ->  contested
 *   contradicted > 0                     ->  cautionary
 *   supported > 0                        ->  established
 *   otherwise (uncertain only)           ->  inconclusive
 *
 * Contradiction is checked FIRST so that repeated success can never erase an
 * independently supported failure: ten supported patterns and one contradicted
 * one is `contested`, not `established`. A pattern's status comes from Task
 * 011 verbatim; no second confidence formula exists here, and no threshold is
 * applied beyond the one Task 011 already documents as unvalidated.
 *
 * THIS IS A POLICY ASSUMPTION, NOT AN EMPIRICAL RESULT. Nobody has measured
 * whether a posture improves proposals. No corpus exists to measure it on.
 */
export const DERIVATION_POLICY = {
  precedence: ["contested", "cautionary", "established", "inconclusive"],
  contradictionFirst: true,
} as const;

/** Bounded summary for durable state and the human gate. Never the patterns. */
export const StrategySummary = z.object({
  kind: z.enum(["unavailable", "none", "insufficient", "proposal"]),
  posture: StrategyPosture.nullable().default(null),
  patterns: z.number().int().nonnegative().default(0),
  supported: z.number().int().nonnegative().default(0),
  contradicted: z.number().int().nonnegative().default(0),
  uncertain: z.number().int().nonnegative().default(0),
  bounded: z.boolean().default(false),
  boundedBy: z.array(BoundReason).max(5).default([]),
  refused: z.number().int().nonnegative().default(0),
}).strict();
export type StrategySummary = z.infer<typeof StrategySummary>;

export function summariseStrategy(proposal: StrategyProposal): StrategySummary {
  switch (proposal.kind) {
    case "unavailable":
      return StrategySummary.parse({ kind: "unavailable" });
    case "none":
      return StrategySummary.parse({ kind: "none", bounded: proposal.retrievalBounded });
    case "insufficient":
      return StrategySummary.parse({ kind: "insufficient", bounded: proposal.retrievalBounded });
    case "proposal":
      return StrategySummary.parse({
        kind: "proposal",
        posture: proposal.posture,
        patterns: proposal.patterns.length,
        supported: proposal.supported,
        contradicted: proposal.contradicted,
        uncertain: proposal.uncertain,
        bounded: proposal.bounded,
        boundedBy: proposal.boundedBy,
        refused: proposal.refused,
      });
  }
}

/**
 * Field names that would mean authority, or carry text, if a proposal ever
 * accepted them.
 *
 * Shape protection only, as with `FORBIDDEN_SIGNAL_KEYS`: a field with one of
 * these names cannot appear. Content safety comes from there being no free-text
 * field at all - every string in a proposal is an enum member or, inside a
 * pattern, a fixed-width hex digest.
 */
export const FORBIDDEN_STRATEGY_KEYS: readonly string[] = [
  // Authority.
  "approved", "approve", "approval", "authorized", "authorised", "authority",
  "trusted", "trust", "allowed", "allow", "permitted", "grant", "grants",
  "capability", "capabilities", "scope", "allowedScope", "widenScope",
  "risk", "highestRisk", "policy", "checkPolicy", "bypass", "bypassChecks",
  "skipVerification", "verificationRequired", "execute", "run", "apply",
  "override", "instruction", "recommendation", "recommended", "mustUse",
  "alwaysUse", "safe", "verified", "confidenceOverride",
  // Text carriers.
  "approaches", "approach", "taskType", "text", "description", "label",
  "name", "summary", "narrative", "planSummary", "pattern", "strategyText",
] as const;

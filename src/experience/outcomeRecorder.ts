import {
  EpisodicExperience, EXPERIENCE_LIMITS,
  type EpisodicExperience as TEpisodicExperience,
  type OutcomeSource,
} from "../domain/experience.js";
import type { VerificationOutcome } from "../domain/verification.js";
import type { ReviewReport } from "../domain/reports.js";
import { isBlocking } from "../domain/verification.js";
import type { ExperienceStore } from "./experienceStore.js";

/**
 * LEARNING FROM AN ITERATION'S OUTCOME (Task 014)
 *
 * ---------------------------------------------------------------------------
 * THE FIRST PRODUCER OF EXPERIENCE - AND WHAT IT IS ALLOWED TO SAY
 * ---------------------------------------------------------------------------
 * Tasks 009-013 built a store, retrieval, evaluation, a signal and a strategy,
 * and nothing in the workflow ever wrote a record. This is the producer. It
 * runs AFTER the human's review decision, once per iteration, and it writes
 * what the ORCHESTRATOR established:
 *
 *   planSummary            the plan a human approved (already in the run record)
 *   implementationOutcome  the verification verdict and observed counts
 *   verificationOutcome    what the checks did, from the check run
 *   reviewOutcome          the review verdict and the human's decision kind
 *   failures               the review's blocking findings, as trusted code wrote them
 *   successfulPatterns     the approved plan's steps, when the human approved
 *   failedPatterns         the approved plan's steps, when verification blocked,
 *                          the review withheld "pass", or the human rejected
 *   sources                derived from which trusted facts exist - never asserted
 *
 * NOT WRITTEN, BY CONSTRUCTION: anything the agent said. `claimedSummary`,
 * `claimedFiles` and `claimsSuccess` have no field here and are not read.
 * `AGENT_CLAIM` never appears in `sources`. A record whose evidence is an
 * agent's word would be inadmissible downstream anyway (Task 011), and the
 * cleanest way to keep it inadmissible is not to write it.
 *
 * ---------------------------------------------------------------------------
 * LEARNING -> REASONING. LEARNING -/-> AUTHORITY.
 * ---------------------------------------------------------------------------
 * The record reaches the next run's reasoning through Tasks 010-013 - as
 * digests and counts at ranks 20 and 15, below everything a human said. It
 * reaches nothing else. This module has no handle on a grant, an approval, a
 * scope, a limit or a policy, and the store it writes to is read by exactly one
 * consumer: the historical-signal builder in the plan node.
 *
 * A write that fails - quota, lock, corruption - is REPORTED, not retried and
 * not fatal. The loop's stop decision does not depend on whether learning
 * succeeded, so learning cannot become a lever on it.
 */

/**
 * THE LEARNING LAYER DOES NOT IMPORT THE APPROVAL DOMAIN.
 *
 * A guard in the test suite forbids any module under src/experience from
 * importing the approval, grant or capability domains, and it fired on the
 * first version of this file, which imported the plan and decision-kind
 * TYPES. The types were harmless; the dependency was not the right shape. So the inputs below are PLAIN SHAPES: what a plan's text
 * looks like and which of four words a human said. The caller (the learn
 * node, trusted graph code) projects the real objects onto them. The learning
 * layer therefore still has no handle on an approval, a decision, a grant or
 * a scope - only on the strings it is allowed to remember.
 */
export interface ApprovedPlanShape {
  summary: string;
  steps: readonly { description: string }[];
}

export type ReviewDecisionKind = "approve" | "edit" | "reject" | "feedback";

export interface IterationOutcomeInput {
  projectId: string;
  /** The ITERATION id, not the run id: one record per iteration. */
  iterationId: string;
  taskType: string;
  approvedPlan: ApprovedPlanShape | null;
  verification: VerificationOutcome | null;
  review: ReviewReport | null;
  reviewDecision: ReviewDecisionKind | null;
  /** The number of trusted blockers to completion; the reasons live elsewhere. */
  completionBlockers: number;
  now: string;
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** A candidate record. Pure; validated by the store's own schema on write. */
export function experienceFromIteration(input: IterationOutcomeInput): TEpisodicExperience {
  const v = input.verification;
  const r = input.review;

  const sources: OutcomeSource[] = [];
  if (v?.independentlyVerified) sources.push("REPOSITORY_OBSERVATION");
  if (v?.checks.run.attempted) sources.push("VERIFICATION_RESULT");
  if (v?.process) sources.push("PROCESS_OBSERVATION");
  if (r) sources.push("REVIEW_FINDING");
  if (input.reviewDecision) sources.push("HUMAN_DECISION");

  const steps = (input.approvedPlan?.steps ?? [])
    .map((s) => clip(s.description.trim(), EXPERIENCE_LIMITS.maxItemLength))
    .filter((s) => s.length > 0)
    .slice(0, EXPERIENCE_LIMITS.maxPatterns);

  const verificationBlocked = v ? isBlocking(v.verdict) : true;
  const checksFailed = (v?.checks.run.attempted ?? false) && !(v?.checks.allPassed ?? false);
  const reviewWithheld = r ? r.verdict !== "pass" : true;
  const humanApproved = input.reviewDecision === "approve";
  const humanRejected = input.reviewDecision === "reject";

  // A pattern SUCCEEDED only when the human approved AND nothing trusted
  // contradicts it. It FAILED when something trusted said so, or the human
  // rejected. A human asking for changes on a clean iteration is neither: the
  // work was not wrong, it was not enough - no pattern verdict is recorded.
  const succeeded = humanApproved && !verificationBlocked && !checksFailed && !reviewWithheld;
  const failed = humanRejected || verificationBlocked || checksFailed || reviewWithheld;

  const failures = (r?.findings ?? [])
    .filter((f) => f.severity === "blocker")
    .map((f) => clip(`${f.message}${f.file ? ` [${f.file}]` : ""}`, EXPERIENCE_LIMITS.maxItemLength))
    .slice(0, EXPERIENCE_LIMITS.maxFailures);

  return EpisodicExperience.parse({
    scope: "project",
    layer: "episodic",
    projectId: input.projectId,
    runId: input.iterationId,
    taskType: clip(input.taskType, EXPERIENCE_LIMITS.maxTaskTypeLength),
    planSummary: clip(input.approvedPlan?.summary ?? "", EXPERIENCE_LIMITS.maxSummaryLength),
    implementationOutcome: v
      ? clip(
          `verification ${v.verdict}; independently verified: ${String(v.independentlyVerified)}; ` +
          `observed ${String(v.observation.changedFiles.length)} changed file(s)`,
          EXPERIENCE_LIMITS.maxSummaryLength,
        )
      : "no verification outcome",
    verificationOutcome: v
      ? clip(
          v.checks.run.attempted
            ? `${String(v.checks.executed)} check(s) executed; all passed: ${String(v.checks.allPassed)}`
            : `no check executed: ${v.checks.run.notRunReason ?? "not recorded"}`,
          EXPERIENCE_LIMITS.maxSummaryLength,
        )
      : "no verification outcome",
    reviewOutcome: clip(
      `review ${r?.verdict ?? "absent"}; human decision: ${input.reviewDecision ?? "none"}; ` +
      `blockers to completion: ${String(input.completionBlockers)}`,
      EXPERIENCE_LIMITS.maxSummaryLength,
    ),
    failures,
    corrections: [],
    successfulPatterns: succeeded ? steps : [],
    failedPatterns: failed ? steps : [],
    evidence: [],
    sources,
    status: "candidate",
    createdAt: input.now,
  });
}

export interface ExperienceRecording {
  recorded: boolean;
  experienceId: string | null;
  reason: string | null;
}

/** Write the iteration's record. Never throws; the outcome is reported. */
export function recordIterationExperience(
  store: ExperienceStore | null,
  input: IterationOutcomeInput,
): ExperienceRecording {
  if (!store) return { recorded: false, experienceId: null, reason: "no_store" };
  let candidate: TEpisodicExperience;
  try {
    candidate = experienceFromIteration(input);
  } catch (error) {
    return {
      recorded: false, experienceId: null,
      reason: `candidate_invalid: ${error instanceof Error ? error.name : "unknown"}`,
    };
  }
  try {
    const result = store.write(input.projectId, candidate);
    if (result.ok) return { recorded: true, experienceId: result.id, reason: null };
    return { recorded: false, experienceId: null, reason: result.failure.code };
  } catch (error) {
    return {
      recorded: false, experienceId: null,
      reason: `store_threw: ${error instanceof Error ? error.name : "unknown"}`,
    };
  }
}

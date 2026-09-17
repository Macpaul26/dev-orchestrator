import { z } from "zod";
import crypto from "node:crypto";
import { Plan, HumanDecisionKind, type Plan as TPlan } from "./approval.js";
import { VerificationOutcome, isBlocking } from "./verification.js";
import { ReviewReport } from "./reports.js";

/**
 * BOUNDED AUTONOMOUS ITERATION (Task 014)
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DECIDES, AND WHAT IT CANNOT
 * ---------------------------------------------------------------------------
 * The workflow may now repeat: implement, verify, review, and - when a human
 * asks for changes at the review gate - plan again and go round. This module
 * owns three things about that repetition:
 *
 *   1. the IDENTITY of an iteration, so every approval, grant, verification
 *      and review can be read back against exactly the attempt it belongs to;
 *   2. the BOUND on how many iterations one run may perform, owned by trusted
 *      configuration and unreachable from any model output;
 *   3. the STOP DECISION - a pure function over trusted state that says whether
 *      another iteration is legally reachable, and if not, why.
 *
 * It decides nothing about AUTHORITY. It cannot approve a plan, approve a
 * review, mint a grant, widen a scope or lower a risk. A human decision is an
 * INPUT here, never an output: `decideNextIteration` reads the kind of decision
 * a person already made and tells the graph which edge that leaves open.
 *
 *     THE ORCHESTRATOR MAY REPEAT THE PROCESS.
 *     IT MAY NOT REPEAT THE HUMAN.
 *
 * ---------------------------------------------------------------------------
 * COMPLETION IS OBSERVATIONAL
 * ---------------------------------------------------------------------------
 * `assessCompletion` reads the verification outcome, the review report and the
 * scope evidence - things trusted code observed - and lists what still stands
 * in the way. It never reads what the agent said. "Claude says done" is not an
 * input to this module and has no field it could arrive through.
 */

/** Trusted configuration. Editing this file is the only way past the ceiling. */
export const ITERATION_LIMITS = {
  /** Iterations per run when the operator configures nothing. */
  defaultMaxIterations: 3,
  /** No configuration may exceed this. */
  ceiling: 10,
} as const;

/**
 * A validated iteration limit. `.int()` rejects Infinity and NaN; `.max()`
 * means a configuration file cannot smuggle a million past the schema.
 */
export const IterationLimit = z.number().int().min(1).max(ITERATION_LIMITS.ceiling);
export type IterationLimit = z.infer<typeof IterationLimit>;

/**
 * Resolve the limit from trusted configuration. Throws on an invalid value -
 * a misconfigured bound is an operator error to surface, not to round down.
 */
export function resolveIterationLimit(configured: unknown): IterationLimit {
  if (configured === undefined || configured === null) return ITERATION_LIMITS.defaultMaxIterations;
  return IterationLimit.parse(configured);
}

/** Deterministic: derived, never random, so a replayed node yields the same id. */
export function iterationIdFor(runId: string, iteration: number): string {
  return `${runId}_it${String(iteration)}`;
}

/**
 * WHY A RUN STOPPED. The closed vocabulary the graph may record.
 *
 *   human_approved            the human approved the review. The only path
 *                             to an "approved" outcome.
 *   human_rejected            the human rejected at either gate.
 *   safety_stop               trusted verification observed a condition under
 *                             which another autonomous iteration is unsafe.
 *   iteration_limit_reached   the human asked for changes, but the bound is
 *                             exhausted. Incomplete, and visibly so.
 */
export const StopReason = z.enum([
  "human_approved", "human_rejected", "safety_stop", "iteration_limit_reached",
]);
export type StopReason = z.infer<typeof StopReason>;

/**
 * Conditions under which the orchestrator will not start another iteration on
 * its own, whatever the human asked for at the review gate. Each is something
 * VERIFICATION OBSERVED about the control environment, not about code quality:
 * a failing test is a reason to iterate; a rewritten check policy is a reason
 * to stop and let a person look.
 */
export const SafetyCondition = z.enum([
  /** Git was used and no granted capability authorised it. */
  "unauthorised_git_mutation",
  /** The check definitions changed while the agent could write. */
  "check_policy_changed",
  /** A verification executable was not the program trusted before the run. */
  "check_integrity_blocked",
  /** The checks themselves changed the repository. */
  "checks_changed_repository",
  /** A change landed outside the approved scope. */
  "scope_drift",
  /** The repository could not be inspected; iterating blind is refused. */
  "inspection_unavailable",
]);
export type SafetyCondition = z.infer<typeof SafetyCondition>;

/** Derive the safety conditions from the trusted verification outcome only. */
export function detectSafetyConditions(
  verification: VerificationOutcome | null,
  scopeDrift: readonly string[],
): SafetyCondition[] {
  const found: SafetyCondition[] = [];
  if (!verification || !verification.observation.inspected) {
    found.push("inspection_unavailable");
  }
  if (verification) {
    const gitMutation = verification.observation.gitMutation;
    if (gitMutation.detected && !verification.observation.gitMutationAuthorised) {
      found.push("unauthorised_git_mutation");
    }
    const run = verification.checks.run;
    if (run.policyChangedDuringRun) found.push("check_policy_changed");
    if (run.results.some((r) =>
      r.blockedReason === "executable_integrity_changed"
      || r.blockedReason === "executable_identity_unavailable")) {
      found.push("check_integrity_blocked");
    }
    if (run.repositoryChangedByChecks) found.push("checks_changed_repository");
  }
  if (scopeDrift.length > 0) found.push("scope_drift");
  return found;
}

/**
 * WHAT STILL STANDS BETWEEN THIS ITERATION AND "COMPLETE".
 *
 * Every blocker is a fact trusted code established. An empty list means the
 * evidence is consistent with completion - it is NOT approval, and nothing
 * reads this to approve. The human at the review gate sees it; the loop
 * records it; that is all.
 */
export const CompletionAssessment = z.object({
  /** True only when `blockers` is empty. Redundant on purpose, for readers. */
  evidenceConsistentWithCompletion: z.boolean(),
  blockers: z.array(z.string().min(1)).max(50),
}).strict();
export type CompletionAssessment = z.infer<typeof CompletionAssessment>;

export function assessCompletion(input: {
  verification: VerificationOutcome | null;
  review: ReviewReport | null;
  scopeDrift: readonly string[];
  /** The orchestrator's own record of the attempt. Its status, never the agent's. */
  implementationStatus?: string | null;
}): CompletionAssessment {
  const blockers: string[] = [];
  const v = input.verification;
  if (input.implementationStatus !== undefined && input.implementationStatus !== "completed") {
    blockers.push(`the implementation attempt ended as "${input.implementationStatus ?? "not attempted"}"`);
  }
  if (!v) blockers.push("no verification outcome was produced");
  else {
    if (!v.independentlyVerified) blockers.push("the repository state was not independently verified");
    if (isBlocking(v.verdict)) blockers.push(`verification verdict is "${v.verdict}"`);
    if (v.checks.run.attempted && !v.checks.allPassed) blockers.push("a verification check did not pass");
  }
  if (!input.review) blockers.push("no review report was produced");
  else {
    if (input.review.verdict !== "pass") blockers.push(`review verdict is "${input.review.verdict}"`);
    const blocking = input.review.findings.filter((f) => f.severity === "blocker").length;
    if (blocking > 0) blockers.push(`${String(blocking)} blocking review finding(s)`);
  }
  if (input.scopeDrift.length > 0) blockers.push("changes were observed outside the approved scope");
  for (const condition of detectSafetyConditions(v, input.scopeDrift)) {
    blockers.push(`safety condition: ${condition}`);
  }
  return CompletionAssessment.parse({
    evidenceConsistentWithCompletion: blockers.length === 0,
    blockers: [...new Set(blockers)].slice(0, 50),
  });
}

/**
 * THE LOOP DECISION - where the graph is told which edge is open.
 *
 * Inputs are TRUSTED STATE: the iteration counter and limit the orchestrator
 * owns, the kind of decision a human recorded at the review gate, and the
 * safety conditions verification observed. There is no field for anything the
 * model or the agent said, so there is nothing for them to say.
 *
 * Precedence - SAFETY FIRST, then the human, then the bound:
 *   any safety condition  -> stop, safety_stop        (incomplete, never completed)
 *   no decision recorded  -> stop, safety_stop
 *   approve               -> stop, human_approved     (authority: the human)
 *   reject                -> stop, human_rejected     (authority: the human)
 *   feedback / edit  = changes requested:
 *       iteration < limit -> continue with iteration + 1
 *       otherwise         -> stop, iteration_limit_reached
 *
 * ---------------------------------------------------------------------------
 * CORRECTED AFTER INDEPENDENT REVIEW
 * ---------------------------------------------------------------------------
 * The first version checked the human's decision BEFORE the safety conditions,
 * on the reasoning that a decision is about the iteration that already
 * happened while safety governs the next one. Review found the consequence:
 * verification observes an unauthorised git mutation, the human approves the
 * review, and the run ends COMPLETED / approved - a machine-observed safety
 * violation erased by an approval. That is not what "safety failure = stop"
 * means.
 *
 *     VERIFICATION-OBSERVED SAFETY FAILURE  -/->  COMPLETED
 *
 * So safety is evaluated first. A safety condition is a fact about the
 * control environment - git used without a grant, a rewritten check policy, a
 * swapped verification executable, checks that changed the repository, a
 * write outside the approved scope, a repository that could not be observed -
 * and no decision at the review gate can make it not have happened. The
 * human still controls the review decision and it is still recorded; what an
 * approval can no longer do is turn that iteration into a successful run.
 * The run stops `incomplete`, and a human starts a new one, on a repository
 * they have looked at.
 *
 * This is deliberately NOT "every review finding overrides the human". A
 * failed check, a false claim, a disagreement between what the agent said and
 * what the repository shows - those are review findings about the WORK, they
 * are listed as blockers to completion, and the human may approve over them.
 * The `SafetyCondition` vocabulary is the whole of what overrides, and it is
 * derived only from what verification observed.
 */
export const LoopDecision = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("continue"),
    nextIteration: z.number().int().positive(),
    limit: IterationLimit,
  }).strict(),
  z.object({
    kind: z.literal("stop"),
    reason: StopReason,
    detail: z.string().min(1).max(500),
    /** The human's own decision, when a human made one. */
    decidedBy: z.string().nullable(),
  }).strict(),
]);
export type LoopDecision = z.infer<typeof LoopDecision>;

export function decideNextIteration(input: {
  iteration: number;
  limit: number;
  reviewDecision: { kind: HumanDecisionKind; decidedBy: string } | null;
  safety: readonly SafetyCondition[];
}): LoopDecision {
  const limit = IterationLimit.parse(input.limit);
  const iteration = z.number().int().positive().parse(input.iteration);
  const decision = input.reviewDecision;

  // SAFETY FIRST. Before the decision is even read: an observed safety
  // condition ends the run whatever the human decided, and the detail says so.
  if (input.safety.length > 0) {
    return LoopDecision.parse({
      kind: "stop", reason: "safety_stop", decidedBy: decision?.decidedBy ?? null,
      detail: `verification observed ${input.safety.join(", ")}` +
        (decision ? `; the human's "${decision.kind}" decision is recorded but cannot ` +
          "complete a run whose safety boundary was crossed" : ""),
    });
  }

  // No human decision on record is not permission to do anything.
  if (!decision) {
    return LoopDecision.parse({
      kind: "stop", reason: "safety_stop", decidedBy: null,
      detail: "no human review decision is recorded for this iteration",
    });
  }
  if (decision.kind === "approve") {
    return LoopDecision.parse({
      kind: "stop", reason: "human_approved", decidedBy: decision.decidedBy,
      detail: `the review of iteration ${String(iteration)} was approved by a human`,
    });
  }
  if (decision.kind === "reject") {
    return LoopDecision.parse({
      kind: "stop", reason: "human_rejected", decidedBy: decision.decidedBy,
      detail: `the review of iteration ${String(iteration)} was rejected by a human`,
    });
  }
  // feedback or edit: the human asked for changes.
  if (iteration < limit) {
    return LoopDecision.parse({ kind: "continue", nextIteration: iteration + 1, limit });
  }
  return LoopDecision.parse({
    kind: "stop", reason: "iteration_limit_reached", decidedBy: decision.decidedBy,
    detail: `changes were requested after iteration ${String(iteration)}, but the ` +
      `run's limit of ${String(limit)} iteration(s) is exhausted; a human must start a new run`,
  });
}

// ---------------------------------------------------------------------------
// Approval binding
// ---------------------------------------------------------------------------

/**
 * A CONTENT DIGEST OF WHAT A HUMAN IS ASKED TO APPROVE.
 *
 * An approval id names a gate in a run; the digest names the THING at that
 * gate. Both travel with the request and are recorded against the iteration,
 * so "Plan A was approved" can be checked against Plan A's bytes, and a
 * materially different plan cannot borrow the id of one that was approved.
 * Canonical field order, sorted scope: two plans that authorise the same
 * thing digest the same; two that do not, do not.
 */
export function planDigest(plan: TPlan | null): string {
  if (!plan) return crypto.createHash("sha256").update("no-plan").digest("hex");
  const p = Plan.parse(plan);
  const canonical = JSON.stringify([
    p.summary,
    [...p.steps].sort((a, b) => a.order - b.order).map((s) => [s.order, s.description, s.risk]),
    [...p.allowedScope].sort(),
    p.risks,
    p.highestRisk,
  ]);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The reviewed state, as trusted code observed it: the verdicts, the findings,
 * the observed head commit and files. A later repository state produces a
 * different digest, so a review approval cannot be read as covering it.
 */
export function reviewDigest(
  review: ReviewReport | null,
  verification: VerificationOutcome | null,
  /** The observed diff text, when verification captured one: content, not just names. */
  observedDiff: string | null = null,
): string {
  const r = review ? ReviewReport.parse(review) : null;
  const v = verification ? VerificationOutcome.parse(verification) : null;
  const diffDigest = observedDiff === null
    ? null
    : crypto.createHash("sha256").update(observedDiff, "utf8").digest("hex");
  const canonical = JSON.stringify([
    diffDigest,
    r?.verdict ?? null,
    r?.findings.map((f) => [f.severity, f.message, f.file ?? null]) ?? null,
    [...(r?.scopeDrift ?? [])].sort(),
    v?.verdict ?? null,
    v?.independentlyVerified ?? null,
    v?.observation.inspected ? [
      v.observation.headCommit ?? null,
      [...v.observation.changedFiles].sort(),
      v.observation.gitMutation.detected,
    ] : null,
  ]);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// The per-iteration record
// ---------------------------------------------------------------------------

/**
 * ONE ITERATION, AS THE ORCHESTRATOR SAW IT.
 *
 * Identifiers, digests, verdicts, decision kinds and counts. No plan text, no
 * findings text, no agent narrative - those live in their own channels. This
 * is the index that makes the history legible:
 *
 *   Run R
 *     Iteration 1: plan approval A1 (digest), grant G1, verification V, review
 *                  W, review approval A2 (digest), decision, stop or continue
 *     Iteration 2: ...
 *
 * Keyed by `iterationId`; the state reducer upserts by that key so a record is
 * completed over the course of its iteration and never confused with another.
 */
export const IterationRecord = z.object({
  iteration: z.number().int().positive(),
  iterationId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),

  planApprovalId: z.string().nullable().default(null),
  planDigest: z.string().nullable().default(null),
  planDecision: HumanDecisionKind.nullable().default(null),
  grantId: z.string().nullable().default(null),

  verificationVerdict: z.string().nullable().default(null),
  independentlyVerified: z.boolean().default(false),
  reviewVerdict: z.string().nullable().default(null),
  reviewApprovalId: z.string().nullable().default(null),
  reviewDigest: z.string().nullable().default(null),
  reviewDecision: HumanDecisionKind.nullable().default(null),

  completion: CompletionAssessment.nullable().default(null),
  safety: z.array(SafetyCondition).default([]),
  /** What the learning step did. Recorded even when it recorded nothing. */
  experience: z.object({
    recorded: z.boolean(),
    experienceId: z.string().nullable(),
    reason: z.string().nullable(),
  }).strict().nullable().default(null),
  /** Set when this iteration ended the run, or asked for the next one. */
  loop: LoopDecision.nullable().default(null),
}).strict();
export type IterationRecord = z.infer<typeof IterationRecord>;

/**
 * What a node may contribute to an iteration's record: the identity, plus
 * only the fields it established. A PATCH, deliberately not a parsed record -
 * a parsed record carries defaults for every field it did not mention, and
 * merging one would null out what an earlier node had already written.
 */
export type IterationRecordPatch =
  Pick<IterationRecord, "iteration" | "iterationId"> & Partial<IterationRecord>;

/**
 * Upsert by iteration id. Order is by iteration number, always. The merged
 * result is parsed, so a patch that would make a record invalid throws - the
 * node fails, the run fails closed, and nothing half-written is recorded.
 */
export function mergeIterationRecords(
  prev: readonly IterationRecord[],
  next: readonly IterationRecordPatch[],
): IterationRecord[] {
  const byId = new Map<string, IterationRecord>();
  for (const record of prev) byId.set(record.iterationId, record);
  for (const patch of next) {
    const existing = byId.get(patch.iterationId);
    const startedAt = existing?.startedAt ?? patch.startedAt;
    byId.set(patch.iterationId, IterationRecord.parse({ ...existing, ...patch, startedAt }));
  }
  return [...byId.values()].sort((a, b) => a.iteration - b.iteration);
}

/**
 * Field names that would turn this record into authority if it ever accepted
 * them. Asserted against the parsed shape by a test.
 */
export const FORBIDDEN_ITERATION_KEYS: readonly string[] = [
  "approved", "approve", "complete", "verified", "trusted", "grant", "grants",
  "capabilities", "allowedScope", "scope", "risk", "policy", "skipVerification",
  "maxIterations", "iterationLimit", "limit", "override", "autoApprove",
];

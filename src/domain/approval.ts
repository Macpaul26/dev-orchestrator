import { z } from "zod";
import { RiskLevel } from "./risk.js";

/** Which gate in the workflow is asking. */
export const ApprovalKind = z.enum(["plan", "review", "tool"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

/** A single step the orchestrator proposes to take. */
export const PlanStep = z.object({
  order: z.number().int().nonnegative(),
  description: z.string().min(1),
  risk: RiskLevel,
});
export type PlanStep = z.infer<typeof PlanStep>;

/**
 * A proposed plan. Structured, not prose - which is what makes the `edit`
 * decision meaningful: a human can narrow `allowedScope` before anything runs.
 */
export const Plan = z.object({
  summary: z.string().min(1),
  steps: z.array(PlanStep).default([]),
  /** Paths the implementation is permitted to touch, relative to project root. */
  allowedScope: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  /** Highest risk across all steps. Drives the gate. */
  highestRisk: RiskLevel.default("LOW"),
});
export type Plan = z.infer<typeof Plan>;

/** What the workflow hands to the human when it suspends. */
export const ApprovalRequest = z.object({
  approvalId: z.string().min(1),
  workflowRunId: z.string().min(1),
  projectId: z.string().min(1),
  kind: ApprovalKind,
  summary: z.string().min(1),
  risk: RiskLevel,
  /** Present for kind="plan". */
  proposedPlan: Plan.nullish(),
  /** Free-form structured context for the reviewer (e.g. a ReviewReport). */
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/**
 * The four human decisions.
 *
 *   approve  - proceed with the payload as-is
 *   edit     - proceed, but with a payload the human modified
 *   reject   - stop; record the reason
 *   feedback - do not proceed; loop back with commentary
 */
export const HumanDecisionKind = z.enum(["approve", "edit", "reject", "feedback"]);
export type HumanDecisionKind = z.infer<typeof HumanDecisionKind>;

export const HumanDecision = z.object({
  /** The approval request this answers. Makes the decision auditable. */
  approvalId: z.string().min(1),
  kind: HumanDecisionKind,
  /** Who decided. Not a model, by construction. */
  decidedBy: z.string().min(1),
  decidedAt: z.string().datetime(),
  /** Required for kind="feedback" and "reject"; optional otherwise. */
  comment: z.string().nullish(),
  /** Only meaningful for kind="edit": the human's revised plan. */
  editedPlan: Plan.nullish(),
})
  .refine((d) => d.kind !== "edit" || d.editedPlan != null, {
    message: 'kind="edit" requires editedPlan',
    path: ["editedPlan"],
  })
  .refine((d) => d.kind !== "feedback" || (d.comment?.trim().length ?? 0) > 0, {
    message: 'kind="feedback" requires a comment',
    path: ["comment"],
  });
export type HumanDecision = z.infer<typeof HumanDecision>;

/**
 * Deterministic approval id.
 *
 * CRITICAL - do not replace this with a random id.
 *
 * When a LangGraph run resumes, the node body RE-EXECUTES from the top up to
 * its `interrupt()` call. Everything before that point must therefore be
 * deterministic. A `crypto.randomUUID()` here mints a different id on replay,
 * so the decision the human just submitted no longer matches the request the
 * node believes it is making, and the run fails on every resume.
 *
 * Deriving the id from (runId, gate, attempt) makes it stable across replays
 * while still being unique per gate and per replan cycle.
 */
export function approvalIdFor(
  runId: string,
  kind: ApprovalKind,
  attempt: number,
): string {
  return `apr_${runId}_${kind}_${attempt}`;
}

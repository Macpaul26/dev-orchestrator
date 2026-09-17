import { z } from "zod";
import { ApprovalRequest } from "./approval.js";

/**
 * The eleven workflow nodes, in order of first visit.
 *
 * Task 014 added `learn` and `next_iteration` after the review gate. The
 * second is the ONLY node with an edge back into the graph (to `inspect`), so
 * "why did we loop" has exactly one place to be answered.
 */
export const WorkflowPhase = z.enum([
  "understand",
  "inspect",
  "plan",
  "approve_plan",
  "implement",
  "verify",
  "review",
  "approve_review",
  "learn",
  "next_iteration",
  "update_state",
]);
export type WorkflowPhase = z.infer<typeof WorkflowPhase>;

export const WORKFLOW_PHASES: readonly WorkflowPhase[] = [
  "understand", "inspect", "plan", "approve_plan", "implement",
  "verify", "review", "approve_review", "learn", "next_iteration", "update_state",
] as const;

export const RunStatus = z.enum([
  "running",
  /** Suspended at an interrupt, waiting for a human. Survives process death. */
  "awaiting_approval",
  "completed",
  "rejected",
  /**
   * Stopped WITHOUT approval and without rejection: the iteration bound was
   * exhausted, or a safety condition refused another iteration. Nothing was
   * approved; a human has to look. Never converted into `completed`.
   */
  "incomplete",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const WorkflowRun = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().nullish(),
  /** LangGraph thread id. The key used to resume this run's checkpoint. */
  threadId: z.string().min(1),
  request: z.string().min(1),
  status: RunStatus,
  phase: WorkflowPhase,
  /** Set while status = awaiting_approval. */
  pendingApprovalId: z.string().nullish(),
  /**
   * The full request the run is suspended on. Stored so a separate process can
   * render it, and so an `edit` decision has a real plan to modify.
   */
  pendingApproval: ApprovalRequest.nullish(),
  startedAt: z.string().datetime(),
  endedAt: z.string().nullish(),
  outcome: z.string().nullish(),

  // ---- Task 014: the loop, visible from the run record ---------------------
  /** Which development iteration the run is in. 1-based. */
  iteration: z.number().int().positive().default(1),
  /** The bound the orchestrator configured. Never from a model. */
  iterationLimit: z.number().int().positive().default(1),
  /** Why the loop stopped, when it has. Closed vocabulary; see domain/iteration.ts. */
  stopReason: z.string().nullish(),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;

export function newRunId(): string {
  return `run_${crypto.randomUUID()}`;
}

import { z } from "zod";
import { ApprovalRequest } from "./approval.js";

/** The nine workflow nodes, in order. */
export const WorkflowPhase = z.enum([
  "understand",
  "inspect",
  "plan",
  "approve_plan",
  "implement",
  "verify",
  "review",
  "approve_review",
  "update_state",
]);
export type WorkflowPhase = z.infer<typeof WorkflowPhase>;

export const WORKFLOW_PHASES: readonly WorkflowPhase[] = [
  "understand", "inspect", "plan", "approve_plan", "implement",
  "verify", "review", "approve_review", "update_state",
] as const;

export const RunStatus = z.enum([
  "running",
  /** Suspended at an interrupt, waiting for a human. Survives process death. */
  "awaiting_approval",
  "completed",
  "rejected",
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
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;

export function newRunId(): string {
  return `run_${crypto.randomUUID()}`;
}

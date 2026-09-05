import { z } from "zod";
import { HumanDecision } from "./approval.js";

/**
 * Task lifecycle.
 *
 * PLANNED -> IN_PROGRESS -> IMPLEMENTED -> REVIEW -> (human) -> APPROVED
 *                                                            -> REJECTED
 */
export const TaskStatus = z.enum([
  "PLANNED",
  "IN_PROGRESS",
  "IMPLEMENTED",
  "REVIEW",
  "APPROVED",
  "REJECTED",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  brief: z.string().default(""),
  status: TaskStatus.default("PLANNED"),
  milestoneId: z.string().nullish(),
  /** WorkflowRun ids that have operated on this task. */
  runIds: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof Task>;

/**
 * THE CRITICAL INVARIANT.
 *
 * This table is the complete set of transitions the MACHINE may perform on its
 * own. REVIEW maps to the empty set: the workflow can drive a task all the way
 * to REVIEW and then it stops. There is no machine edge out of REVIEW.
 *
 * APPROVED and REJECTED are absent from every right-hand side, so no sequence
 * of machine transitions can reach them. They are reachable only through
 * `applyHumanDecision`, which demands a validated HumanDecision carrying an
 * approvalId and a human identity.
 */
const MACHINE_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PLANNED: ["IN_PROGRESS"],
  IN_PROGRESS: ["IMPLEMENTED"],
  IMPLEMENTED: ["REVIEW"],
  REVIEW: [], // terminal for the machine - human decision required
  APPROVED: [],
  REJECTED: [],
};

/** Statuses no automatic path may ever produce. */
export const HUMAN_ONLY_STATUSES: readonly TaskStatus[] = ["APPROVED", "REJECTED"];

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolation";
  }
}

export function canMachineTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (HUMAN_ONLY_STATUSES.includes(to)) return false;
  return MACHINE_TRANSITIONS[from].includes(to);
}

/**
 * Advance a task automatically. Throws rather than silently refusing, so a bug
 * that tries to auto-approve fails loudly in tests and in production.
 */
export function machineTransition(task: Task, to: TaskStatus): Task {
  if (HUMAN_ONLY_STATUSES.includes(to)) {
    throw new InvariantViolation(
      `"${to}" requires an explicit human decision and cannot be reached automatically. ` +
        `Use applyHumanDecision().`,
    );
  }
  if (!canMachineTransition(task.status, to)) {
    throw new InvariantViolation(
      `Illegal machine transition ${task.status} -> ${to}.`,
    );
  }
  return { ...task, status: to, updatedAt: new Date().toISOString() };
}

/**
 * The ONLY way a task reaches APPROVED or REJECTED.
 *
 * Requires a HumanDecision, which carries the approvalId it answers and the
 * identity of the person who made it - so every terminal status is auditable
 * back to a specific human answering a specific request.
 */
export function applyHumanDecision(task: Task, decision: HumanDecision): Task {
  HumanDecision.parse(decision);

  if (task.status !== "REVIEW") {
    throw new InvariantViolation(
      `A human decision may only finalise a task in REVIEW (task is ${task.status}).`,
    );
  }

  const status: TaskStatus =
    decision.kind === "approve" ? "APPROVED"
    : decision.kind === "reject" ? "REJECTED"
    : task.status; // edit / feedback send work back; they do not finalise

  return { ...task, status, updatedAt: new Date().toISOString() };
}

import { z } from "zod";
import { Capability } from "./capability.js";
import { ActivityErrorCategory } from "./activity.js";

/**
 * THE IMPLEMENTATION RUN RECORD
 *
 * Durable lifecycle state for one bounded implementation. Written before any
 * mutation and updated as the run progresses, so a process that dies mid-write
 * leaves behind a record that says so.
 *
 * ---------------------------------------------------------------------------
 * WHY `interrupted` EXISTS
 * ---------------------------------------------------------------------------
 * The obvious state set - running, cancelled, failed, completed - has a hole. A
 * process killed while `running` never gets to write anything else, so the
 * record still says `running` forever, and any code that treats "not failed" as
 * "fine" will treat a half-finished mutation as fine.
 *
 * `interrupted` is what a `running` record becomes when a later process finds it
 * with no live owner. It is explicitly NOT `completed` and explicitly NOT
 * `failed`: we do not know what the dead process managed to write. The only
 * honest response is to say so and re-inspect the repository.
 *
 * ---------------------------------------------------------------------------
 * NO ROLLBACK IS CLAIMED
 * ---------------------------------------------------------------------------
 * Nothing here undoes anything. A cancelled or interrupted run may have made
 * partial changes, and `partialChangesPossible` says so. What follows every
 * terminal state - including cancellation - is independent inspection of the
 * real repository. The record is a claim about the RUN; the repository is the
 * claim about the FILES.
 */
export const ImplementationStatus = z.enum([
  "not_started",
  "running",
  "cancel_requested",
  "cancelled",
  "failed",
  /** Owner process vanished. State unknown - never treat as success. */
  "interrupted",
  "completed",
]);
export type ImplementationStatus = z.infer<typeof ImplementationStatus>;

export const TERMINAL_IMPLEMENTATION_STATUSES: readonly ImplementationStatus[] = [
  "cancelled", "failed", "interrupted", "completed",
] as const;

/** Statuses after which the repository may hold half-finished work. */
export const PARTIAL_CHANGE_STATUSES: readonly ImplementationStatus[] = [
  "cancel_requested", "cancelled", "failed", "interrupted",
] as const;

export const ImplementationRun = z.object({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  grantId: z.string().nullable().default(null),
  /** Which agent ran. A label for the audit trail, not a trust signal. */
  agent: z.string().default("none"),
  capabilities: z.array(Capability).default([]),
  allowedScope: z.array(z.string()).default([]),

  status: ImplementationStatus,
  /** Owner process, so a later process can tell a crash from progress. */
  pid: z.number().int().nonnegative().nullable().default(null),
  hostname: z.string().nullable().default(null),

  startedAt: z.string().datetime().nullable().default(null),
  endedAt: z.string().datetime().nullable().default(null),

  /** Counted by the orchestrator as it performed them - not agent-reported. */
  writes: z.number().int().nonnegative().default(0),
  deletes: z.number().int().nonnegative().default(0),
  denials: z.number().int().nonnegative().default(0),

  /**
   * True whenever the repository might hold half-finished work.
   *
   * The signal that verification is mandatory rather than optional. Never set
   * false on any path that did not run to completion.
   */
  partialChangesPossible: z.boolean().default(false),

  cancelRequestedBy: z.string().nullable().default(null),
  cancelRequestedAt: z.string().datetime().nullable().default(null),

  failureCategory: ActivityErrorCategory.nullable().default(null),
  /** Short and non-disclosing. Never a buffer, never file content. */
  failureDetail: z.string().nullable().default(null),
});
export type ImplementationRun = z.infer<typeof ImplementationRun>;

/**
 * The agent's own account of what it did. UNTRUSTED, like `claimed*`.
 *
 * Kept structurally separate from `ImplementationRun` so the two can never be
 * confused: the run record is what the ORCHESTRATOR observed itself doing, this
 * is what the AGENT says. Nothing here is evidence of anything.
 */
export const AgentReport = z.object({
  summary: z.string().default(""),
  /** Paths the agent believes it changed. Checked against git, never believed. */
  files: z.array(z.string()).default([]),
  /** The agent's own success claim. Does not decide the run's status. */
  claimsSuccess: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
});
export type AgentReport = z.infer<typeof AgentReport>;

export function isTerminal(status: ImplementationStatus): boolean {
  return TERMINAL_IMPLEMENTATION_STATUSES.includes(status);
}

export function mayHavePartialChanges(status: ImplementationStatus): boolean {
  return PARTIAL_CHANGE_STATUSES.includes(status);
}

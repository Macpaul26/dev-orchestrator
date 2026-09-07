import { z } from "zod";
import { RiskLevel } from "../domain/risk.js";
import { WorkflowPhase } from "../domain/workflow.js";

/**
 * Structured orchestrator events.
 *
 * The terminal renderer and the JSONL history are both sinks over this one
 * union, so what you read on screen and what is on disk cannot diverge.
 *
 * NOTHING HERE MAY CARRY A SECRET. Events are written to disk unencrypted.
 */
export const OrchestratorEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("workflow_started"),
    runId: z.string(), projectId: z.string(), request: z.string(), at: z.string(),
  }),
  z.object({
    type: z.literal("node_started"),
    runId: z.string(), node: WorkflowPhase, at: z.string(),
  }),
  z.object({
    type: z.literal("node_completed"),
    runId: z.string(), node: WorkflowPhase, at: z.string(),
  }),
  z.object({
    type: z.literal("approval_requested"),
    runId: z.string(), approvalId: z.string(), kind: z.string(),
    risk: RiskLevel, summary: z.string(), at: z.string(),
  }),
  z.object({
    type: z.literal("approval_received"),
    runId: z.string(), approvalId: z.string(), decision: z.string(),
    decidedBy: z.string(), at: z.string(),
  }),
  z.object({
    type: z.literal("workflow_interrupted"),
    runId: z.string(), phase: WorkflowPhase, approvalId: z.string(), at: z.string(),
  }),
  z.object({
    type: z.literal("workflow_resumed"),
    runId: z.string(), phase: WorkflowPhase, pid: z.number(), at: z.string(),
  }),
  /**
   * A completed read-only inspection. Carries COUNTS and identifiers only -
   * never file contents, never diff text - because this line is appended to an
   * unencrypted JSONL file that lives for the life of the project.
   */
  z.object({
    type: z.literal("repository_inspected"),
    runId: z.string(), node: WorkflowPhase,
    branch: z.string().nullable(), headCommit: z.string().nullable(),
    clean: z.boolean(), changedFileCount: z.number().int().nonnegative(),
    at: z.string(),
  }),
  /** Inspection could not be completed. Recorded so it can never look clean. */
  z.object({
    type: z.literal("repository_inspection_failed"),
    runId: z.string(), node: WorkflowPhase,
    code: z.string(), reason: z.string(), at: z.string(),
  }),
  z.object({
    type: z.literal("verification_completed"),
    runId: z.string(), verifiedIndependently: z.boolean(),
    observedFileCount: z.number().int().nonnegative(),
    observedCommitCount: z.number().int().nonnegative(),
    scopeDriftCount: z.number().int().nonnegative(),
    at: z.string(),
  }),
  /**
   * One reasoning call happened. METADATA ONLY.
   *
   * No prompt, no response, no credential - this lands in the durable event
   * history, and a reasoning prompt carries project text while a response is
   * untrusted model output. Neither belongs in an audit trail. What is recorded
   * is that a call was made, to which model, and whether a VALIDATED proposal
   * came back.
   */
  z.object({
    type: z.literal("reasoning_completed"),
    runId: z.string(), node: z.string(),
    provider: z.string(), model: z.string(),
    ok: z.boolean(), failureCode: z.string().nullable(),
    durationMs: z.number().nonnegative(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("workflow_completed"),
    runId: z.string(), outcome: z.string(), at: z.string(),
  }),
  z.object({
    type: z.literal("workflow_failed"),
    runId: z.string(), reason: z.string(), at: z.string(),
  }),
]);
export type OrchestratorEvent = z.infer<typeof OrchestratorEvent>;

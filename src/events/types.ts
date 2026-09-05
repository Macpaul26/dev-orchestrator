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

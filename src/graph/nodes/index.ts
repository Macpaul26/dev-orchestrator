import { interrupt } from "@langchain/langgraph";
import {
  ApprovalRequest,
  HumanDecision,
  Plan,
  approvalIdFor,
  type Plan as TPlan,
  type HumanDecision as THumanDecision,
} from "../../domain/approval.js";
import { ImplementationReport, ReviewReport } from "../../domain/reports.js";
import type { OrchestratorStateType, OrchestratorUpdate } from "../state.js";
import type { NodeContext } from "../context.js";
import { now } from "../../events/log.js";

/**
 * The nine workflow nodes.
 *
 * PHASE 1+2 SCOPE: every node except the two approval gates is a deterministic
 * stub. There are no model calls, no coding agent, and no repository writes.
 * What is real here is the graph, the state flow, the checkpointing, and the
 * human-in-the-loop interrupts - which is exactly what this phase exists to
 * prove.
 */

// 1 ---------------------------------------------------------------- understand
export const understand = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "understand", at: now() });
    // Deterministic stand-in for model-based intent classification (later phase).
    const intent = state.request.trim().length > 0 ? "development_request" : "empty_request";
    ctx.emit({ type: "node_completed", runId: state.runId, node: "understand", at: now() });
    return { intent, phase: "inspect" };
  };

// 2 ------------------------------------------------------------------- inspect
export const inspect = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "inspect", at: now() });

    // Read-only, and only metadata the project store already holds. No
    // repository reads and no shell in this phase.
    const project = ctx.store.getProject(state.projectId);
    const observations = project
      ? [
          `project: ${project.name} (${project.id})`,
          `workingDir: ${project.workingDir}`,
          `checks declared: ${project.checks.length}`,
          `constraints: ${project.constraints.length}`,
        ]
      : [`project ${state.projectId} not found in store`];

    ctx.emit({ type: "node_completed", runId: state.runId, node: "inspect", at: now() });
    return { observations, phase: "plan" };
  };

// 3 ---------------------------------------------------------------------- plan
export const plan = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "plan", at: now() });

    // Deterministic placeholder plan. A later phase replaces this with a model
    // call; the shape it must produce is fixed here.
    const proposed: TPlan = Plan.parse({
      summary: `Plan for: ${state.request}`,
      steps: [
        { order: 0, description: "Inspect the affected area (read-only)", risk: "LOW" },
        { order: 1, description: "Apply the requested change", risk: "HIGH" },
        { order: 2, description: "Run project verification checks", risk: "LOW" },
      ],
      allowedScope: [],
      risks: ["Phase 1+2 stub plan - no implementation capability exists yet"],
      highestRisk: "HIGH",
    });

    ctx.emit({ type: "node_completed", runId: state.runId, node: "plan", at: now() });
    return { proposedPlan: proposed, phase: "approve_plan" };
  };

// 4 -------------------------------------------------------------- approve_plan
/**
 * FIRST HUMAN GATE - a real LangGraph interrupt.
 *
 * `interrupt()` throws a GraphInterrupt that the runtime catches after writing
 * a checkpoint. The process may then exit; the run resumes from the checkpoint
 * when `Command({ resume })` is supplied, and the resume value becomes the
 * return value of this call.
 */
export const approvePlan = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "approve_plan", at: now() });

    const request = ApprovalRequest.parse({
      // Deterministic: this node body replays on resume. See approvalIdFor.
      approvalId: approvalIdFor(state.runId, "plan", state.revisions),
      workflowRunId: state.runId,
      projectId: state.projectId,
      kind: "plan",
      summary: state.proposedPlan?.summary ?? "(no plan)",
      risk: state.proposedPlan?.highestRisk ?? "LOW",
      proposedPlan: state.proposedPlan,
      payload: {},
      createdAt: now(),
    });

    ctx.onApprovalRequested(request);

    // ---- execution suspends here; the process may die ----
    const raw = interrupt(request);
    // ---- execution resumes here, in a possibly different process ----

    const decision: THumanDecision = HumanDecision.parse(raw);
    if (decision.approvalId !== request.approvalId) {
      throw new Error(
        `Decision answers approval ${decision.approvalId}, but ${request.approvalId} was requested.`,
      );
    }
    ctx.onApprovalReceived(decision);

    if (decision.kind === "reject") {
      return {
        decisions: [decision], pendingApprovalId: null,
        phase: "update_state", outcome: "rejected_at_plan",
      };
    }
    if (decision.kind === "feedback") {
      // Loop back and replan with the human's commentary recorded.
      return {
        decisions: [decision], pendingApprovalId: null,
        phase: "plan", revisions: state.revisions + 1,
      };
    }
    // approve, or edit (which substitutes the human's revised plan)
    return {
      decisions: [decision],
      proposedPlan: decision.kind === "edit" ? decision.editedPlan! : state.proposedPlan,
      pendingApprovalId: null,
      phase: "implement",
    };
  };

// 5 ----------------------------------------------------------------- implement
export const implement = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "implement", at: now() });

    // NO CODING AGENT IN THIS PHASE. The report is created with claimed* empty
    // and observed* empty, and explicitly NOT verified independently.
    const report = ImplementationReport.parse({
      runId: state.runId,
      claimedSummary: "",
      claimedFiles: [],
      observedDiff: null,
      observedFiles: [],
      observedCommits: [],
      sessionId: null,
      turns: 0,
      verifiedIndependently: false,
      createdAt: now(),
    });

    ctx.emit({ type: "node_completed", runId: state.runId, node: "implement", at: now() });
    return { implementation: report, phase: "verify" };
  };

// 6 -------------------------------------------------------------------- verify
export const verify = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "verify", at: now() });
    // Independent git inspection and check execution belong to a later phase.
    ctx.emit({ type: "node_completed", runId: state.runId, node: "verify", at: now() });
    return { phase: "review" };
  };

// 7 -------------------------------------------------------------------- review
export const review = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "review", at: now() });

    const report = ReviewReport.parse({
      runId: state.runId,
      verdict: "pass",
      findings: [
        {
          severity: "info",
          message:
            "Phase 1+2 walking graph: no implementation was performed and no checks were run.",
        },
      ],
      checkResults: [],
      scopeDrift: [],
      createdAt: now(),
    });

    ctx.emit({ type: "node_completed", runId: state.runId, node: "review", at: now() });
    return { reviewReport: report, phase: "approve_review" };
  };

// 8 ------------------------------------------------------------ approve_review
/**
 * SECOND HUMAN GATE.
 *
 * This is the gate that guards the APPROVED status. The graph can carry a task
 * to REVIEW on its own; only the decision returned here can finalise it, and
 * `applyHumanDecision` in domain/task.ts refuses to act without it.
 */
export const approveReview = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "approve_review", at: now() });

    const request = ApprovalRequest.parse({
      approvalId: approvalIdFor(state.runId, "review", state.revisions),
      workflowRunId: state.runId,
      projectId: state.projectId,
      kind: "review",
      summary: `Review verdict: ${state.reviewReport?.verdict ?? "unknown"}`,
      risk: "HIGH",
      proposedPlan: null,
      payload: { review: state.reviewReport ?? {} },
      createdAt: now(),
    });

    ctx.onApprovalRequested(request);
    const decision: THumanDecision = HumanDecision.parse(interrupt(request));

    if (decision.approvalId !== request.approvalId) {
      throw new Error(
        `Decision answers approval ${decision.approvalId}, but ${request.approvalId} was requested.`,
      );
    }
    ctx.onApprovalReceived(decision);

    const outcome =
      decision.kind === "approve" ? "approved"
      : decision.kind === "reject" ? "rejected_at_review"
      : "changes_requested";

    return {
      decisions: [decision], pendingApprovalId: null,
      phase: "update_state", outcome,
    };
  };

// 9 -------------------------------------------------------------- update_state
export const updateState = (ctx: NodeContext) =>
  async (state: OrchestratorStateType): Promise<OrchestratorUpdate> => {
    ctx.emit({ type: "node_started", runId: state.runId, node: "update_state", at: now() });
    ctx.onFinalise(state);
    ctx.emit({ type: "node_completed", runId: state.runId, node: "update_state", at: now() });
    return { phase: "update_state", outcome: state.outcome ?? "completed" };
  };

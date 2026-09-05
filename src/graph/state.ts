import { Annotation } from "@langchain/langgraph";
import type { Plan, HumanDecision } from "../domain/approval.js";
import type { ImplementationReport, ReviewReport } from "../domain/reports.js";
import type { WorkflowPhase } from "../domain/workflow.js";

/**
 * The workflow state channels.
 *
 * This object is serialised into the SQLite checkpoint on every superstep, so
 * two rules apply:
 *   1. Everything here must be JSON-serialisable.
 *   2. NOTHING HERE MAY BE A SECRET. No API keys, no tokens, no credentials.
 *      Secrets are read from the environment at the edge and never enter state.
 */
export const OrchestratorState = Annotation.Root({
  // ---- identity (set once at start) ---------------------------------------
  runId: Annotation<string>(),
  projectId: Annotation<string>(),
  request: Annotation<string>(),

  // ---- understand ---------------------------------------------------------
  intent: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),

  // ---- inspect ------------------------------------------------------------
  /** Read-only observations. Phase 1+2 records project metadata only. */
  observations: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // ---- plan / approval ----------------------------------------------------
  /**
   * NOTE: named `proposedPlan`, not `plan`. LangGraph forbids a state channel
   * sharing a name with a node, and `plan` is a node. Same for `reviewReport`.
   */
  proposedPlan: Annotation<Plan | null>({ reducer: (_p, n) => n, default: () => null }),
  pendingApprovalId: Annotation<string | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /** Every human decision this run has received. Append-only audit trail. */
  decisions: Annotation<HumanDecision[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // ---- implement / verify / review ----------------------------------------
  implementation: Annotation<ImplementationReport | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  reviewReport: Annotation<ReviewReport | null>({
    reducer: (_p, n) => n, default: () => null,
  }),

  // ---- control ------------------------------------------------------------
  phase: Annotation<WorkflowPhase>({
    reducer: (_p, n) => n, default: () => "understand" as WorkflowPhase,
  }),
  /** Terminal outcome, set by update_state or a rejection path. */
  outcome: Annotation<string | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /** Number of times the plan has been revised after feedback. */
  revisions: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
});

export type OrchestratorStateType = typeof OrchestratorState.State;
export type OrchestratorUpdate = typeof OrchestratorState.Update;

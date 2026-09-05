import { StateGraph, START, END } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { OrchestratorState, type OrchestratorStateType } from "./state.js";
import type { NodeContext } from "./context.js";
import * as nodes from "./nodes/index.js";

/**
 * The nine-node orchestrator workflow.
 *
 *   understand -> inspect -> plan -> approve_plan
 *                             ^          |
 *                             |          | (feedback loops back)
 *                             +----------+
 *                                        |
 *              approve_plan -> implement -> verify -> review -> approve_review
 *                     |                                              |
 *                     +------------- update_state <------------------+
 *                          (rejection short-circuits here)
 *
 * Control flow is explicit and owned by this file. There is no LangChain agent,
 * chain or executor anywhere in the system - every edge below is one we wrote.
 */
export function buildWorkflow(ctx: NodeContext, checkpointer: BaseCheckpointSaver) {
  const builder = new StateGraph(OrchestratorState)
    .addNode("understand", nodes.understand(ctx))
    .addNode("inspect", nodes.inspect(ctx))
    .addNode("plan", nodes.plan(ctx))
    .addNode("approve_plan", nodes.approvePlan(ctx))
    .addNode("implement", nodes.implement(ctx))
    .addNode("verify", nodes.verify(ctx))
    .addNode("review", nodes.review(ctx))
    .addNode("approve_review", nodes.approveReview(ctx))
    .addNode("update_state", nodes.updateState(ctx))

    .addEdge(START, "understand")
    .addEdge("understand", "inspect")
    .addEdge("inspect", "plan")
    .addEdge("plan", "approve_plan")

    // After the plan gate: proceed, replan on feedback, or short-circuit.
    .addConditionalEdges(
      "approve_plan",
      (s: OrchestratorStateType) =>
        s.phase === "plan" ? "plan"
        : s.phase === "update_state" ? "update_state"
        : "implement",
      { plan: "plan", implement: "implement", update_state: "update_state" },
    )

    .addEdge("implement", "verify")
    .addEdge("verify", "review")
    .addEdge("review", "approve_review")
    .addEdge("approve_review", "update_state")
    .addEdge("update_state", END);

  return builder.compile({ checkpointer });
}

export type OrchestratorGraph = ReturnType<typeof buildWorkflow>;

import { StateGraph, START, END } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { OrchestratorState, type OrchestratorStateType } from "./state.js";
import type { NodeContext } from "./context.js";
import * as nodes from "./nodes/index.js";

/**
 * The eleven-node orchestrator workflow.
 *
 *   understand -> inspect -> plan -> approve_plan
 *                   ^         ^          |
 *                   |         |          | (feedback loops back to plan)
 *                   |         +----------+
 *                   |                    |
 *                   |    approve_plan -> implement -> verify -> review
 *                   |           |                                 |
 *                   |           |                          approve_review
 *                   |           |                                 |
 *                   |           |                               learn
 *                   |           |                                 |
 *                   |           |                          next_iteration
 *                   |           |                            |         |
 *                   +-----------|---- new_iteration ---------+         | stop
 *                               |                                      |
 *                               +--------> update_state <--------------+
 *                                  (rejection short-circuits here)
 *
 * TASK 014. The graph can now go round. The ONLY edge back into the graph is
 * `next_iteration -> inspect`, named `new_iteration` below, and it is taken
 * only when a human asked for changes at the review gate, verification
 * observed no safety condition, and the iteration bound is not exhausted. From
 * `inspect` the graph runs `plan -> approve_plan` exactly as on the first
 * pass: `plan -> approve_plan` is UNCONDITIONAL, so a new iteration cannot
 * reach `implement` without a fresh human approval of its own plan.
 *
 * There is no edge from `next_iteration` to `implement`, `verify`, `review`
 * or `approve_review`. There is no edge into `update_state` that carries an
 * "approved" outcome except by way of `approve_review`'s human decision. The
 * loop is in this file, where it can be read, not inside a node.
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
    .addNode("learn", nodes.learn(ctx))
    .addNode("next_iteration", nodes.nextIteration(ctx))
    .addNode("update_state", nodes.updateState(ctx))

    .addEdge(START, "understand")
    .addEdge("understand", "inspect")
    .addEdge("inspect", "plan")
    // UNCONDITIONAL. A plan - first or fifth - always meets the human gate.
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
    // Every review decision passes through learn and the loop decision.
    .addEdge("approve_review", "learn")
    .addEdge("learn", "next_iteration")

    // THE LOOP. One named edge back to inspect; one named edge to the end.
    .addConditionalEdges(
      "next_iteration",
      (s: OrchestratorStateType) => (s.phase === "inspect" ? "new_iteration" : "stop"),
      { new_iteration: "inspect", stop: "update_state" },
    )

    .addEdge("update_state", END);

  return builder.compile({ checkpointer });
}

export type OrchestratorGraph = ReturnType<typeof buildWorkflow>;

/**
 * The topology, as data, for tests and for humans.
 *
 * Asserted by a test against the compiled graph so the picture above and the
 * edges below cannot drift from what actually runs. The loop edge is listed
 * exactly once.
 */
export const WORKFLOW_EDGES: readonly (readonly [string, string])[] = [
  ["__start__", "understand"],
  ["understand", "inspect"],
  ["inspect", "plan"],
  ["plan", "approve_plan"],
  ["approve_plan", "plan"],
  ["approve_plan", "implement"],
  ["approve_plan", "update_state"],
  ["implement", "verify"],
  ["verify", "review"],
  ["review", "approve_review"],
  ["approve_review", "learn"],
  ["learn", "next_iteration"],
  ["next_iteration", "inspect"],
  ["next_iteration", "update_state"],
  ["update_state", "__end__"],
] as const;

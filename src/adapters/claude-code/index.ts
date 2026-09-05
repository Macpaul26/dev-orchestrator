import type { Plan } from "../../domain/approval.js";
import type { ImplementationReport } from "../../domain/reports.js";

/**
 * Boundary for the coding agent. INTENTIONALLY UNIMPLEMENTED IN PHASE 1+2.
 *
 * The implementation will use `@anthropic-ai/claude-agent-sdk` (Claude Code as
 * a library - not the API Tool Runner, which is a different package with no
 * filesystem access). The interface is declared now so the graph's `implement`
 * node has a shape to depend on, and so this phase provably contains no path
 * that can execute a coding agent.
 */
export interface CodingAgent {
  /**
   * Execute an APPROVED plan inside `workingDir`.
   *
   * The returned report must leave every `observed*` field empty: populating
   * those is the orchestrator's job, using its own git inspection. The agent
   * fills only `claimed*`.
   */
  implement(input: {
    plan: Plan;
    workingDir: string;
    runId: string;
    maxTurns: number;
    signal: AbortSignal;
  }): Promise<ImplementationReport>;
}

export class NotImplementedCodingAgent implements CodingAgent {
  async implement(): Promise<ImplementationReport> {
    throw new Error(
      "No coding agent is available. Claude Code integration is a later phase.",
    );
  }
}

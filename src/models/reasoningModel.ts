import type {
  ReasoningProposal, ReasoningFailure, ReasoningRecord,
} from "../domain/reasoning.js";

/**
 * THE REASONING MODEL SEAM
 *
 * One narrow interface, so nothing in the orchestrator depends on a vendor SDK.
 * The graph asks for a proposal and gets back either a validated proposal or a
 * typed failure - it never sees an HTTP client, a message array, a token, or a
 * provider-specific error.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE IS THE SECURITY ARGUMENT
 * ---------------------------------------------------------------------------
 * `generate` returns DATA. It cannot return an action, because there is no type
 * here that expresses one: no tool call, no capability, no approval, no command.
 * A provider that wanted to grant itself something would have nowhere to put it.
 *
 * This is why the interface has one method. A second method returning anything
 * executable - `callTool`, `run`, `decide` - would be the moment the model
 * stopped being a proposal generator, and it would be visible in this file.
 */

export interface ReasoningContext {
  /** UNTRUSTED. What the human typed. */
  request: string;
  /** UNTRUSTED. Project name and description, for orientation. */
  projectName: string;
  /**
   * UNTRUSTED. Repository facts the orchestrator observed itself.
   *
   * Observations, not file contents: branch, head, whether the tree is clean,
   * a bounded list of changed paths. Enough to reason about, small enough not
   * to become a channel for bulk project text.
   */
  observations: readonly string[];
  /** UNTRUSTED. Durable project constraints a human wrote. */
  constraints: readonly string[];
}

export interface ReasoningRequest {
  runId: string;
  operation: "propose_plan";
  context: ReasoningContext;
  /** Aborts the request. Wired to the run's existing cancellation. */
  signal?: AbortSignal;
}

/**
 * Success carries a VALIDATED proposal; failure carries a typed reason.
 *
 * A discriminated union rather than a nullable proposal, so a caller cannot
 * reach the data without first acknowledging that it might not be there. There
 * is no shape in which "the call failed" reads as an empty success.
 */
export type ReasoningResult =
  | { ok: true; proposal: ReasoningProposal; record: ReasoningRecord }
  | { ok: false; failure: ReasoningFailure; record: ReasoningRecord };

export interface ReasoningModel {
  /** For provenance. Not a trust signal. */
  readonly provider: string;
  readonly model: string;
  generate(request: ReasoningRequest): Promise<ReasoningResult>;
}

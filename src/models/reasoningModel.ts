import type {
  ReasoningProposal, ReasoningFailure, ReasoningRecord,
} from "../domain/reasoning.js";
import type { AssembledContext } from "../domain/reasoningContext.js";

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
  /**
   * The assembled, bounded, provenance-labelled context (Task 007).
   *
   * Replaces the four loose fields this interface used to carry. That shape
   * flattened a human decision and a repository observation into
   * indistinguishable prose, and it had no bounds of its own - both of which
   * are now the assembler's job. See reasoning/context.ts.
   *
   * Still UNTRUSTED as INPUT: the labels tell the model and the human where
   * each fact came from; they do not make the model believe them.
   */
  assembled: AssembledContext;
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

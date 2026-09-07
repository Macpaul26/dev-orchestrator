import { Annotation } from "@langchain/langgraph";
import type { Plan, HumanDecision } from "../domain/approval.js";
import type { ImplementationReport, ReviewReport, CheckResult } from "../domain/reports.js";
import type { RepositoryEvidence, InspectionFailure } from "../domain/repository.js";
import type { ReviewEvidence } from "../domain/evidence.js";
import type { ImplementationGrant } from "../domain/grant.js";
import type { ImplementationRun } from "../domain/implementation.js";
import type { VerificationOutcome } from "../domain/verification.js";
import type { VerificationCheckRun } from "../domain/verificationCheck.js";
import type { CheckPolicy } from "../verification/checkPolicy.js";
import type { ReasoningRecord, ReasoningFailure } from "../domain/reasoning.js";
import type { ContextSummary } from "../domain/reasoningContext.js";
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
  /** Human-readable observation lines, appended as the run progresses. */
  observations: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  /**
   * The PRE-IMPLEMENTATION repository snapshot, from `inspect`.
   *
   * Named `repository`, not `inspect` - LangGraph forbids a channel sharing a
   * node's name. This is the baseline `verify` measures against: without it, a
   * repository that was already dirty would read as work this run performed.
   */
  repository: Annotation<RepositoryEvidence | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /** Set when inspection could not be completed. Never silently absent. */
  inspectionFailure: Annotation<InspectionFailure | null>({
    reducer: (_p, n) => n, default: () => null,
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

  // ---- implementation authorisation ---------------------------------------
  /**
   * The grant minted when a human approved the plan.
   *
   * Null until then, and null again on any path that did not reach approval.
   * There is no other way for the implement node to obtain write capability -
   * no flag, no environment variable, no default.
   */
  grant: Annotation<ImplementationGrant | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /** UNTRUSTED: did the agent assert success? Recorded, never acted on. */
  agentClaimedSuccess: Annotation<boolean>({
    reducer: (_p, n) => n, default: () => false,
  }),
  /** What the orchestrator observed itself doing. Not the agent's account. */
  implementationRun: Annotation<ImplementationRun | null>({
    reducer: (_p, n) => n, default: () => null,
  }),

  // ---- implement / verify / review ----------------------------------------
  implementation: Annotation<ImplementationReport | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  reviewReport: Annotation<ReviewReport | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /**
   * The four-part verification outcome: process, claim, observation, verdict.
   *
   * Produced by `verify` after EVERY attempt - success, failure, crash or
   * cancellation - because "the agent failed" is not evidence that the
   * repository is untouched.
   */
  verification: Annotation<VerificationOutcome | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /** Deterministic claimed-vs-observed evidence produced by `verify`. */
  reviewEvidence: Annotation<ReviewEvidence | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /**
   * Results for the project's declared checks.
   *
   * Every entry carries `executed: false` in this phase - check execution is
   * disabled. The channel exists so a skipped check is recorded explicitly
   * rather than being absent and looking like it was never declared.
   */
  /**
   * The check policy captured BEFORE the untrusted implementation runs.
   *
   * Held in workflow state, not re-read from disk at execution time, because
   * the agent can write to disk in between. The fingerprint travels with it so
   * a mid-run rewrite is detectable rather than executable.
   */
  /**
   * Provenance for the reasoning call. METADATA ONLY.
   *
   * No prompt, no raw response, no credential - this goes into a SQLite
   * checkpoint, and none of those belong there. See domain/reasoning.ts.
   */
  reasoning: Annotation<ReasoningRecord | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /** Why reasoning did not produce a plan. Fail-closed evidence, not a plan. */
  reasoningFailure: Annotation<ReasoningFailure | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /**
   * A BOUNDED SUMMARY of the assembled reasoning context.
   *
   * Counts and warnings, never the context itself. The records are derived from
   * things the store already holds, so copying them into a checkpoint would
   * duplicate project text into a second place with a different lifetime - and
   * would make the checkpoint grow with the project.
   */
  contextSummary: Annotation<ContextSummary | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /** Model-proposed paths trusted code refused, and why. Shown to the human. */
  reasoningNotes: Annotation<string[]>({
    reducer: (_p, n) => n, default: () => [],
  }),
  checkPolicy: Annotation<CheckPolicy | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  /** What the controlled check phase actually did. Observation, never claim. */
  checkRun: Annotation<VerificationCheckRun | null>({
    reducer: (_p, n) => n, default: () => null,
  }),
  checkResults: Annotation<CheckResult[]>({
    reducer: (_p, n) => n, default: () => [],
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

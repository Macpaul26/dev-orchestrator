import type { ProjectStore } from "../projects/projectStore.js";
import type { OrchestratorEvent } from "../events/types.js";
import type { ApprovalRequest, HumanDecision } from "../domain/approval.js";
import type { OrchestratorStateType } from "./state.js";
import type { RepositoryInspector } from "../domain/inspector.js";
import type { CheckRunner } from "../verification/checks.js";
import type { VerificationCheckPhase } from "../verification/checkPhase.js";
import type { ImplementationAgent } from "../implementation/runner.js";

/**
 * Side-effect surface available to nodes.
 *
 * Nodes never touch the filesystem, the event log or the project store
 * directly - they call through this, so the graph stays testable with a fake
 * context and side effects stay enumerable in one place.
 */
export interface NodeContext {
  store: ProjectStore;
  /**
   * Read-only view of the project's repository, or null when the project has
   * no inspectable working directory. Nodes depend on this INTERFACE, never on
   * git - which is what keeps command construction out of the graph.
   */
  inspector: RepositoryInspector | null;
  /** LEGACY string-command checks. Still disabled; see verification/checks.ts. */
  checkRunner: CheckRunner;
  /**
   * Controlled execution of trusted, predefined verification checks (Task 005).
   *
   * Runs only what the captured policy carried, only with a human-granted
   * `verification.execute`, and is always followed by re-inspecting the
   * repository - a check is executable code and can change files.
   */
  checkPhase: VerificationCheckPhase;
  /**
   * The implementation agent, if one is configured.
   *
   * Null in production: Phase 4A builds the substrate and connects no coding
   * agent to it. Tests supply a deterministic fake to exercise the boundary.
   * A null agent means the implement node writes nothing at all.
   */
  agent: ImplementationAgent | null;
  emit(event: OrchestratorEvent): void;
  onApprovalRequested(request: ApprovalRequest): void;
  onApprovalReceived(decision: HumanDecision): void;
  onFinalise(state: OrchestratorStateType): void;
}

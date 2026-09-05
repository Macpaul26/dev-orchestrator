import type { ProjectStore } from "../projects/projectStore.js";
import type { OrchestratorEvent } from "../events/types.js";
import type { ApprovalRequest, HumanDecision } from "../domain/approval.js";
import type { OrchestratorStateType } from "./state.js";

/**
 * Side-effect surface available to nodes.
 *
 * Nodes never touch the filesystem, the event log or the project store
 * directly - they call through this, so the graph stays testable with a fake
 * context and side effects stay enumerable in one place.
 */
export interface NodeContext {
  store: ProjectStore;
  emit(event: OrchestratorEvent): void;
  onApprovalRequested(request: ApprovalRequest): void;
  onApprovalReceived(decision: HumanDecision): void;
  onFinalise(state: OrchestratorStateType): void;
}
